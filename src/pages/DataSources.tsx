import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';

type Data = Awaited<ReturnType<typeof api.freshness>>;
const FLOW = { X: 'Exports', M: 'Imports' } as const;

/** Where each country's data comes from, how often it updates, and how fresh it is. */
export default function DataSources() {
  const [data, setData] = useState<Data | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => { api.freshness().then(setData).catch(() => setFailed(true)); }, []);
  if (failed) return <Empty title="Could not load the data sources" hint="Please try again in a moment." />;
  if (!data) return <Skeletons n={4} />;
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        The yearly backbone is UN Comtrade. {data.comtrade_note} Where a country's own statistics office publishes monthly or quarterly figures and we hold them, they are shown here too, with the change so far this year against the same periods last year.
        {data.recorded_at && <> Last recorded {data.recorded_at} UTC.</>}
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr><th>Country</th><th>Flow</th><th className="align-right">Comtrade, latest year</th><th>National source</th><th>Updates</th><th>Latest period</th><th className="align-right">Year to date</th></tr>
          </thead>
          <tbody>
            {data.countries.flatMap((c) =>
              c.flows.map((f, i) => (
                <tr key={`${c.iso3}${f.flow}`}>
                  <td>{i === 0 ? <Link to={`/country/${c.name.toLowerCase().replace(/[^a-z]+/g, '-')}`}>{c.name}</Link> : ''}</td>
                  <td>{FLOW[f.flow as 'X' | 'M']}</td>
                  <td className="align-right">{f.comtrade_latest_year ?? 'none yet'}</td>
                  <td>{i === 0 ? (c.national_source ? (c.national_source.url ? <a href={c.national_source.url} target="_blank" rel="noopener noreferrer">{c.national_source.name}</a> : c.national_source.name) : <span className="dim">none held</span>) : ''}</td>
                  <td>{i === 0 ? (c.national_source?.frequency ?? 'yearly (Comtrade)') : ''}</td>
                  <td>{f.national_latest_period ?? <span className="dim">not held</span>}</td>
                  <td className="align-right">{f.national_ytd ? `${f.national_ytd.pct >= 0 ? '+' : ''}${f.national_ytd.pct}% (${f.national_ytd.periods} periods)` : <span className="dim">n/a</span>}</td>
                </tr>
              )),
            )}
          </tbody>
        </table>
      </div>
      <p className="tiny dim">Year to date is shown only when this year and last year cover exactly the same periods, so the two totals are comparable.</p>
    </>
  );
}