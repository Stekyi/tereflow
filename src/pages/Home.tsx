import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TradeNewsItem } from '../lib/api';
import { useSession } from '../lib/auth';
import { Chips, Empty, Skeletons } from '../components/ui';
import { CountUp, TradeStory } from '../components/TradeStory';
import { BudgetBar } from '../components/BudgetBar';
import { useBudget } from '../lib/budget';
import ProductModal, { ProductCardRow } from '../components/ProductModal';
import { CONTINENTS, type ProductCard, type ProductSummary } from '../../shared/types';

type FlowFilter = 'all' | 'export' | 'import';

/** One big figure in the stats panel. "To sell" and "To supply" rather than "Exports" and "Imports", because the reader is deciding what to do. */
function Stat({ n, k }: { n: number; k: string }) {
  return (
    <div className="mm-stat">
      <strong><CountUp text={n.toLocaleString()} /></strong>
      <span>{k}</span>
    </div>
  );
}

/** Sets the last words of a heading in the accent colour, the way the two-tone titles read. */
function splitHeading(text: string) {
  const words = text.split(' ');
  if (words.length < 3) return text;
  const cut = Math.max(1, Math.ceil(words.length / 2));
  return (
    <>
      {words.slice(0, cut).join(' ')} <em>{words.slice(cut).join(' ')}</em>
    </>
  );
}

/** Fades sections in as they scroll into view. Skipped for reduced motion, and without IntersectionObserver everything just shows. */
function useReveal() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const items = Array.from(root.querySelectorAll<HTMLElement>('[data-reveal]:not(.in)'));
    if (!('IntersectionObserver' in window) || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      items.forEach((el) => el.classList.add('in'));
      return;
    }
    const io = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add('in');
            io.unobserve(e.target);
          }
        }),
      { rootMargin: '0px 0px -8% 0px' },
    );
    items.forEach((el) => io.observe(el));
    return () => io.disconnect();
  });
  return ref;
}

export default function Home() {
  const { user, entitled, feedUnread } = useSession();
  const revealRef = useReveal();
  const [news, setNews] = useState<TradeNewsItem[]>([]);
  useEffect(() => {
    api
      .tradeNews()
      .then((r) => setNews(r.items.slice(0, 3)))
      .catch(() => setNews([]));
  }, []);
  const [budget, setBudget] = useBudget();
  const [q, setQ] = useState('');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [continent, setContinent] = useState<string>('all');
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [summary, setSummary] = useState<ProductSummary | null>(null);
  // Set when the search reached past the words typed: "solar panel" answered
  // with photovoltaic cells is the right result, but only if it says so.
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [modalHs, setModalHs] = useState<string | null>(null);
  const [modalCountry, setModalCountry] = useState<string | null>(null);
  const [modalFlow, setModalFlow] = useState<'export' | 'import' | null>(null);
  const openProduct = (hs: string, slug: string, f: 'export' | 'import') => {
    setModalHs(hs);
    setModalCountry(slug);
    setModalFlow(f);
  };

  // Debounced so a search doesn't fire a request on every keystroke.
  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      api
        .products({
          q: q.trim() || undefined,
          flow: flow === 'all' ? undefined : flow,
          continent: continent === 'all' ? undefined : continent,
          budget: budget || undefined,
          limit: 40,
        })
        .then((r) => {
          setProducts(r.products);
          setSummary(r.summary);
          setSearchNote(r.note ?? null);
        })
        .catch(() => {
          setProducts([]);
          setSummary(null);
          setSearchNote(null);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [q, flow, continent, budget]);

  const flowOptions = useMemo(
    () => [
      { value: 'all' as FlowFilter, label: 'All flows' },
      { value: 'export' as FlowFilter, label: 'Exports' },
      { value: 'import' as FlowFilter, label: 'Imports' },
    ],
    [],
  );

  const continentOptions = useMemo(
    () => [
      { value: 'all', label: 'All regions' },
      ...CONTINENTS.filter((c) => c !== 'Global').map((c) => ({ value: c, label: c })),
    ],
    [],
  );

  // The heading has to say what the reader is looking at. A search is its own
  // thing; otherwise it is the ranked list, scoped to whatever filters are set,
  // and it says "worldwide" plainly when nothing is set rather than leaving the
  // reader to assume the filters are hiding something.
  const listHeading = useMemo(() => {    const query = q.trim();
    if (query) return `Results for "${query}"`;
    if (flow === 'all' && continent === 'all') return 'Top opportunities worldwide this week';
    const flowWord = flow === 'all' ? '' : `${flow} `;
    const region = continent === 'all' ? '' : ` in ${continent}`;
    return `Top ${flowWord}opportunities${region} this week`;
  }, [q, flow, continent]);

  return (
    <div ref={revealRef} className="mm-home">
      <section className="mm-hero" aria-label="Find a product worth trading">
        <div className="mm-hero-copy">
          <span className="mm-overline">Global trade intelligence</span>
          <h1>
            Find a product
            <em> worth trading</em>
          </h1>
          <p>
            See who sells it, who buys it, and where the opening is. Ranked by how fast each line is
            moving, across every market Tereflow has analysed.
          </p>
          <div className="mm-cta-row">
            <a className="mm-cta" href="#openings">
              See the openings <span aria-hidden>{'\u2192'}</span>
            </a>
            <Link className="mm-cta ghost" to="/sandbox">
              Open Trade Sandbox
            </Link>
          </div>
          <p className="mm-sources">Built on UN Comtrade, HMRC and national statistics offices</p>
        </div>
        <TradeStory className="mm-hero-scene" />
      </section>

      <div className="typeahead mm-search">
        <input
          type="search"
          placeholder="Try shea butter, cashew, mango, tiles"
          aria-label="Search for a product"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div style={{ height: 10 }} />
      <Chips options={flowOptions} value={flow} onChange={setFlow} />
      <div style={{ height: 6 }} />
      <Chips options={continentOptions} value={continent} onChange={setContinent} />
      <div style={{ height: 18 }} />

      {summary && summary.total > 0 && (
        <div className="mm-stats" data-reveal>
          <Stat n={summary.total} k="Openings" />
          <Stat n={summary.exports} k="To sell" />
          <Stat n={summary.imports} k="To supply" />
          <Stat n={summary.strong} k="Strong case" />
          {summary.within_budget != null ? (
            <Stat n={summary.within_budget} k="Within budget" />
          ) : (
            <Stat n={summary.markets} k={summary.markets === 1 ? 'Market' : 'Markets'} />
          )}
        </div>
      )}

      <BudgetBar budget={budget} onChange={setBudget} />

      <div className="mm-section-head" id="openings">
        <h2>{splitHeading(listHeading)}</h2>
      </div>

      {searchNote && (
        <p className="tiny dim" style={{ margin: '2px 0 0' }}>
          {searchNote}
        </p>
      )}
      <p className="tiny dim" style={{ margin: '2px 0 12px' }}>
        Ranked by momentum score across the markets Tereflow has analysed: how fast each line is
        moving, not how easy it is to enter.
        {summary && summary.total > products.length && (
          <> Showing the top {products.length} of {summary.total}.</>
        )}
      </p>

      {loading ? (
        <Skeletons n={5} />
      ) : products.length === 0 ? (
        <Empty
          title="Nothing matches yet"
          hint="Try a different product name, or clear the region filter. Some markets are still completing their analysis."
        />
      ) : (
        products.map((p) => (
          <ProductCardRow
            key={`${p.flow}-${p.hs_code}-${p.iso3}`}
            product={p}
            budget={budget}
            onOpen={openProduct}
          />
        ))
      )}

      {user && feedUnread > 0 && (
        <Link className="mm-feed-note" to="/feed">
          <strong>{feedUnread} new in your feed</strong>
          <span>From the markets and products you follow</span>
          <span aria-hidden>{'\u203a'}</span>
        </Link>
      )}

      <section className="mm-block" data-reveal>
        <h2 className="mm-title">
          Stay ahead <em>of the market</em>
        </h2>
        <div className="mm-cards">
          <Link className="mm-card" to="/sandbox">
            <h3>Trade Sandbox</h3>
            <p>Pick a country, add the partners you care about and compare the trade between them, product by product.</p>
          </Link>
          <Link className="mm-card" to="/countries">
            <h3>Browse countries</h3>
            <p>Summary figures, partners and blue oceans for every market on record.</p>
          </Link>
          <Link className="mm-card" to="/network">
            <h3>Find people to trade with</h3>
            <p>Buyers, sellers, suppliers and distributors you can message directly.</p>
          </Link>
          <Link className="mm-card cta" to={entitled ? '/feed' : '/upgrade'}>
            <h3>{entitled ? 'Your premium feed' : 'Go premium'}</h3>
            <p>
              {entitled
                ? 'Weekly read on the products and markets you follow.'
                : 'Early signals, entry playbooks and a weekly watchlist read.'}
            </p>
            <span className="mm-cta small">{entitled ? 'Open feed' : 'See premium'} <span aria-hidden>{'\u2192'}</span></span>
          </Link>
        </div>
      </section>

      <section className="mm-block" data-reveal>
        <h2 className="mm-title">
          How to <em>read it</em>
        </h2>
        <div className="mm-accordion">
          <details open>
            <summary>To sell</summary>
            <p>An export opening: a product a country already sells abroad and that is growing fast. It is something you could sell, and the best market is the buyer taking the most of it.</p>
          </details>
          <details>
            <summary>To supply</summary>
            <p>An import opening: a product a country is buying more of every year. It is a gap you could fill, and the best market is the main supplier you would compete with.</p>
          </details>
          <details>
            <summary>The score</summary>
            <p>Out of 100, built from three-year growth, momentum, how reliable the figures are and the size of the trade. It shows how fast a line is moving, not how easy it is to enter.</p>
          </details>
        </div>
      </section>

      {news.length > 0 && (
        <section className="mm-block" data-reveal>
          <div className="mm-title-row">
            <h2 className="mm-title">
              Trade <em>newsroom</em>
            </h2>
            <Link className="mm-link" to="/news">All news {'\u203a'}</Link>
          </div>
          <div className="mm-news">
            {news.map((n) => (
              <a key={n.link} className="mm-news-card" href={n.link} target="_blank" rel="noopener noreferrer">
                {n.image && <img src={n.image} alt="" loading="lazy" />}
                <span className="mm-news-tag">{n.topic || n.region}</span>
                <strong>{n.title}</strong>
                <span className="mm-news-meta">{n.source}</span>
              </a>
            ))}
          </div>
        </section>
      )}


      {modalHs && (
        <ProductModal
          hsCode={modalHs}
          countrySlug={modalCountry}
          flow={modalFlow}
          onClose={() => setModalHs(null)}
        />
      )}
    </div>
  );
}
