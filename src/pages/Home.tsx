import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { Chips, Empty, Skeletons } from '../components/ui';
import ProductModal, { ProductCardRow } from '../components/ProductModal';
import { CONTINENTS, type ProductCard } from '../../shared/types';

type FlowFilter = 'all' | 'export' | 'import';

export default function Home() {
  const { user, entitled, feedUnread } = useSession();
  const [q, setQ] = useState('');
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [continent, setContinent] = useState<string>('all');
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [loading, setLoading] = useState(true);
  const [modalHs, setModalHs] = useState<string | null>(null);

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
        .then((r) => setProducts(r.products))
        .catch(() => setProducts([]))
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

  return (
    <>
      <div className="hero">
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

      {loading ? (
        <Skeletons n={5} />
      ) : products.length === 0 ? (
        <Empty
          title="Nothing matches yet"
          hint="Try a different product name, or clear the region filter. Some markets are still completing their analysis."
        />
      ) : (
        products.map((p) => (
          <ProductCardRow key={`${p.flow}-${p.hs_code}-${p.iso3}`} product={p} onOpen={setModalHs} />
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

      {modalHs && <ProductModal hsCode={modalHs} onClose={() => setModalHs(null)} />}
    </>
  );
}
