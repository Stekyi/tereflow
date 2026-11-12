import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Chips, Empty, Skeletons } from '../components/ui';
import { BudgetBar } from '../components/BudgetBar';
import { useBudget } from '../lib/budget';
import ProductModal, { ProductCardRow } from '../components/ProductModal';
import { CONTINENTS, type ProductCard, type ProductSummary } from '../../shared/types';
import InfoTip from '../components/InfoTip';
import homeCfg from '../../shared/config/home.json';

type FlowFilter = 'all' | 'export' | 'import';

export default function Home() {
  const { user, feedUnread } = useSession();
  // Two ways in: the general ranked list, or pick a country first.
  const [view, setView] = useState<'top' | 'country'>('top');
  const [countryList, setCountryList] = useState<Awaited<ReturnType<typeof api.countries>>['countries']>([]);
  useEffect(() => {
    api.countries().then((r) => setCountryList(r.countries.filter((c) => c.is_active))).catch(() => setCountryList([]));
  }, []);
  const orderedCountries = useMemo(() => {
    const first = homeCfg.default_region;
    return [...countryList].sort((a, b) => Number(b.continent === first) - Number(a.continent === first) || a.name.localeCompare(b.name));
  }, [countryList]);
  const [budget, setBudget] = useBudget();
  const [q, setQ] = useState('');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [continent, setContinent] = useState<string>(
    (CONTINENTS as readonly string[]).includes(homeCfg.default_region) ? homeCfg.default_region : 'all',
  );
  // Real photographs only: a hero image an operator uploaded in the admin, if there is one.
  const [heroPhoto, setHeroPhoto] = useState<{ url: string; alt_text: string } | null>(null);
  useEffect(() => {
    fetch('/api/media?category=hero')
      .then((r) => (r.ok ? r.json() : { images: [] }))
      .then((r: { images: { url: string; alt_text: string }[] }) => setHeroPhoto(r.images[0] ?? null))
      .catch(() => setHeroPhoto(null));
  }, []);
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
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    setLoading(true);
    // A slower, older request must never overwrite the answer to the latest search.
    let live = true;
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
          if (!live) return;
          setFailed(false);
          setProducts(r.products);
          setSummary(r.summary);
          setSearchNote(r.note ?? null);
        })
        .catch(() => {
          if (!live) return;
          setFailed(true);
          setProducts([]);
          setSummary(null);
          setSearchNote(null);
        })
        .finally(() => { if (live) setLoading(false); });
    }, 200);
    return () => { live = false; clearTimeout(handle); };
  }, [q, flow, continent, budget, retry]);

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
    <div className="mm-home">
      <section className="mm-hero simple" aria-label="Find a product worth trading">
        <div className="mm-hero-copy">
          <span className="mm-overline">Trade intelligence, Africa first</span>
          <h1>
            {homeCfg.headline_lead}
            <em> {homeCfg.headline_accent}</em>
          </h1>
          <p>{homeCfg.subheadline}</p>
          <ol className="pipeline-strip" aria-label="How every opening works">
            <li><strong>1 Data</strong><span>What the trade shows</span></li>
            <li><strong>2 Insight</strong><span>What it means</span></li>
            <li><strong>3 Action</strong><span>What to do next</span></li>
          </ol>
        </div>
        {heroPhoto && (
          <img className="mm-hero-scene" src={heroPhoto.url} alt={heroPhoto.alt_text} style={{ objectFit: 'cover', borderRadius: 12, width: '100%', maxHeight: 300 }} />
        )}
      </section>

      <div className="view-switch" role="tablist" aria-label="How to browse">
        <button type="button" role="tab" aria-selected={view === 'top'} className={view === 'top' ? 'on' : ''} onClick={() => setView('top')}>Top opportunities</button>
        <button type="button" role="tab" aria-selected={view === 'country'} className={view === 'country' ? 'on' : ''} onClick={() => setView('country')}>By country</button>
      </div>

      {view === 'country' ? (
        <section aria-label="Countries">
          <p className="small dim" style={{ margin: '0 0 12px' }}>Choose a country to see what it exports and imports, then open any product in it.</p>
          {orderedCountries.length === 0 ? (
            <Skeletons n={4} />
          ) : (
            <div className="country-grid">
              {orderedCountries.map((c) => (
                <Link key={c.slug} className="country-card" to={`/country/${c.slug}`}>
                  <strong>{c.name}</strong>
                  <span className="tiny dim">{c.continent}{c.year ? `, ${c.year}` : ''}</span>
                  <span className="country-figs">
                    <span><small>Exports</small>{c.export_usd != null ? fmtBig(c.export_usd) : 'n/a'}</span>
                    <span><small>Imports</small>{c.import_usd != null ? fmtBig(c.import_usd) : 'n/a'}</span>
                  </span>
                  {c.top_export && <span className="tiny dim">Top export: {c.top_export}</span>}
                </Link>
              ))}
            </div>
          )}
        </section>
      ) : (
        <>
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
          <div style={{ height: 14 }} />
          <BudgetBar budget={budget} onChange={setBudget} />

          <div className="mm-section-head" id="openings">
            <h2>{listHeading}<InfoTip k="product-list" /></h2>
          </div>
          {continent === homeCfg.default_region && homeCfg.default_region !== 'all' && (
            <p className="tiny dim" style={{ margin: '0 0 6px' }}>{homeCfg.africa_note}</p>
          )}
          {searchNote && <p className="tiny dim" style={{ margin: '2px 0 0' }}>{searchNote}</p>}
          <p className="tiny dim" style={{ margin: '2px 0 12px' }}>
            Open any line to see its data, what it means, and what to do next.
            {products.length > 0 && <> Latest trade year here: {Math.max(...products.map((p) => p.year))}. <Link to="/data-sources">Sources and update frequency</Link></>}
            {summary && summary.total > products.length && <> Showing the top {products.length} of {summary.total}.</>}
          </p>

          {loading ? (
            <Skeletons n={5} />
          ) : failed ? (
            <Empty
              title="The search could not run"
              hint="That is a fault on our side, not a sign nothing matches. Tap to try again."
              action={<button type="button" className="mm-cta small" onClick={() => setRetry((n) => n + 1)}>Try again</button>}
            />
          ) : products.length === 0 ? (
            <Empty title="Nothing matches yet" hint="Try a different product name, or choose All regions." />
          ) : (
            products.map((p) => (
              <ProductCardRow key={`${p.flow}-${p.hs_code}-${p.iso3}`} product={p} budget={budget} onOpen={openProduct} />
            ))
          )}
        </>
      )}

      {user && feedUnread > 0 && (
        <Link className="mm-feed-note" to="/feed">
          <strong>{feedUnread} new in your feed</strong>
          <span>From the markets and products you follow</span>
          <span aria-hidden>{'\u203a'}</span>
        </Link>
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

const fmtBig = (n: number) => (n >= 1e12 ? `$${(n / 1e12).toFixed(1)}tn` : n >= 1e9 ? `$${(n / 1e9).toFixed(1)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(0)}m` : `$${Math.round(n / 1e3)}k`);
