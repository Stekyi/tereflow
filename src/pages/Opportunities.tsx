/**
 * Opportunities: where the data shows an opening.
 *
 * The cross-country feed behind /api/opportunities: the lines with the strongest recent movement in every market
 * Tereflow has analysed, each with the evidence it rests on (value, three-year growth, the main partners) and a
 * plain-language reason. It is a ranking of momentum, not a promise of profit, and the page says so.
 */
import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { usePageTitle } from '../lib/pageTitle';
import { Chips, Empty, Skeletons } from '../components/ui';
import ProductModal from '../components/ProductModal';
import { CountUp } from '../components/TradeStory';
import { shortProductName } from '../../shared/product-name';
import { fmtPct, fmtUsd, type ExploreOpportunity } from '../../shared/types';

type FlowFilter = 'all' | 'export' | 'import';

function codeOf(o: ExploreOpportunity): string {
  // Ids end in the product code ("united-kingdom-M-87036010").
  return o.id.slice(o.id.lastIndexOf('-') + 1);
}

export default function Opportunities() {
  usePageTitle('Opportunities');
  const [items, setItems] = useState<ExploreOpportunity[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [flow, setFlow] = useState<FlowFilter>('all');
  const [country, setCountry] = useState('all');
  const [modal, setModal] = useState<{ hs: string; slug: string; flow: 'export' | 'import' } | null>(null);

  useEffect(() => {
    api
      .opportunities()
      .then((r) => setItems(r.opportunities))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  const countries = useMemo(() => {
    const seen = new Map<string, string>();
    for (const o of items) seen.set(o.slug, o.country);
    return [...seen.entries()].map(([value, label]) => ({ value, label }));
  }, [items]);

  const shown = useMemo(
    () => items.filter((o) => (flow === 'all' || o.flow === flow) && (country === 'all' || o.slug === country)),
    [items, flow, country],
  );

  const flowOptions = [
    { value: 'all' as FlowFilter, label: 'All openings' },
    { value: 'export' as FlowFilter, label: 'To sell' },
    { value: 'import' as FlowFilter, label: 'To supply' },
  ];
  const countryOptions = [{ value: 'all', label: 'All countries' }, ...countries];

  return (
    <>
      <section className="mm-country-hero">
        <div className="mm-country-id">
          <span className="mm-overline">Where the data shows an opening</span>
        </div>
        <h1 className="mm-country-name">
          Trade <em>opportunities</em>
        </h1>
        <p className="mm-country-sub">
          The product lines moving fastest in each market, with the evidence behind them. <strong>To sell</strong> is
          something a country already sells abroad and is growing. <strong>To supply</strong> is something it is buying
          more of every year. A strong line is a place to look, not proof of a profitable business.
        </p>
      </section>

      {!loading && !error && items.length > 0 && (
        <div className="mm-stats" style={{ gridTemplateColumns: 'repeat(3, 1fr)' }}>
          <div className="mm-stat">
            <strong>
              <CountUp text={String(shown.length)} />
            </strong>
            <span>Openings shown</span>
          </div>
          <div className="mm-stat">
            <strong>
              <CountUp text={String(shown.filter((o) => o.flow === 'export').length)} />
            </strong>
            <span>To sell</span>
          </div>
          <div className="mm-stat">
            <strong>
              <CountUp text={String(shown.filter((o) => o.flow === 'import').length)} />
            </strong>
            <span>To supply</span>
          </div>
        </div>
      )}

      <Chips options={flowOptions} value={flow} onChange={setFlow} />
      <div style={{ height: 6 }} />
      {countries.length > 1 && <Chips options={countryOptions} value={country} onChange={setCountry} />}
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={5} />
      ) : error ? (
        <Empty title="Could not load the openings" hint={error} />
      ) : shown.length === 0 ? (
        <Empty title="No openings match" hint="Try another country or clear the filter." />
      ) : (
        shown.map((o) => (
          <article className="mm-opp" key={o.id}>
            <div className="mm-opp-head">
              <div>
                <span className={`badge ${o.flow === 'export' ? 'up' : ''}`}>{o.flow === 'export' ? 'To sell' : 'To supply'}</span>
                <h3>{shortProductName(o.name)}</h3>
                <p className="tiny dim">
                  <Link to={`/country/${o.slug}`}>{o.country}</Link> · {o.year}
                </p>
              </div>
              <div className="mm-opp-fig">
                <strong>{fmtUsd(o.value_usd)}</strong>
                {o.growth_pct != null && (
                  <span className={o.growth_pct >= 0 ? 'up' : 'down'}>{fmtPct(o.growth_pct)} a year</span>
                )}
              </div>
            </div>
            {o.rationale && <p className="mm-opp-why">{o.rationale}</p>}
            {o.partners.length > 0 && (
              <p className="tiny dim mm-opp-partners">
                Main {o.flow === 'import' ? 'suppliers' : 'buyers'}:{' '}
                {o.partners.slice(0, 4).map((p, i) => (
                  <span key={`${o.id}-${p.iso3 ?? p.name}`}>
                    {i > 0 && ', '}
                    {p.name}
                  </span>
                ))}
              </p>
            )}
            <div className="mm-opp-actions">
              <button
                className="mm-cta small"
                type="button"
                onClick={() => setModal({ hs: codeOf(o), slug: o.slug, flow: o.flow })}
              >
                See who trades it <span aria-hidden>{'\u2192'}</span>
              </button>
            </div>
          </article>
        ))
      )}

      {modal && (
        <ProductModal hsCode={modal.hs} countrySlug={modal.slug} flow={modal.flow} onClose={() => setModal(null)} />
      )}
    </>
  );
}
