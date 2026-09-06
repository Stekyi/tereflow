import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Chips, Empty, Skeletons } from '../components/ui';
import { HeroScene } from '../components/Brand';
import ProductModal, { ProductCardRow } from '../components/ProductModal';
import { CONTINENTS, type ProductCard, type ProductSummary } from '../../shared/types';

type FlowFilter = 'all' | 'export' | 'import';

/**
 * One figure in the strip above the list.
 *
 * "To sell" and "To supply" rather than "Exports" and "Imports" because the
 * reader is deciding what to do, not reading a trade statistic: an export
 * opening is something they could sell, an import opening is a gap they could
 * fill.
 */
function Kpi({ n, k }: { n: number; k: string }) {
  return (
    <div className="kpi">
      <strong>{n}</strong>
      <span className="tiny dim">{k}</span>
    </div>
  );
}

export default function Home() {
  const { user, entitled, feedUnread } = useSession();
  const [q, setQ] = useState('');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [continent, setContinent] = useState<string>('all');
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [summary, setSummary] = useState<ProductSummary | null>(null);
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
          limit: 40,
        })
        .then((r) => {
          setProducts(r.products);
          setSummary(r.summary);
        })
        .catch(() => {
          setProducts([]);
          setSummary(null);
        })
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [q, flow, continent]);

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
  const listHeading = useMemo(() => {
    const query = q.trim();
    if (query) return `Results for "${query}"`;
    if (flow === 'all' && continent === 'all') return 'Top opportunities worldwide this week';
    const flowWord = flow === 'all' ? '' : `${flow} `;
    const region = continent === 'all' ? '' : ` in ${continent}`;
    return `Top ${flowWord}opportunities${region} this week`;
  }, [q, flow, continent]);

  return (
    <>
      <div className="hero with-scene">
        <HeroScene className="hero-scene" />
        <span className="overline">Global trade intelligence</span>
        <h2>Find a product worth trading</h2>
        <p>Search a specific product to see who sells it, who buys it, and where the opening is.</p>
      </div>

      <div className="typeahead" style={{ marginTop: 4 }}>
        <input
          type="search"
          placeholder="Try shea butter, cashew, mango, tiles"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div style={{ height: 10 }} />
      <Chips options={flowOptions} value={flow} onChange={setFlow} />
      <div style={{ height: 6 }} />
      <Chips options={continentOptions} value={continent} onChange={setContinent} />
      <div style={{ height: 14 }} />

      {summary && summary.total > 0 && (
        <div className="kpi-strip">
          <Kpi n={summary.total} k="Openings" />
          <Kpi n={summary.exports} k="To sell" />
          <Kpi n={summary.imports} k="To supply" />
          <Kpi n={summary.strong} k="Strong case" />
          <Kpi n={summary.markets} k={summary.markets === 1 ? 'Market' : 'Markets'} />
        </div>
      )}

      <div className="section-head">
        <h2 style={{ fontSize: 16 }}>{listHeading}</h2>
      </div>
      <p className="tiny dim" style={{ margin: '2px 0 12px' }}>
        Ranked by opportunity score across the markets Tereflow has analysed.
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
          <ProductCardRow key={`${p.flow}-${p.hs_code}-${p.iso3}`} product={p} onOpen={openProduct} />
        ))
      )}

      <div className="section-head" style={{ marginTop: 20 }}>
        <h2 className="dim" style={{ fontSize: 15 }}>
          More on Tereflow
        </h2>
      </div>

      {user && feedUnread > 0 && (
        <Link
          className="card tight"
          to="/feed"
          style={{ display: 'block', borderColor: 'var(--brand)' }}
        >
          <div className="row between">
            <span>
              <span style={{ fontWeight: 650, fontSize: 15 }}>{feedUnread} new in your feed</span>
              <span className="tiny dim" style={{ display: 'block' }}>
                From the markets and products you follow
              </span>
            </span>
            <span className="dim">{'\u203a'}</span>
          </div>
        </Link>
      )}

      <Link className="list-item" to="/network">
        <span className="grow">
          <span className="name">Find people to trade with</span>
          <span className="tiny dim">Buyers, sellers, suppliers and distributors you can message</span>
        </span>
        <span className="dim">{'\u203a'}</span>
      </Link>

      <Link className="list-item" to="/countries">
        <span className="grow">
          <span className="name">Browse countries</span>
          <span className="tiny dim">Summary figures for every market on record</span>
        </span>
        <span className="dim">{'\u203a'}</span>
      </Link>

      <Link
        className="list-item"
        to={entitled ? '/feed' : '/upgrade'}
        style={{ borderColor: 'var(--brand)' }}
      >
        <span className="grow">
          <span className="name">
            <span className="badge premium" style={{ marginRight: 6 }}>
              {'\u2605'}
            </span>
            {entitled ? 'Your premium feed' : 'Go premium'}
          </span>
          <span className="tiny dim">
            {entitled
              ? 'Weekly read on the products and markets you follow'
              : 'Early signals, entry playbooks, and a weekly watchlist read'}
          </span>
        </span>
        <span className="dim">{'\u203a'}</span>
      </Link>

      {modalHs && (
        <ProductModal
          hsCode={modalHs}
          countrySlug={modalCountry}
          flow={modalFlow}
          onClose={() => setModalHs(null)}
        />
      )}
    </>
  );
}
