import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';
import { CONTINENTS, fmtUsd, type CountrySummary } from '../../shared/types';

export default function Countries() {
  const [q, setQ] = useState('');
  const [continent, setContinent] = useState<string>('all');
  const [countries, setCountries] = useState<CountrySummary[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    const handle = setTimeout(() => {
      api
        .countries({
          q: q.trim() || undefined,
          continent: continent === 'all' ? undefined : continent,
        })
        .then((r) => setCountries(r.countries))
        .catch(() => setCountries([]))
        .finally(() => setLoading(false));
    }, 200);
    return () => clearTimeout(handle);
  }, [q, continent]);

  const continentOptions = useMemo(
    () => [
      { value: 'all', label: 'All regions' },
      ...CONTINENTS.filter((c) => c !== 'Global').map((c) => ({ value: c, label: c })),
    ],
    [],
  );

  return (
    <>
      <div className="hero tight">
        <h2>Countries on record</h2>
        <p>Summary trade figures for every market. Tap an active country for its full read.</p>
      </div>

      <div className="typeahead">
        <input
          type="search"
          placeholder="Search a country"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
      </div>

      <div style={{ height: 10 }} />
      <Chips options={continentOptions} value={continent} onChange={setContinent} />
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={6} />
      ) : countries.length === 0 ? (
        <Empty title="No countries match" hint="Try a different name or clear the region filter." />
      ) : (
        countries.map((c) => <CountryRow key={c.slug} c={c} />)
      )}
    </>
  );
}

function CountryRow({ c }: { c: CountrySummary }) {
  const body = (
    <>
      <div className="row between" style={{ alignItems: 'center' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          {c.iso3 && <span className="flag">{c.iso3}</span>}
          <span style={{ minWidth: 0 }}>
            <span className="name" style={{ display: 'block' }}>
              {c.name}
            </span>
            <span className="tiny dim">
              {c.continent ?? 'Region not set'}
              {c.year != null ? ` \u00b7 ${c.year}` : ''}
            </span>
          </span>
        </span>
        {c.is_active ? <span className="dim">{'\u203a'}</span> : <span className="badge watch">Not activated yet</span>}
      </div>

      {c.is_active && (
        <div className="country-figs">
          <Fig label="Exports" value={fmtUsd(c.export_usd)} />
          <Fig label="Imports" value={fmtUsd(c.import_usd)} />
          <Fig label="Balance" value={fmtUsd(c.balance_usd)} />
          <Fig label="Top partner" value={c.top_partner ?? 'Not on record'} />
          <Fig label="Openings" value={String(c.opportunities)} />
        </div>
      )}
    </>
  );

  if (!c.is_active) {
    return (
      <div className="card tight" style={{ opacity: 0.55 }}>
        {body}
      </div>
    );
  }

  return (
    <Link className="card tight" to={`/country/${c.slug}`} style={{ display: 'block' }}>
      {body}
    </Link>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="country-fig">
      <span className="tiny dim">{label}</span>
      <span className="num" style={{ fontWeight: 620 }}>
        {value}
      </span>
    </div>
  );
}
