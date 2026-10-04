import { useEffect, useMemo, useState } from 'react';
import { api, type TradeNewsPayload } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';

function ago(iso: string): string {
  const t = Date.parse(iso);
  if (!t) return '';
  const h = Math.max(0, Math.round((Date.now() - t) / 3600000));
  if (h < 1) return 'just now';
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export default function TradeNews() {
  const [data, setData] = useState<TradeNewsPayload | null>(null);
  const [failed, setFailed] = useState(false);
  const [scope, setScope] = useState('all');
  const [country, setCountry] = useState('');

  useEffect(() => {
    api.tradeNews().then(setData).catch(() => setFailed(true));
  }, []);

  const items = useMemo(() => {
    if (!data) return [];
    return data.items.filter((i) => {
      if (country) return i.countries.includes(country);
      if (scope === 'global') return i.scope === 'global';
      if (scope === 'country') return i.scope === 'country';
      return true;
    });
  }, [data, scope, country]);

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Trade stories from around the world, gathered by Ananse News and refreshed every 12 hours.
        Each one opens at its original publisher.
      </p>

      <Chips
        options={[
          { value: 'all', label: 'All' },
          { value: 'global', label: 'Global' },
          { value: 'country', label: 'By country' },
        ]}
        value={country ? 'country' : scope}
        onChange={(v) => {
          setCountry('');
          setScope(v);
        }}
      />

      {data && data.countries.length > 0 && (scope === 'country' || country) && (
        <div style={{ marginTop: 10 }}>
          <Chips
            options={[{ value: '', label: 'Any country' }, ...data.countries.map((c) => ({ value: c.name, label: `${c.name} (${c.count})` }))]}
            value={country}
            onChange={setCountry}
          />
        </div>
      )}
      <div style={{ height: 14 }} />

      {failed ? (
        <Empty title="Trade news is not available right now" hint="Try again in a few minutes." />
      ) : !data ? (
        <Skeletons n={6} />
      ) : items.length === 0 ? (
        <Empty title="Nothing here yet" hint="Try another filter." />
      ) : (
        items.map((i) => (
          <a className="list-item" key={i.link} href={i.link} target="_blank" rel="noopener noreferrer">
            <div style={{ minWidth: 0 }}>
              <div className="small dim">
                {i.scope === 'global' ? 'Global' : i.countries.join(', ')} · {i.topic}
              </div>
              <div style={{ fontWeight: 600, margin: '2px 0 4px' }}>{i.title}</div>
              {i.summary && <div className="small dim">{i.summary}</div>}
              <div className="small dim" style={{ marginTop: 4 }}>
                {i.source} · {ago(i.published)}
              </div>
            </div>
          </a>
        ))
      )}
    </>
  );
}
