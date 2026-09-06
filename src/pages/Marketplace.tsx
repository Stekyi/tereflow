import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { CardRow } from './Network';
import {
  EXPORT_CATEGORY_HINT,
  EXPORT_CATEGORY_LABEL,
  fmtUsd,
  INTENTS,
  INTENT_LABEL,
  type BusinessCard,
  type Intent,
  type MarketHsCode,
  type MarketProducts,
} from '../../shared/types';

export default function Marketplace() {
  const [matches, setMatches] = useState<MarketHsCode[]>([]);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<MarketHsCode | null>(null);
  const [showMajor, setShowMajor] = useState(false);

  const [data, setData] = useState<MarketProducts | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(false);

  const [cards, setCards] = useState<BusinessCard[]>([]);
  const [cardsBroadened, setCardsBroadened] = useState(false);
  const [loadingCards, setLoadingCards] = useState(false);
  const [intent, setIntent] = useState<Intent | ''>('');

  // Live search against the specific products actually reported in the data
  // (server-side: there are thousands of possible HS6 lines, not the ~97
  // chapters this used to page through client-side). Debounced so every
  // keystroke doesn't fire a request.
  useEffect(() => {
    if (selected?.label === query) return;
    const handle = setTimeout(() => {
      api.market
        .hsCodes(query.trim(), showMajor)
        .then((r) => setMatches(r.codes))
        .catch(() => setMatches([]));
    }, 200);
    return () => clearTimeout(handle);
  }, [query, showMajor, selected]);

  useEffect(() => {
    if (!selected) return;
    setLoadingProducts(true);
    api.market
      .products(selected.code)
      .then(setData)
      .catch(() => setData(null))
      .finally(() => setLoadingProducts(false));
  }, [selected]);

  useEffect(() => {
    if (!selected) return;
    setLoadingCards(true);
    api.network
      .discover({ q: selected.code, intent: intent || undefined })
      .then((r) => {
        if (r.cards.length) {
          setCards(r.cards);
          setCardsBroadened(false);
          return;
        }
        return api.network.discover({ sector: selected.sector, intent: intent || undefined }).then((r2) => {
          setCards(r2.cards);
          setCardsBroadened(true);
        });
      })
      .catch(() => setCards([]))
      .finally(() => setLoadingCards(false));
  }, [selected, intent]);

  const intentOptions = useMemo(
    () => [
      { value: '' as Intent | '', label: 'Everyone' },
      ...INTENTS.map((i) => ({ value: i as Intent | '', label: INTENT_LABEL[i] })),
    ],
    [],
  );

  const pick = (h: MarketHsCode) => {
    setSelected(h);
    setQuery(h.label);
    setOpen(false);
  };

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Search a specific product or service — the actual line as reported by national statistics,
        not a broad category — to see which countries trade the most of it, their general trading
        partners, and the registered businesses on Tereflow already active in it.
      </p>

      <div className="typeahead">
        <input
          type="search"
          placeholder="Search a specific product or service — try pineapple, shea butter, cassava"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(null);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
        />
        {open && matches.length > 0 && (
          <div className="typeahead-list">
            {matches.map((h) => (
              <button key={h.code} type="button" className="typeahead-item" onClick={() => pick(h)}>
                {h.label}
                <span className="tiny dim">{h.sector}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <label className="row small dim" style={{ gap: 6, marginTop: 8, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={showMajor}
          onChange={(e) => setShowMajor(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Also show major/traditional trade (gold, oil, and similar — large-scale and licensed)
      </label>

      <div style={{ height: 14 }} />

      {!selected ? (
        <Empty
          title="Search to get started"
          hint="Try a product or service name. You'll see who trades it by country, and who on Tereflow is already active in it."
        />
      ) : (
        <>
          <div className="section-head" style={{ marginTop: 0 }}>
            <div>
              <h2>{data?.label ?? selected.label}</h2>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                {data?.sector ?? selected.sector}
              </p>
            </div>
          </div>

          {data && (
            <p className="small" style={{ margin: '0 0 12px' }}>
              <span className={`badge ${data.category === 'traditional' ? 'watch' : 'on'}`}>
                {EXPORT_CATEGORY_LABEL[data.category]}
              </span>{' '}
              <span className="dim">{EXPORT_CATEGORY_HINT[data.category]}</span>
            </p>
          )}

          {loadingProducts ? (
            <Skeletons n={4} />
          ) : !data || (data.exporters.length === 0 && data.importers.length === 0) ? (
            <Empty
              title="No trade data yet"
              hint="No country with a completed analysis run reports this category yet."
            />
          ) : (
            <>
              <CountryRankList
                title="Sells the most"
                rows={data.exporters}
                partnersBySlug={data.partners_by_slug}
                flow="export"
              />
              <CountryRankList
                title="Buys the most"
                rows={data.importers}
                partnersBySlug={data.partners_by_slug}
                flow="import"
              />
            </>
          )}

          <div className="section-head">
            <div>
              <h2>Active on Tereflow</h2>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                {cardsBroadened
                  ? `No exact match yet — showing registered businesses in ${data?.sector ?? selected.sector}.`
                  : 'Registered businesses that named this product or service on their card.'}
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
        </>
      )}
    </>
  );
}

function CountryRankList({
  title,
  rows,
  partnersBySlug,
  flow,
}: {
  title: string;
  rows: MarketProducts['exporters'];
  partnersBySlug: MarketProducts['partners_by_slug'];
  flow: 'export' | 'import';
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((r) => r.value_usd), 1);
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      {rows.map((r) => {
        const partners = partnersBySlug[r.slug]?.[flow] ?? [];
        return (
          <Link className="bar-row" key={r.slug} to={`/country/${r.slug}`} style={{ display: 'block' }}>
            <div className="bar-fill" style={{ width: `${Math.max(3, (r.value_usd / max) * 100)}%` }} />
            <div className="bar-content">
              <span className="rank-badge">{r.rank}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 620, fontSize: 14 }}>{r.name}</span>
                <span className="tiny dim">
                  {r.year}
                  {partners.length > 0 && (
                    <> · General partners: {partners.slice(0, 3).map((p) => p.name).join(', ')}</>
                  )}
                </span>
              </span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtUsd(r.value_usd)}</span>
            </div>
          </Link>
        );
      })}
    </div>
  );
}
