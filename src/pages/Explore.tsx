import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { fmtUsd, type Entity } from '../../shared/types';

type Mode = 'markets' | 'export' | 'import';

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
  const [mode, setMode] = useState<Mode>('markets');
  const [continent, setContinent] = useState('');
  const [q, setQ] = useState('');
  const [entities, setEntities] = useState<Entity[]>([]);
  const [ranks, setRanks] = useState<RankRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    if (mode === 'markets') {
      api
        .entities({ kind: 'country' })
        .then((r) => setEntities(r.entities))
        .catch(() => setEntities([]))
        .finally(() => setLoading(false));
    } else {
      api
        .rankings(mode)
        .then((r) => setRanks(r.rows))
        .catch(() => setRanks([]))
        .finally(() => setLoading(false));
    }
  }, [mode]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const match = (name: string, iso: string | null, cont: string | null) =>
      (!continent || cont === continent) &&
      (!needle || name.toLowerCase().includes(needle) || (iso ?? '').toLowerCase().includes(needle));

    if (mode === 'markets') return entities.filter((e) => match(e.name, e.iso3, e.continent));
    return ranks.filter((r) => match(r.name, r.iso3, r.continent));
  }, [mode, entities, ranks, q, continent]);

  const max = mode === 'markets' ? 0 : Math.max(...(filtered as RankRow[]).map((r) => r.value_usd), 1);

  return (
    <>
      <input
        type="search"
        placeholder="Search a country or ISO code"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <Chips
        options={[
          { value: 'markets' as Mode, label: 'All markets' },
          { value: 'export' as Mode, label: 'Biggest exporters' },
          { value: 'import' as Mode, label: 'Biggest importers' },
        ]}
        value={mode}
        onChange={setMode}
      />

      <div style={{ height: 8 }} />

      <Chips options={CONTINENT_OPTIONS} value={continent} onChange={setContinent} />

      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={6} />
      ) : filtered.length === 0 ? (
        <Empty
          title="Nothing matches"
          hint={
            mode === 'markets'
              ? 'Only activated countries appear here. Tick more in Admin.'
              : 'Rankings only include countries that have completed an analysis run.'
          }
        />
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
