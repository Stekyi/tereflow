import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api } from '../lib/api';
import { Chips, Empty, Skeletons } from '../components/ui';

type Outlook = Awaited<ReturnType<typeof api.forecast>>;

const usd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}bn` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}m` : `$${Math.round(n / 1e3)}k`);
const pct = (n: number) => `${n >= 0 ? '+' : ''}${Math.round(n * 100)}%`;

export default function OutlookPage() {
  const { country = '' } = useParams();
  const [flow, setFlow] = useState<'X' | 'M'>('X');
  const [data, setData] = useState<Outlook | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    setError('');
    api
      .forecast(country, flow)
      .then(setData)
      .catch((e: unknown) => {
        setData(null);
        setError(e instanceof Error ? e.message : 'Could not load the outlook');
      })
      .finally(() => setLoading(false));
  }, [country, flow]);

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Products most likely to grow by 10% or more next year, from a model trained on past trade and tested
        on a year it had not seen. It is an experiment: use it to decide where to look, not as a promise.
      </p>
      <Chips
        options={[
          { value: 'X', label: 'Exports' },
          { value: 'M', label: 'Imports' },
        ]}
        value={flow}
        onChange={(v) => setFlow(v === 'M' ? 'M' : 'X')}
      />
      <div style={{ height: 14 }} />
      {loading ? (
        <Skeletons n={5} />
      ) : error ? (
        <Empty title={error} hint="Premium members can see this page." />
      ) : !data || data.items.length === 0 ? (
        <Empty title="No outlook for this country yet" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Product</th>
                <th className="align-right">Trade {data.items[0].base_year}</th>
                <th className="align-right">Chance of 10%+ growth</th>
                <th className="align-right">Expected</th>
                <th className="align-right">Likely range</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.hs6}>
                  <td>{i.name} <span className="tiny dim">{i.hs6}</span> <Link className="tiny" to={`/guide?country=${country.toLowerCase()}`}>Guide</Link></td>
                  <td className="align-right">{usd(i.base_value_usd)}</td>
                  <td className="align-right">{Math.round(i.p_grow * 100)}%</td>
                  <td className="align-right">{pct(i.growth_pred)}</td>
                  <td className="align-right">{pct(i.growth_low)} to {pct(i.growth_high)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="tiny dim">{data?.model}</p>
    </>
  );
}