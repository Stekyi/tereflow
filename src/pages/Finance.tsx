import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useSession } from '../lib/auth';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useStageScroll } from '../lib/useStageScroll';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';

type Fin = Awaited<ReturnType<typeof api.finance>>;
const fmt = (v: number, unit: string, currency?: string | null) => (unit === 'percent' ? `${v.toFixed(2).replace(/\.?0+$/, '')}%` : unit === 'count' ? String(v) : `${currency ? currency + ' ' : ''}${v >= 1e9 ? `${(v / 1e9).toFixed(1)}bn` : v >= 1e6 ? `${(v / 1e6).toFixed(1)}m` : v.toLocaleString()}`);
const STAGES = [
  { key: 'data', label: 'Data', sub: 'What the banks publish' },
  { key: 'insight', label: 'Insight', sub: 'What it means' },
  { key: 'action', label: 'Action', sub: 'What to do next' },
] as const;
/** The figures shown for each bank, in this order. Anything a bank has not published is simply not shown. */
const BANK_ROWS = ['TOTAL_ASSETS', 'CASH_BALANCE', 'INVESTMENT_SECURITIES', 'TOTAL_LOANS', 'TOTAL_DEPOSITS', 'TOTAL_LIABILITIES', 'TOTAL_EQUITY', 'OPERATING_INCOME', 'PROFIT_BEFORE_TAX', 'PROFIT_AFTER_TAX', 'CAPITAL_ADEQUACY', 'NPL_RATIO', 'RETURN_ON_EQUITY', 'RETURN_ON_ASSETS', 'COST_TO_INCOME', 'BRANCH_COUNT', 'DEPOSIT_RATE_AVG', 'SAVINGS_RATE', 'TERM_SAVINGS_RATE', 'REFERENCE_RATE'];
const LINE_COLOURS = ['#0f9d58', '#6d3fd1', '#e8710a', '#1a73e8', '#c5221f'];
const trendLabel = new Set(['TOTAL_DEPOSITS', 'PROFIT_AFTER_TAX', 'CASH_BALANCE', 'TOTAL_ASSETS']);

/** A trend chart for one measure: one line per bank across the years held. */
function TrendChart({ t }: { t: NonNullable<Fin>['trends'][number] }) {
  const years = [...new Set(t.banks.flatMap((b) => b.points.map((p) => p.period)))].sort();
  const rows = years.map((y) => ({ year: y, ...Object.fromEntries(t.banks.map((b) => [b.name.replace(/ (PLC|Limited|Ltd)$/i, ''), (b.points.find((p) => p.period === y)?.value ?? null) as number | null])) }));
  const names = t.banks.map((b) => b.name.replace(/ (PLC|Limited|Ltd)$/i, ''));
  return (
    <div style={{ width: '100%', height: 240 }}>
      <ResponsiveContainer>
        <LineChart data={rows} margin={{ top: 8, right: 16, bottom: 0, left: 8 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e6e9f0" />
          <XAxis dataKey="year" tick={{ fontSize: 12 }} />
          <YAxis tick={{ fontSize: 12 }} tickFormatter={(v: number) => (v >= 1e9 ? `${(v / 1e9).toFixed(0)}bn` : `${(v / 1e6).toFixed(0)}m`)} width={52} />
          <Tooltip formatter={(v: number) => fmt(v, 'currency', 'GHS')} />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {names.map((n, i) => <Line key={n} type="monotone" dataKey={n} stroke={LINE_COLOURS[i % LINE_COLOURS.length]} strokeWidth={2} connectNulls dot />)}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/** Finance landing: the countries that have institutions on record. */
export function FinanceIndex() {
  const [rows, setRows] = useState<Awaited<ReturnType<typeof api.financeCountries>>['countries'] | null>(null);
  useEffect(() => { api.financeCountries().then((r) => setRows(r.countries)).catch(() => setRows([])); }, []);
  if (!rows) return <Skeletons n={3} />;
  if (rows.length === 0) return <Empty title="No finance data yet" hint="Banks and lenders are added by the Tereflow team from their published reports." />;
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>Banks and lenders by country, with published figures and rate cards. Pick a country to compare institutions.</p>
      {rows.map((r) => (
        <a className="list-item" key={r.country_iso3} href={`/finance/${r.country_iso3}`}>
          <span className="name">{r.country_name}</span>
          <span className="tiny dim">{r.institutions} institution{r.institutions === 1 ? '' : 's'}</span>
        </a>
      ))}
    </>
  );
}

export default function Finance() {
  const { country = '' } = useParams();
  const { entitled } = useSession();
  const [data, setData] = useState<Fin | null>(null);
  const [loading, setLoading] = useState(true);
  const [stage, setStage] = useState<'data' | 'insight' | 'action'>('data');
  useStageScroll(stage);
  useEffect(() => {
    setLoading(true);
    api.finance(country).then(setData).catch(() => setData(null)).finally(() => setLoading(false));
  }, [country]);
  if (loading) return <Skeletons n={4} />;
  if (!data || data.institutions.length === 0) return <Empty title="No finance data for this country yet" hint="Institutions and figures are added by the Tereflow team from published reports." />;
  const label = (code: string) => data.metric_defs.find((d) => d.code === code)?.label ?? code;
  const val = (m: { metric_code: string }[] | undefined, code: string) => (m ?? []).find((x) => x.metric_code === code) as (typeof data.institutions)[number]['metrics'][number] | undefined;
  const bankMetric = (i: (typeof data.institutions)[number], code: string) => i.metrics.filter((m) => m.metric_code === code).sort((a, b) => (a.period < b.period ? 1 : -1))[0];
  const name = (code: string) => data.institutions.find((i) => i.code === code)?.name ?? code;
  const sectorRows = data.sector?.metrics ?? [];
  const next = (to: 'insight' | 'action') => setStage(to);
  const slug = encodeURIComponent(data.country_slug ?? country.toLowerCase());

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Banks in {data.country_name}, from the figures they and the central bank have published. Every figure carries its source. Latest period held: {data.last_period}.
      </p>
      <div className="stage-steps" role="tablist" aria-label="Data, insight, action">
        {STAGES.map((st, i) => (
          <button key={st.key} type="button" role="tab" aria-selected={stage === st.key} className={`stage-step${stage === st.key ? ' on' : ''}`} onClick={() => setStage(st.key)}>
            <span className="stage-num">{i + 1}</span>
            <span className="stage-text"><strong>{st.label}</strong><small>{st.sub}</small></span>
          </button>
        ))}
      </div>

      {stage === 'data' && (
        <>
          <h3 style={{ marginBottom: 6 }}>Banks, side by side</h3>
          <div className="table-wrap">
            <table className="data-table">
              <thead><tr><th>Figure</th>{data.institutions.map((i) => <th key={i.code} className="align-right">{i.name.replace(/ (PLC|Limited|Ltd)$/i, '')}</th>)}</tr></thead>
              <tbody>
                {BANK_ROWS.map((code) => {
                  const cells = data.institutions.map((i) => bankMetric(i, code));
                  if (cells.every((c) => !c)) return null;
                  return (
                    <tr key={code}>
                      <td>{label(code)}</td>
                      {cells.map((c, k) => <td key={k} className="align-right" title={c?.source_note}>{c ? <>{fmt(c.value, c.unit, c.currency)} <span className="tiny dim">{c.period}</span></> : <span className="dim">not held</span>}</td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="tiny dim">Hover a figure to see the document it came from. Group figures are used where a bank publishes both group and bank-only statements. Money is in Ghana cedis.</p>

          {data.sector && (
            <>
              <h3 style={{ marginBottom: 6 }}>The whole banking sector</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Figure</th><th className="align-right">Latest</th></tr></thead>
                  <tbody>
                    {['TOTAL_ASSETS', 'TOTAL_LOANS', 'TOTAL_DEPOSITS', 'CAPITAL_ADEQUACY', 'NPL_RATIO', 'RETURN_ON_EQUITY', 'RETURN_ON_ASSETS', 'COST_TO_INCOME', 'LENDING_RATE', 'REFERENCE_RATE', 'DEPOSIT_RATE'].map((code) => {
                      const rows = sectorRows.filter((m) => m.metric_code === code);
                      const cur = rows.sort((a, b) => (a.period < b.period ? 1 : -1))[0];
                      if (!cur) return null;
                      return <tr key={code}><td>{label(code)}</td><td className="align-right" title={cur.source_note}>{fmt(cur.value, cur.unit, cur.currency)} <span className="tiny dim">{cur.period}</span></td><td className="align-right dim">{(data.sector!.metrics.find((m) => m.metric_code === code && m.period !== cur.period) ? '' : '')}</td></tr>;
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}
          {(data.depositor.sector.length > 0 || data.depositor.investment.length > 0) && (
            <>
              <h3 style={{ marginBottom: 6 }}>Deposit and investment rates</h3>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Rate</th><th className="align-right">Value</th></tr></thead>
                  <tbody>
                    {[...data.depositor.sector, ...data.depositor.investment].map((r) => (
                      <tr key={r.label}><td>{r.label}</td><td className="align-right" title={r.source_note}>{fmt(r.value, 'percent')} <span className="tiny dim">{r.period}</span></td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny dim">Sector averages and Treasury bill yields are published by the Bank of Ghana. Rates a single bank has published are in the bank table above. Banks that have not published a rate show "not held".</p>
            </>
          )}
          {data.central_bank && val(data.central_bank.metrics, 'POLICY_RATE') && (
            <p className="small">
              {data.central_bank.name} policy rate: <strong>{fmt(val(data.central_bank.metrics, 'POLICY_RATE')!.value, 'percent')}</strong> ({val(data.central_bank.metrics, 'POLICY_RATE')!.period}).
            </p>
          )}
          <div className="stage-nav"><button type="button" className="btn primary" onClick={() => next('insight')}>Next: what it means {'\u203a'}</button></div>
        </>
      )}

      {stage === 'insight' && (
        <>
          {data.scorecard.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-title">Scorecard: who is doing well, measure by measure ({data.year})</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Measure</th><th>Best</th><th>Next</th><th>Next</th></tr></thead>
                  <tbody>
                    {data.scorecard.map((sc) => (
                      <tr key={sc.id} title={sc.basis}>
                        <td>{sc.title}</td>
                        {[0, 1, 2].map((k) => <td key={k}>{sc.ranked[k] ? <>{sc.ranked[k].name.replace(/ (PLC|Limited|Ltd)$/i, '')} <strong>{sc.ranked[k].display}</strong></> : ''}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="tiny dim" style={{ marginBottom: 0 }}>Hover a measure to see what it means. Figures are as each bank declared them; some banks publish group figures and others bank-only. This is information, not advice: each bank suits different needs.</p>
            </div>
          )}
          {data.trends.filter((t) => trendLabel.has(t.metric_code)).map((t) => (
            <div className="card" key={t.metric_code} style={{ marginBottom: 12 }}>
              <p className="card-title">Trend: {t.label}</p>
              <TrendChart t={t} />
              <div className="table-wrap" style={{ marginTop: 8 }}>
                <table className="data-table">
                  <thead><tr><th>Bank</th>{[...new Set(t.banks.flatMap((b) => b.points.map((p) => p.period)))].sort().map((y) => <th key={y} className="align-right">{y}</th>)}</tr></thead>
                  <tbody>
                    {t.banks.map((b) => (
                      <tr key={b.code}>
                        <td>{b.name.replace(/ (PLC|Limited|Ltd)$/i, '')}</td>
                        {[...new Set(t.banks.flatMap((x) => x.points.map((p) => p.period)))].sort().map((y) => {
                          const p = b.points.find((q) => q.period === y);
                          return <td key={y} className="align-right" title={p?.source_note}>{p ? <>{fmt(p.value, 'currency', 'GHS')}{p.change_pct != null && <span className={p.change_pct >= 0 ? 'tiny' : 'tiny down'} style={{ marginLeft: 6 }}>{p.change_pct >= 0 ? '+' : ''}{p.change_pct}%</span>}</> : <span className="dim">not held</span>}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
          {data.insights.map((i) => (
            <div className="card" key={i.id} style={{ marginBottom: 12 }}>
              <p className="card-title">{i.title}</p>
              <p style={{ margin: 0 }}>{i.text}</p>
              <details style={{ marginTop: 8 }}>
                <summary className="tiny dim">Where this comes from</summary>
                <ul className="tiny dim" style={{ margin: '6px 0 0', paddingLeft: 18 }}>{[...new Set(i.evidence)].map((e) => <li key={e}>{e}</li>)}</ul>
              </details>
            </div>
          ))}
          {data.fees.length > 0 && (
            <div className="card" style={{ marginBottom: 12 }}>
              <p className="card-title">Published trade finance fees</p>
              <div className="table-wrap">
                <table className="data-table">
                  <thead><tr><th>Service</th><th>Bank</th><th className="align-right">Fee</th></tr></thead>
                  <tbody>{data.fees.flatMap((f) => f.rows.map((r) => <tr key={f.metric_code + r.institution_code}><td>{f.label}</td><td>{r.name}</td><td className="align-right" title={r.source_note}>{fmt(r.value, 'percent')} <span className="tiny dim">{r.period}</span></td></tr>))}</tbody>
                </table>
              </div>
              <p className="tiny dim" style={{ marginBottom: 0 }}>Minimum and maximum amounts in US dollars also apply: see the bank's tariff. Only banks whose tariff we hold are listed.</p>
            </div>
          )}
          {data.rankings.filter((r) => r.ranked.length > 1).map((r) => (
            <div key={r.metric_code} style={{ marginBottom: 14 }}>
              <h3 style={{ marginBottom: 6 }}>{r.label} <span className="tiny dim">({r.better === 'lower' ? 'lower ranks first' : 'higher ranks first'})</span></h3>
              <div className="table-wrap"><table className="data-table"><thead><tr><th>#</th><th>Bank</th><th className="align-right">Value</th><th>Period</th></tr></thead>
                <tbody>{r.ranked.map((x) => <tr key={x.institution_code + (x.rate_type ?? '')}><td>{x.rank}</td><td>{name(x.institution_code)}</td><td className="align-right">{fmt(x.value, x.unit)}</td><td>{x.period}</td></tr>)}</tbody></table></div>
            </div>
          ))}
          <div className="stage-nav">
            <button type="button" className="btn" onClick={() => setStage('data')}>{'\u2039'} Back</button>
            <button type="button" className="btn primary" onClick={() => next('action')}>Next: what to do {'\u203a'}</button>
          </div>
        </>
      )}

      {stage === 'action' && (
        <div className="action-stage">
          <p className="small dim" style={{ margin: '0 0 8px' }}>You have seen what the banks publish and what it means. Now use it.</p>
          <ol className="action-list">
            {[
              { to: `/canvas?country=${slug}`, title: 'Put the cost of finance into your Business Model Canvas', text: entitled ? 'Cost of borrowing and trade finance fees belong in the Cost Structure block.' : 'Premium. Cost of borrowing and trade finance fees belong in the Cost Structure block.' },
              { to: `/guide?country=${slug}`, title: 'Run the Guide for a product you want to trade', text: 'Find the problem in the trade, then the questions to ask and the plays to try.' },
              { to: `/network?q=${encodeURIComponent('finance')}`, title: 'Find people who have financed trade here', text: 'Message traders and advisers in the Network.' },
              { to: '/data-sources', title: 'Check how fresh this data is', text: 'See where each figure comes from and when it was last updated.' },
            ].map((st, i) => (
              <li key={st.title}><Link className="action-card" to={st.to}><span className="action-num">{i + 1}</span><span className="action-body"><strong>{st.title}</strong><span className="tiny dim">{st.text}</span></span><span aria-hidden>{'\u203a'}</span></Link></li>
            ))}
          </ol>
          <h3 style={{ marginTop: 16 }}>Bank websites</h3>
          <ul className="small">{data.institutions.filter((i) => i.website).map((i) => <li key={i.code}><a href={i.website!} target="_blank" rel="noopener noreferrer">{i.name}</a></li>)}{data.central_bank?.website && <li><a href={data.central_bank.website} target="_blank" rel="noopener noreferrer">{data.central_bank.name}</a></li>}</ul>
          <div className="stage-nav"><button type="button" className="btn" onClick={() => setStage('insight')}>{'\u2039'} Back</button></div>
        </div>
      )}
    </>
  );
}
