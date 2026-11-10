import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';

type Fin = Awaited<ReturnType<typeof api.finance>>;
const fmt = (v: number, unit: string) => (unit === 'percent' ? `${v.toFixed(1)}%` : v >= 1e9 ? `${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}m` : v.toLocaleString());

export default function Finance() {
  const { country = '' } = useParams();
  const [data, setData] = useState<Fin | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    setLoading(true);
    api.finance(country).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [country]);
  if (loading) return <Skeletons n={4} />;
  if (!data || data.institutions.length === 0) return <Empty title="No finance data for this country yet" hint="Institutions and figures are added by the Tereflow team from published reports." />;
  const name = (code: string) => data.institutions.find((i) => i.code === code)?.name ?? code;
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Banks and lenders in {data.country_name}, with figures taken from their published reports and rate cards. Latest period shown: {data.last_period}. Every figure carries its source.
      </p>
      {data.rankings.map((r) => (
        <div key={r.metric_code} style={{ marginBottom: 18 }}>
          <h3 style={{ marginBottom: 6 }}>{r.label} <span className="tiny dim">({r.better === 'lower' ? 'lower ranks first' : 'higher ranks first'})</span></h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>#</th><th>Institution</th><th className="align-right">Value</th><th>Period</th></tr></thead>
              <tbody>
                {r.ranked.map((x) => (
                  <tr key={`${x.institution_code}${x.rate_type ?? ''}`}>
                    <td>{x.rank}</td>
                    <td>{name(x.institution_code)}{x.rate_type ? <span className="tiny dim"> {x.rate_type}</span> : null}</td>
                    <td className="align-right">{fmt(x.value, x.unit)}</td>
                    <td>{x.period}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
      <h3>Institutions</h3>
      {data.institutions.map((i) => (
        <div className="list-item" key={i.code} style={{ display: 'block' }}>
          <span className="name">{i.name}</span> <span className="tiny dim">{i.kind}</span>
          {i.website && <div className="tiny"><a href={i.website} target="_blank" rel="noopener noreferrer">{i.website}</a></div>}
          <div className="tiny dim" style={{ marginTop: 4 }}>
            {i.metrics.length === 0 ? 'No figures yet.' : i.metrics.slice(0, 8).map((m) => `${data.metric_defs.find((d) => d.code === m.metric_code)?.label ?? m.metric_code} ${fmt(m.value, m.unit)} (${m.period})`).join(' · ')}
          </div>
          {i.metrics[0] && <div className="tiny dim">Source: {i.metrics[0].source_note}</div>}
        </div>
      ))}
    </>
  );
}