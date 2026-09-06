import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { CardRow } from './Network';
import ProductModal, { ProductCardRow } from '../components/ProductModal';
import {
  INTENTS,
  INTENT_LABEL,
  type BusinessCard,
  type Intent,
  type ProductCard,
} from '../../shared/types';

export default function Marketplace() {
  const [params, setParams] = useSearchParams();

  const [query, setQuery] = useState('');
  const [all, setAll] = useState(false);
  const [products, setProducts] = useState<ProductCard[]>([]);
  const [loadingProducts, setLoadingProducts] = useState(true);

  const [cards, setCards] = useState<BusinessCard[]>([]);
  const [loadingCards, setLoadingCards] = useState(true);
  const [intent, setIntent] = useState<Intent | ''>('');

  // Deep link from the product modal's "Find partners" button. Opening the
  // modal here keeps that flow inside the marketplace rather than bouncing home.
  const modalHs = params.get('hs');
  const openModal = (hs: string) => setParams({ hs }, { replace: false });
  const closeModal = () => {
    const next = new URLSearchParams(params);
    next.delete('hs');
    setParams(next, { replace: true });
  };

  // Always show a browsable list. The search box refines it instead of gating
  // the whole page behind an empty state.
  useEffect(() => {
    setLoadingProducts(true);
    const handle = setTimeout(() => {
      api
        .products({ q: query.trim() || undefined, all: all || undefined, limit: 40 })
        .then((r) => setProducts(r.products))
        .catch(() => setProducts([]))
        .finally(() => setLoadingProducts(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, all]);

  // The people side of the marketplace: registered businesses, filtered by the
  // same search text and the intent chips.
  useEffect(() => {
    setLoadingCards(true);
    const handle = setTimeout(() => {
      api.network
        .discover({ q: query.trim() || undefined, intent: intent || undefined })
        .then((r) => setCards(r.cards))
        .catch(() => setCards([]))
        .finally(() => setLoadingCards(false));
    }, 250);
    return () => clearTimeout(handle);
  }, [query, intent]);

  const intentOptions = useMemo(
    () => [
      { value: '' as Intent | '', label: 'Everyone' },
      ...INTENTS.map((i) => ({ value: i as Intent | '', label: INTENT_LABEL[i] })),
    ],
    [],
  );

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Browse specific products and services, see which countries trade the most of each, and reach
        the registered businesses already active in it. Tap a product for the full worldwide read.
      </p>

      <div className="typeahead">
        <input
          type="search"
          placeholder="Search a product or service, try pineapple, shea butter, cassava"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      <label className="row small dim" style={{ gap: 6, marginTop: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={all}
          onChange={(e) => setAll(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Also show major/traditional trade (gold, oil, and similar, large-scale and licensed)
      </label>

      <div style={{ height: 14 }} />

      {loadingProducts ? (
        <Skeletons n={5} />
      ) : products.length === 0 ? (
        <Empty
          title="Nothing matches yet"
          hint="Try a different product name, or turn on major/traditional trade to widen the search."
        />
      ) : (
        products.map((p) => (
          <ProductCardRow key={`${p.flow}-${p.hs_code}-${p.iso3}`} product={p} onOpen={openModal} />
        ))
      )}

      <div className="section-head">
        <div>
          <h2>Active on Tereflow</h2>
          <p className="small muted" style={{ margin: '4px 0 0' }}>
            {query.trim()
              ? 'Registered businesses that match your search.'
              : 'Registered businesses across every product and service.'}
          </p>
        </div>
      </div>

      <Chips options={intentOptions} value={intent} onChange={setIntent} />
      <div style={{ height: 14 }} />

      {loadingCards ? (
        <Skeletons n={3} />
      ) : cards.length === 0 ? (
        <Empty
          title="Nobody registered yet"
          hint="Be the first to add a business card for this product or service."
        />
      ) : (
        cards.map((c) => <CardRow key={c.id} card={c} />)
      )}

      {modalHs && <ProductModal hsCode={modalHs} onClose={closeModal} />}
    </>
  );
}
