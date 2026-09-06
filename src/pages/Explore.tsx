import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { fmtPct, fmtUsd, type Entity, type ExploreOpportunity } from '../../shared/types';

type Mode = 'markets' | 'products' | 'major';
type MajorMetric = 'export' | 'import';

const CONTINENT_OPTIONS = [
  { value: '', label: 'All' },
  { value: 'Africa', label: 'Africa' },
  { value: 'Asia', label: 'Asia' },
  { value: 'Europe', label: 'Europe' },
  { value: 'North America', label: 'N. America' },
  { value: 'South America', label: 'S. America' },
  { value: 'Oceania', label: 'Oceania' },
];

interface RankRow {
  rank: number;
  slug: string;
  name: string;
  iso3: string;
  continent: string;
  value_usd: number;
  balance_usd: number;
  year: number | null;
}

export default function Explore() {
  const [mode, setMode] = useState<Mode>('products');
  const [majorMetric, setMajorMetric] = useState<MajorMetric>('export');
  const [continent, setContinent] = useState('');
  const [q, setQ] = useState('');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [ranks, setRanks] = useState<RankRow[]>([]);
  const [opportunities, setOpportunities] = useState<ExploreOpportunity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    if (mode === 'markets') {
      api
        .entities({ kind: 'country' })
        .then((r) => setEntities(r.entities))
        .catch(() => setEntities([]))
        .finally(() => setLoading(false));
    } else if (mode === 'products') {
      api
        .opportunities()
        .then((r) => setOpportunities(r.opportunities))
        .catch(() => setOpportunities([]))
        .finally(() => setLoading(false));
    } else {
      api
        .rankings(majorMetric)
        .then((r) => setRanks(r.rows))
        .catch(() => setRanks([]))
        .finally(() => setLoading(false));
    }
  }, [mode, majorMetric]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (name: string, iso: string | null, cont: string | null) =>
      (!continent || cont === continent) &&
      (!needle || name.toLowerCase().includes(needle) || (iso ?? '').toLowerCase().includes(needle));

    if (mode === 'markets') return entities.filter((e) => match(e.name, e.iso3, e.continent));
    if (mode === 'products') return opportunities.filter((o) =>
      match(`${o.name} ${o.country}`, o.iso3, o.continent),
    );
    return ranks.filter((r) => match(r.name, r.iso3, r.continent));
  }, [mode, entities, ranks, opportunities, q, continent]);

  const max = mode === 'markets' || mode === 'products'
    ? 0
    : Math.max(...(filtered as RankRow[]).map((r) => r.value_usd), 1);

  return (
    <>
      <input
        type="search"
        placeholder="Search a country or ISO code"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <div className="row" style={{ justifyContent: 'flex-end', marginBottom: 6 }}>
        <button
          type="button"
          onClick={() => setMode(mode === 'major' ? 'products' : 'major')}
          style={{
            background: 'none',
            border: 0,
            padding: 0,
            cursor: 'pointer',
            fontSize: 13,
            fontWeight: 600,
            letterSpacing: '0.01em',
            color: 'var(--brand)',
          }}
        >
          {mode === 'major' ? '‹ Back to browsing' : 'Total trade ›'}
        </button>
      </div>

      <Chips
        options={[
          { value: 'products' as Mode, label: 'Products' },
          { value: 'markets' as Mode, label: 'Countries' },
        ]}
        value={mode}
        onChange={setMode}
      />

      {mode === 'major' && (
        <>
          <div style={{ height: 8 }} />
          <Chips
            options={[
              { value: 'export' as MajorMetric, label: 'Exporters' },
              { value: 'import' as MajorMetric, label: 'Importers' },
            ]}
            value={majorMetric}
            onChange={setMajorMetric}
          />
        </>
      )}

      <div style={{ height: 8 }} />
      <Chips options={CONTINENT_OPTIONS} value={continent} onChange={setContinent} />

      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={6} />
      ) : filtered.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint={
            mode === 'products'
              ? 'No growing product or service signals match these filters yet.'
              : mode === 'markets'
              ? 'Only activated countries appear here. Tick more in Admin.'
              : 'Total trade rankings only include countries that have completed an analysis run.'
          }
        />
      ) : mode === 'products' ? (
        <div className="opportunity-list">
          <div className="section-head" style={{ marginTop: 0 }}>
            <div>
              <h2>Goods and services to investigate</h2>
              <p className="small muted" style={{ margin: '4px 0 0' }}>
                Growing categories outside the biggest established trade. Built for people looking for an
                opening, not another list of what the giants already own.
              </p>
            </div>
          </div>
          {(filtered as ExploreOpportunity[]).map((opportunity) => (
            <Link className="opportunity-card" key={opportunity.id} to={`/country/${opportunity.slug}`}>
              <div className="row between" style={{ gap: 12 }}>
                <div className="row" style={{ minWidth: 0 }}>
                  <span className="flag small-flag">{opportunity.iso3}</span>
                  <span className="grow" style={{ minWidth: 0 }}>
                    <span className="name">{opportunity.name}</span>
                    <span className="tiny dim">
                      {opportunity.country} · {opportunity.kind === 'service' ? 'Service' : opportunity.flow === 'export' ? 'Export' : 'Import'}
                    </span>
                  </span>
                </div>
                <span className="badge watch">Look closer</span>
              </div>
              <div className="opportunity-metrics">
                <span><strong>{fmtUsd(opportunity.value_usd)}</strong> in {opportunity.year}</span>
                <span>{opportunity.growth_pct != null ? `${fmtPct(opportunity.growth_pct, 0)}/yr` : 'Growth unavailable'}</span>
                {opportunity.rank != null && <span>Rank {opportunity.rank}</span>}
              </div>
              <p className="small muted" style={{ margin: '9px 0 0' }}>{opportunity.rationale}</p>
              <div className="opportunity-partners">
                <span className="tiny dim">
                  {opportunity.partners.some((partner) => partner.detail_available)
                    ? 'Partners for this product'
                    : 'Available partners for this trade flow'}
                </span>
                {opportunity.partners.length ? opportunity.partners.map((partner) => (
                  <span className="partner-chip" key={`${opportunity.id}-${partner.iso3 ?? partner.name}`}>
                    {partner.name} · {fmtUsd(partner.value_usd)}
                  </span>
                )) : <span className="tiny dim">Partner detail not reported</span>}
              </div>
            </Link>
          ))}
        </div>
      ) : mode === 'markets' ? (
        (filtered as Entity[]).map((e) => (
          <Link className="list-item" key={e.slug} to={`/country/${e.slug}`}>
            <span className="flag">{e.iso3 ?? '??'}</span>
            <span className="grow">
              <span className="name">{e.name}</span>
              <span className="tiny dim">
                {e.continent} · {e.agency_name ?? 'source registered'}
              </span>
            </span>
            <span className="dim">›</span>
          </Link>
        ))
      ) : (
        (filtered as RankRow[]).map((r) => (
          <Link className="bar-row" key={r.slug} to={`/country/${r.slug}`} style={{ display: 'block' }}>
            <div className="bar-fill" style={{ width: `${Math.max(3, (r.value_usd / max) * 100)}%` }} />
            <div className="bar-content">
              <span className="rank-badge">{r.rank}</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span style={{ display: 'block', fontWeight: 620, fontSize: 14 }}>{r.name}</span>
                <span className="tiny dim">
                  {r.year} · balance {fmtUsd(r.balance_usd)}
                </span>
              </span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>{fmtUsd(r.value_usd)}</span>
            </div>
          </Link>
        ))
      )}
    </>
  );
}
