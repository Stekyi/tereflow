import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';
import SectionNav from '../components/SectionNav';
import type { CountryDashboard } from '../../shared/types';
import type { CreditCountry, CreditCountryRow, CreditHistory, CreditPoint, CreditSectorMap, CreditSectorRow, CreditSeriesMeta, CreditSourceKey, CreditSummary } from '../lib/credit-types';

type Dash = (CountryDashboard & { inactive?: boolean }) | null;

// ---------------------------------------------------------------------------------------------------------------
// Formatting. Values arrive in millions of the stated currency.
// ---------------------------------------------------------------------------------------------------------------

const MONTH = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function periodLabel(p: string | null | undefined): string {
  if (!p) return 'n/a';
  const m = /^(\d{4})-(\d{2})$/.exec(p);
  if (m) return `${MONTH[Number(m[2]) - 1]} ${m[1]}`;
  const q = /^(\d{4})-(Q[1-4])$/.exec(p);
  if (q) return `${q[2]} ${q[1]}`;
  return p;
}

const ccyOf = (unit: string) => unit.split(' million')[0] || 'local currency';

function money(m: number | null | undefined, ccy: string): string {
  if (m == null) return 'n/a';
  const a = Math.abs(m);
  if (a >= 1_000_000) return `${ccy} ${(m / 1_000_000).toFixed(2)} tn`;
  if (a >= 1000) return `${ccy} ${(m / 1000).toFixed(1)} bn`;
  return `${ccy} ${m.toFixed(1)} m`;
}
const exact = (m: number | null | undefined, ccy: string) => (m == null ? 'n/a' : `${ccy} ${m.toLocaleString(undefined, { maximumFractionDigits: 1 })} million`);
const sign = (m: number | null | undefined, ccy: string) => (m == null ? 'n/a' : `${m > 0 ? '+' : m < 0 ? '-' : ''}${money(Math.abs(m), ccy).replace(`${ccy} `, '')}`);
const pctTxt = (p: number | null | undefined, d = 1) => (p == null ? 'n/a' : `${p > 0 ? '+' : ''}${p.toFixed(d)}%`);
const tone = (n: number | null | undefined) => (n == null || n === 0 ? 'var(--muted)' : n > 0 ? 'var(--up)' : 'var(--down)');
const usd = (v: number) => (v >= 1e9 ? `USD ${(v / 1e9).toFixed(2)}bn` : v >= 1e6 ? `USD ${(v / 1e6).toFixed(1)}m` : `USD ${Math.round(v).toLocaleString()}`);
const FREQ_NAME = { M: 'Monthly', Q: 'Quarterly', A: 'Annual' } as const;

function kindLabel(kind: string, basis: string | null): { text: string; cls: string; hint: string } {
  if (kind === 'stock' && basis === 'source_definition') return { text: 'Stock (per source definition)', cls: 'on', hint: 'The source defines this series as a balance-sheet position.' };
  if (kind === 'stock' && basis === 'admin') return { text: 'Stock (confirmed by an administrator)', cls: 'on', hint: 'An administrator confirmed this is an outstanding balance.' };
  if (kind === 'stock') return { text: 'Stock (inferred, not stated by the source)', cls: 'warning', hint: 'The source does not say whether this is a stock. It behaves like a carried-forward balance and its sectors add up to the total, so it is treated as a stock until the source confirms.' };
  if (kind === 'flow') return { text: 'Flow', cls: 'notice', hint: 'A flow over the period, not an outstanding balance.' };
  return { text: 'Unverified', cls: 'error', hint: 'Not established as a stock or a flow, so no net change is claimed.' };
}

// ---------------------------------------------------------------------------------------------------------------
// Time windows and aggregation (display only; the stored data stays at the source frequency)
// ---------------------------------------------------------------------------------------------------------------

type RangeKey = 'all' | '10y' | '5y' | '3y' | '12m' | 'custom';
const RANGES: { k: RangeKey; label: string; months?: number }[] = [
  { k: 'all', label: 'Full history' }, { k: '10y', label: 'Last 10 years', months: 120 }, { k: '5y', label: 'Last 5 years', months: 60 },
  { k: '3y', label: 'Last 3 years', months: 36 }, { k: '12m', label: 'Last 12 months', months: 12 }, { k: 'custom', label: 'Custom' },
];
type AggMode = 'native' | 'quarter' | 'year';

function shiftIso(iso: string, months: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() - months);
  return d.toISOString().slice(0, 10);
}

/** Quarter-end or year-end view of a monthly stock: the stock is the observation at that date (never a sum of balances). */
function aggregate(pts: CreditPoint[], mode: AggMode, freq: string): CreditPoint[] {
  if (mode === 'native' || freq !== 'M') return pts;
  const keep = pts.filter((p) => /^\d{4}-\d{2}$/.test(p.period) && (mode === 'quarter' ? [3, 6, 9, 12].includes(Number(p.period.slice(5))) : p.period.endsWith('-12')));
  const step = mode === 'quarter' ? 3 : 12;
  return keep.map((p, i) => {
    const prev = i > 0 ? keep[i - 1] : null;
    const gap = prev ? (Number(p.period.slice(0, 4)) - Number(prev.period.slice(0, 4))) * 12 + Number(p.period.slice(5)) - Number(prev.period.slice(5)) : 0;
    const ok = prev && gap === step && prev.stock != null && p.stock != null;
    const net = ok ? (p.stock as number) - (prev!.stock as number) : null;
    return { ...p, prev_stock: ok ? prev!.stock : null, net_change: net, pct_change: ok && (prev!.stock as number) > 0 ? (net! / (prev!.stock as number)) * 100 : null };
  });
}

// ---------------------------------------------------------------------------------------------------------------
// Landing
// ---------------------------------------------------------------------------------------------------------------

const STATUS_TEXT: Record<string, string> = {
  both: 'National and IMF data',
  national: 'National sector data',
  imf: 'IMF borrower sectors',
  partial: 'Partial IMF data',
  none: 'No suitable credit data',
};

export function CreditIndex() {
  const [rows, setRows] = useState<CreditCountryRow[] | null>(null);
  useEffect(() => { api.credit.countries().then((r) => setRows(r.countries)).catch(() => setRows([])); }, []);
  if (!rows) return <Skeletons n={3} />;
  if (rows.length === 0) return <Empty title="No credit data yet" hint="Sectoral credit data appears once the pipeline has run." />;
  const have = rows.filter((r) => r.in_use);
  const none = rows.filter((r) => !r.in_use);
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Where bank credit is outstanding across the economy, and how it is changing. Pick a country to see credit by sector, how each sector's balance has moved over time, and what trade and business activity sits behind it.
      </p>
      {have.map((r) => (
        <Link className="list-item" key={r.country_iso3} to={`/finance/${r.country_iso3}`}>
          <span className="name">{r.country_name}</span>
          <span className="tiny dim">{STATUS_TEXT[r.status ?? ''] ?? 'Awaiting first run'}</span>
        </Link>
      ))}
      {none.length > 0 && (
        <>
          <h3 style={{ marginBottom: 6 }}>No suitable data found yet</h3>
          <p className="tiny dim" style={{ marginTop: 0 }}>For these countries the IMF has no matching borrower-sector series and no national source is configured, or the first run has not happened. Nothing is estimated.</p>
          {none.map((r) => (
            <Link className="list-item" key={r.country_iso3} to={`/finance/${r.country_iso3}`}>
              <span className="name">{r.country_name}</span>
              <span className="tiny dim">{r.status === 'none' ? 'Not available' : 'Awaiting first run'}</span>
            </Link>
          ))}
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Country page
// ---------------------------------------------------------------------------------------------------------------

export default function CreditCountryPage() {
  const { country = '' } = useParams();
  const iso = country.toUpperCase();
  const [data, setData] = useState<CreditCountry | null>(null);
  const [err, setErr] = useState('');
  const [src, setSrc] = useState<CreditSourceKey | null>(null);
  const [sel, setSel] = useState<string | null>(null);
  const [hist, setHist] = useState<Record<string, CreditHistory>>({});
  const [dash, setDash] = useState<Dash>(null);
  const [bankIso, setBankIso] = useState<Set<string>>(new Set());
  const detailRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setData(null); setErr(''); setSel(null); setHist({});
    api.credit.country(iso).then((d) => { setData(d); setSrc(d.primary); }).catch((e: Error) => setErr(e.message));
    api.financeCountries().then((r) => setBankIso(new Set(r.countries.map((c) => c.country_iso3)))).catch(() => undefined);
  }, [iso]);

  const summary: CreditSummary | null = data && src ? (data.summaries[src] ?? null) : null;
  const sectors = useMemo(() => summary?.sectors ?? [], [summary]);

  // Start on the sector with the largest net increase, or the largest balance when nothing moved.
  useEffect(() => {
    if (!summary) return;
    setSel((cur) => (cur && sectors.some((s) => s.series_id === cur) ? cur : (summary.top_gainers[0] ?? sectors[0]?.series_id ?? null)));
  }, [summary, sectors]);

  useEffect(() => {
    if (!sel || hist[sel]) return;
    api.credit.history(iso, sel).then((h) => setHist((m) => ({ ...m, [sel]: h }))).catch(() => undefined);
  }, [sel, iso, hist]);

  const slug = data?.country.slug ?? null;
  const selMap = data && sel ? data.sector_map[sectors.find((s) => s.series_id === sel)?.sector_key ?? ''] : undefined;
  useEffect(() => {
    if (!slug || dash || !selMap || selMap.trade_scope === 'none') return;
    api.dashboard(slug).then((d) => setDash(d as Dash)).catch(() => setDash(null));
  }, [slug, selMap, dash]);

  function pick(id: string, scroll = true) {
    setSel(id);
    if (scroll) setTimeout(() => document.getElementById('sector')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  }

  if (err) return <Empty title="No credit data for this country" hint={err} />;
  if (!data) return <Skeletons n={4} />;

  const noData = !data.primary || !summary;
  const name = data.country.name;
  const links = [
    { id: 'overview', label: 'Overview' }, { id: 'ranking', label: 'Sector ranking' }, { id: 'sector', label: 'Sector detail' },
    { id: 'diagram', label: 'System diagram' }, { id: 'method', label: 'Method and coverage' },
  ];

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Where the banking system's credit is outstanding in {name}, how each sector's balance has changed, and what that may mean for trade and business. Every figure is a published observation or a calculation from published observations.
      </p>

      <SourceBanner data={data} src={src} setSrc={setSrc} />

      {noData ? (
        <Empty title="No sector credit data yet" hint={data.source.status_note ?? 'Nothing suitable has been published for this country, so nothing is shown. No figures are estimated.'} />
      ) : (
        <>
          <SectionNav sections={links} />
          <section id="overview" className="section-anchor cr-section"><Overview s={summary} /></section>
          <section id="ranking" className="section-anchor cr-section"><RankingTable s={summary} sel={sel} onPick={pick} /></section>
          <section id="sector" className="section-anchor cr-section" ref={detailRef as React.RefObject<HTMLElement>}>
            <SectorDetail data={data} s={summary} sel={sel} onSel={(id) => pick(id, false)} h={sel ? hist[sel] : undefined} map={selMap} dash={dash} />
          </section>
          <section id="diagram" className="section-anchor cr-section"><SystemDiagram data={data} s={summary} sel={sel} onPick={pick} /></section>
          <section id="method" className="section-anchor cr-section"><Method data={data} s={summary} src={src!} hist={sel ? hist[sel] : undefined} hasBanks={bankIso.has(iso)} /></section>
        </>
      )}
      {noData && bankIso.has(iso) && <p className="small"><Link to={`/finance/${iso}/banks`}>Bank by bank published figures (earlier view)</Link></p>}
    </>
  );
}

function SourceBanner({ data, src, setSrc }: { data: CreditCountry; src: CreditSourceKey | null; setSrc: (s: CreditSourceKey) => void }) {
  const both = Boolean(data.summaries.BOG && data.summaries.IMF);
  const s = data.source;
  return (
    <div style={{ marginBottom: 12 }}>
      {both && (
        <div className="chips" role="tablist" aria-label="Data source" style={{ marginBottom: 8 }}>
          <button type="button" className={`chip${src === 'BOG' ? ' active' : ''}`} onClick={() => setSrc('BOG')}>National source: by industry</button>
          <button type="button" className={`chip${src === 'IMF' ? ' active' : ''}`} onClick={() => setSrc('IMF')}>IMF: borrower sectors only</button>
        </div>
      )}
      <div className={`callout ${s.status === 'imf' || s.status === 'partial' ? 'warn' : s.status === 'none' ? 'bad' : ''}`}>
        <span className="callout-title">{STATUS_TEXT[s.status ?? ''] ?? 'Data status'}. </span>
        {src === 'IMF' && s.status !== 'none' ? 'Showing IMF figures. They are broad borrower categories, not industries, and are kept separate from any national series. ' : ''}
        {s.status_note}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// A. Overview
// ---------------------------------------------------------------------------------------------------------------

function Overview({ s }: { s: CreditSummary }) {
  const ccy = ccyOf(s.unit);
  const t = s.total;
  const byId = new Map(s.sectors.map((x) => [x.series_id, x]));
  const biggest = s.sectors.slice(0, 3);
  const gain = s.top_gainers.map((i) => byId.get(i)).filter(Boolean) as CreditSectorRow[];
  const lose = s.top_losers.map((i) => byId.get(i)).filter(Boolean) as CreditSectorRow[];
  const [range, setRange] = useState<RangeKey>('all');
  const pts = useMemo(() => {
    const h = t.history ?? [];
    if (!h.length) return [];
    const last = h[h.length - 1][0];
    const months = RANGES.find((r) => r.k === range)?.months;
    if (!months || !/^\d{4}-\d{2}$/.test(last)) return h.map(([p, v]) => ({ period: p, stock: v }));
    const cut = shiftIso(`${last}-01`, months).slice(0, 7);
    return h.filter(([p]) => p >= cut).map(([p, v]) => ({ period: p, stock: v }));
  }, [t.history, range]);
  return (
    <>
      <h3 style={{ marginBottom: 6 }}>Market overview</h3>
      <div className="portal-tiles">
        <div className="stat">
          <div className="label">Total outstanding credit</div>
          <div className="value" title={t.valid ? exact(t.stock, ccy) : ''}>{t.valid ? money(t.stock, ccy) : 'Not shown'}</div>
          <div className="tiny dim">{t.valid ? `${periodLabel(t.period)}, ${s.unit}` : (t.reason ?? 'No valid total')}</div>
        </div>
        <div className="stat">
          <div className="label">Net change, latest period</div>
          <div className="value" style={{ color: tone(t.net_change) }}>{t.valid ? sign(t.net_change, ccy) : 'n/a'}</div>
          <div className="tiny dim">{t.valid ? `${pctTxt(t.pct_change)} on the previous period` : 'Needs a valid total'}</div>
        </div>
        <div className="stat">
          <div className="label">Latest common period</div>
          <div className="value">{periodLabel(s.common_period)}</div>
          <div className="tiny dim">{FREQ_NAME[s.frequency ?? 'M']} data, all sectors at the same date</div>
        </div>
        <div className="stat">
          <div className="label">Sectors covered</div>
          <div className="value">{s.sector_count}</div>
          <div className="tiny dim">{s.source_key === 'IMF' ? 'IMF borrower categories' : 'Industries and trade activities'}</div>
        </div>
      </div>

      <div className="callout" style={{ marginTop: 10 }}>
        <span className="callout-title">How to read this. </span>
        Outstanding credit is the balance still owed to banks at a date, including credit issued in earlier periods. The change between two dates is the <strong>net change in outstanding credit</strong>: new lending minus repayments and write-offs, plus any reclassifications. It does not show gross lending or repayments separately, and it is not the money supply.
      </div>

      <div className="cr-grid">
        <div className="card">
          <p className="card-title">Largest sectors by outstanding credit</p>
          {biggest.map((r) => (
            <div className="cr-line" key={r.series_id}><span>{r.rank_stock}. {r.sector_name}</span><strong>{money(r.stock, ccy)}</strong>{r.share_pct != null && <span className="tiny dim">{r.share_pct.toFixed(1)}%</span>}</div>
          ))}
        </div>
        <div className="card">
          <p className="card-title">Largest net increases</p>
          {gain.length === 0 ? <p className="tiny dim">No sector grew at the common period.</p> : gain.map((r) => (
            <div className="cr-line" key={r.series_id}><span>{r.sector_name}</span><strong style={{ color: 'var(--up)' }}>{sign(r.net_change, ccy)}</strong><span className="tiny dim">{pctTxt(r.pct_change)}</span></div>
          ))}
        </div>
        <div className="card">
          <p className="card-title">Largest net decreases</p>
          {lose.length === 0 ? <p className="tiny dim">No sector contracted at the common period.</p> : lose.map((r) => (
            <div className="cr-line" key={r.series_id}><span>{r.sector_name}</span><strong style={{ color: 'var(--down)' }}>{sign(r.net_change, ccy)}</strong><span className="tiny dim">{pctTxt(r.pct_change)}</span></div>
          ))}
        </div>
      </div>

      {t.valid && pts.length > 1 ? (
        <div className="card">
          <p className="card-title">Total outstanding credit over time</p>
          <RangeChips range={range} setRange={setRange} compact />
          <div style={{ width: '100%', height: 240 }}>
            <ResponsiveContainer>
              <AreaChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e6e9f0" />
                <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(p: string) => p.slice(0, 4)} minTickGap={40} />
                <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}bn` : `${v}m`)} />
                <Tooltip formatter={(v: number) => exact(v, ccy)} labelFormatter={(p: string) => periodLabel(p)} />
                <Area type="monotone" dataKey="stock" name="Outstanding credit" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.14} strokeWidth={2} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="tiny dim" style={{ marginBottom: 0 }}>{s.unit}. Total as reported by the source; the sectors add up to it at the latest period.</p>
        </div>
      ) : (
        <div className="callout warn" style={{ marginTop: 10 }}>No total history is shown. {t.reason ?? ''}</div>
      )}
    </>
  );
}

function RangeChips({ range, setRange, compact }: { range: RangeKey; setRange: (r: RangeKey) => void; compact?: boolean }) {
  return (
    <div className="chips" role="group" aria-label="Time window" style={{ marginBottom: compact ? 6 : 8 }}>
      {RANGES.filter((r) => !compact || r.k !== 'custom').map((r) => (
        <button key={r.k} type="button" className={`chip${range === r.k ? ' active' : ''}`} onClick={() => setRange(r.k)}>{r.label}</button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// B. Ranking
// ---------------------------------------------------------------------------------------------------------------

type SortKey = 'rank_stock' | 'sector_name' | 'stock' | 'prev_stock' | 'net_change' | 'pct_change' | 'share_pct' | 'period' | 'obs_count';

function RankingTable({ s, sel, onPick }: { s: CreditSummary; sel: string | null; onPick: (id: string) => void }) {
  const ccy = ccyOf(s.unit);
  const [key, setKey] = useState<SortKey>('rank_stock');
  const [dir, setDir] = useState<1 | -1>(1);
  const [q, setQ] = useState('');
  const [dirFilter, setDirFilter] = useState<'all' | 'up' | 'down'>('all');
  const rows = useMemo(() => {
    const f = s.sectors.filter((r) => r.sector_name.toLowerCase().includes(q.toLowerCase()) && (dirFilter === 'all' || (dirFilter === 'up' ? (r.net_change ?? 0) > 0 : (r.net_change ?? 0) < 0)));
    return [...f].sort((a, b) => {
      const av = a[key] as number | string | null; const bv = b[key] as number | string | null;
      if (av == null && bv == null) return 0;
      if (av == null) return 1;
      if (bv == null) return -1;
      return (av < bv ? -1 : av > bv ? 1 : 0) * dir;
    });
  }, [s.sectors, key, dir, q, dirFilter]);
  const th = (k: SortKey, label: string, right = true) => (
    <th className={right ? 'align-right' : ''} style={{ cursor: 'pointer', whiteSpace: 'nowrap' }} onClick={() => { if (k === key) setDir((d) => (d === 1 ? -1 : 1)); else { setKey(k); setDir(k === 'sector_name' || k === 'rank_stock' ? 1 : -1); } }} aria-sort={k === key ? (dir === 1 ? 'ascending' : 'descending') : 'none'}>
      {label}{k === key ? (dir === 1 ? ' \u25B2' : ' \u25BC') : ''}
    </th>
  );
  return (
    <>
      <h3 style={{ marginBottom: 6 }}>Sector ranking</h3>
      <p className="tiny dim" style={{ marginTop: 0 }}>
        Ranked at the latest period every sector has reported ({periodLabel(s.common_period)}). Click a heading to sort and a row to open the sector. Share of total is shown only where the sectors add up to the reported total.
      </p>
      <div className="row" style={{ gap: 8, marginBottom: 8, flexWrap: 'wrap' }}>
        <input placeholder="Filter sectors" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Filter sectors" style={{ maxWidth: 220 }} />
        <div className="chips">
          {(['all', 'up', 'down'] as const).map((d) => <button key={d} type="button" className={`chip${dirFilter === d ? ' active' : ''}`} onClick={() => setDirFilter(d)}>{d === 'all' ? 'All' : d === 'up' ? 'Net increase' : 'Net decrease'}</button>)}
        </div>
      </div>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              {th('rank_stock', '#', false)}{th('sector_name', 'Sector', false)}{th('stock', 'Outstanding credit')}{th('prev_stock', 'Previous period')}{th('net_change', 'Net change')}{th('pct_change', '% change')}
              {th('share_pct', 'Share of total')}{th('period', 'Observation date')}<th>Frequency</th>{th('obs_count', 'History')}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.series_id} onClick={() => onPick(r.series_id)} style={{ cursor: 'pointer', background: r.series_id === sel ? 'var(--surface-2)' : undefined }}>
                <td>{r.rank_stock ?? '-'}</td>
                <td><strong>{r.sector_name}</strong>{r.flags_note || r.flag ? <span className="badge warning" style={{ marginLeft: 6 }} title={r.flags_note ?? r.flag ?? ''}>check</span> : null}</td>
                <td className="align-right" title={exact(r.stock, ccy)}>{money(r.stock, ccy)}</td>
                <td className="align-right" title={exact(r.prev_stock, ccy)}>{money(r.prev_stock, ccy)}</td>
                <td className="align-right" style={{ color: tone(r.net_change) }} title="Net change in outstanding credit. Not gross lending or repayments.">{sign(r.net_change, ccy)}</td>
                <td className="align-right" style={{ color: tone(r.pct_change) }}>{pctTxt(r.pct_change)}</td>
                <td className="align-right">{r.share_pct == null ? <span className="dim" title="Shown only where sectors add up to the total">n/a</span> : `${r.share_pct.toFixed(1)}%`}</td>
                <td>{periodLabel(r.period)}{!r.at_common_period && <span className="tiny dim"> (own date)</span>}</td>
                <td>{FREQ_NAME[r.frequency]}</td>
                <td className="tiny dim">{periodLabel(r.first_period)} to {periodLabel(r.latest_own_period)} ({r.obs_count})</td>
              </tr>
            ))}
            {rows.length === 0 && <tr><td colSpan={10} className="dim">No sector matches.</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="tiny dim">All values in {s.unit}. Hover a figure for the exact amount.</p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// C. Sector detail
// ---------------------------------------------------------------------------------------------------------------

function SectorDetail({ data, s, sel, onSel, h, map, dash }: { data: CreditCountry; s: CreditSummary; sel: string | null; onSel: (id: string) => void; h: CreditHistory | undefined; map: CreditSectorMap | undefined; dash: Dash }) {
  const ccy = ccyOf(s.unit);
  const row = s.sectors.find((r) => r.series_id === sel);
  const [range, setRange] = useState<RangeKey>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [agg, setAgg] = useState<AggMode>('native');
  const [view, setView] = useState<'abs' | 'pct'>('abs');
  const freq = row?.frequency ?? 'M';

  const pts = useMemo(() => {
    if (!h) return [];
    let p = aggregate(h.history, agg, freq).filter((x) => x.stock != null);
    if (!p.length) return p;
    const lastEnd = p[p.length - 1].period_end;
    if (range === 'custom') {
      if (from) p = p.filter((x) => x.period_end >= `${from}-01`);
      if (to) p = p.filter((x) => x.period.slice(0, 7) <= to);
    } else {
      const months = RANGES.find((r) => r.k === range)?.months;
      if (months) { const cut = shiftIso(lastEnd, months); p = p.filter((x) => x.period_end >= cut); }
    }
    return p;
  }, [h, agg, freq, range, from, to]);

  if (!row) return <Empty title="Choose a sector" hint="Pick a row in the ranking or a bar in the diagram." />;
  const last = pts[pts.length - 1];
  const kind = kindLabel(row.kind, row.kind_basis);
  const stockOnly = row.kind !== 'stock';
  const meta: CreditSeriesMeta | undefined = data.series.find((x) => x.id === row.series_id);
  const flagTxt = data.flags.filter((f) => f.series_id === row.series_id && f.flag_code === 'zero_run').map((f) => f.message);

  return (
    <>
      <h3 style={{ marginBottom: 6 }}>Sector detail</h3>
      <div className="chips" role="tablist" aria-label="Sector" style={{ marginBottom: 8 }}>
        {s.sectors.map((r) => <button key={r.series_id} type="button" className={`chip${r.series_id === sel ? ' active' : ''}`} onClick={() => onSel(r.series_id)}>{r.sector_name}</button>)}
      </div>

      <div className="card">
        <p className="card-title">{row.sector_name}</p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 6 }}>
          <span className={`badge ${kind.cls}`} title={kind.hint}>{kind.text}</span>
          <span className="tiny dim">{FREQ_NAME[freq]}, {s.unit}, {periodLabel(row.first_period)} to {periodLabel(row.latest_own_period)}</span>
        </div>
        {flagTxt.map((m, i) => <div className="callout warn" key={i} style={{ marginBottom: 8 }}>{m}</div>)}
        <div className="portal-tiles" style={{ marginBottom: 8 }}>
          <div className="stat"><div className="label">Outstanding credit</div><div className="value" title={exact(row.stock, ccy)}>{money(row.stock, ccy)}</div><div className="tiny dim">{periodLabel(row.period)}</div></div>
          <div className="stat"><div className="label">Net change</div><div className="value" style={{ color: tone(row.net_change) }}>{sign(row.net_change, ccy)}</div><div className="tiny dim">{pctTxt(row.pct_change)} on the previous period</div></div>
          <div className="stat"><div className="label">Share of total</div><div className="value">{row.share_pct == null ? 'n/a' : `${row.share_pct.toFixed(1)}%`}</div><div className="tiny dim">{row.share_pct == null ? 'Sectors do not add up to a total' : 'of all sector credit'}</div></div>
          <div className="stat"><div className="label">Rank by balance</div><div className="value">{row.rank_stock ?? 'n/a'}</div><div className="tiny dim">of {s.sector_count} sectors</div></div>
        </div>

        <div className="row" style={{ gap: 12, flexWrap: 'wrap', marginBottom: 6 }}>
          <RangeChips range={range} setRange={setRange} />
          {range === 'custom' && (
            <span className="row" style={{ gap: 6 }}>
              <input type="month" value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From month" />
              <span className="tiny dim">to</span>
              <input type="month" value={to} onChange={(e) => setTo(e.target.value)} aria-label="To month" />
            </span>
          )}
        </div>
        {freq === 'M' && (
          <div className="chips" role="group" aria-label="Display frequency" style={{ marginBottom: 6 }}>
            {([['native', 'As published (monthly)'], ['quarter', 'Quarter-end'], ['year', 'Year-end']] as [AggMode, string][]).map(([k, l]) => <button key={k} type="button" className={`chip${agg === k ? ' active' : ''}`} onClick={() => setAgg(k)}>{l}</button>)}
          </div>
        )}
        {agg !== 'native' && <p className="tiny dim" style={{ marginTop: 0 }}>Method: each point is the outstanding balance on the {agg === 'quarter' ? 'last day of the quarter' : 'last day of the year'}, not an average or a sum. The change is the difference between consecutive {agg === 'quarter' ? 'quarter-ends' : 'year-ends'}. A period that has not yet ended is left out.</p>}

        {!h ? <Skeletons n={2} /> : pts.length < 2 ? <p className="small dim">Not enough observations in this window.</p> : (
          <>
            <p className="tiny dim" style={{ margin: '4px 0' }}>Outstanding credit, {s.unit}</p>
            <div style={{ width: '100%', height: 240 }}>
              <ResponsiveContainer>
                <AreaChart data={pts} margin={{ top: 8, right: 12, bottom: 0, left: 4 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e6e9f0" />
                  <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(p: string) => (agg === 'native' && pts.length < 40 ? periodLabel(p).replace(' ', "'") : p.slice(0, 4))} minTickGap={36} />
                  <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => (v >= 1000 ? `${(v / 1000).toFixed(0)}bn` : `${Math.round(v)}m`)} />
                  <Tooltip content={<PointTip ccy={ccy} />} />
                  <Area type="monotone" dataKey="stock" stroke="var(--brand)" fill="var(--brand)" fillOpacity={0.14} strokeWidth={2} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {stockOnly ? <div className="callout warn" style={{ marginTop: 8 }}>This series is not established as a stock, so no net changes are calculated for it.</div> : (
              <>
                <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center', margin: '10px 0 4px' }}>
                  <p className="tiny dim" style={{ margin: 0 }}>Net change in outstanding credit, period by period (not gross lending or repayments)</p>
                  <div className="chips"><button type="button" className={`chip${view === 'abs' ? ' active' : ''}`} onClick={() => setView('abs')}>{ccy} million</button><button type="button" className={`chip${view === 'pct' ? ' active' : ''}`} onClick={() => setView('pct')}>Percent</button></div>
                </div>
                <div style={{ width: '100%', height: 200 }}>
                  <ResponsiveContainer>
                    <BarChart data={pts} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e6e9f0" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(p: string) => p.slice(0, 4)} minTickGap={36} />
                      <YAxis tick={{ fontSize: 11 }} width={52} tickFormatter={(v: number) => (view === 'pct' ? `${v}%` : Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(1)}bn` : `${Math.round(v)}m`)} />
                      <ReferenceLine y={0} stroke="#9aa3b5" />
                      <Tooltip content={<PointTip ccy={ccy} />} />
                      <Bar dataKey={view === 'abs' ? 'net_change' : 'pct_change'} isAnimationActive={false}>
                        {pts.map((p, i) => <Cell key={i} fill={(view === 'abs' ? p.net_change : p.pct_change) != null && (view === 'abs' ? p.net_change! : p.pct_change!) < 0 ? 'var(--down)' : 'var(--up)'} />)}
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {pts.some((p) => p.rank_stock != null) && (
              <>
                <p className="tiny dim" style={{ margin: '10px 0 4px' }}>Rank among {s.sector_count} sectors by outstanding balance (1 is the largest){agg !== 'native' ? '; shown at the same dates' : ''}</p>
                <div style={{ width: '100%', height: 150 }}>
                  <ResponsiveContainer>
                    <LineChart data={pts} margin={{ top: 4, right: 12, bottom: 0, left: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e6e9f0" />
                      <XAxis dataKey="period" tick={{ fontSize: 11 }} tickFormatter={(p: string) => p.slice(0, 4)} minTickGap={36} />
                      <YAxis reversed domain={[1, s.sector_count]} allowDecimals={false} tick={{ fontSize: 11 }} width={52} />
                      <Tooltip formatter={(v: number) => `Rank ${v}`} labelFormatter={(p: string) => periodLabel(p)} />
                      <Line type="stepAfter" dataKey="rank_stock" stroke="var(--brand)" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            <details style={{ marginTop: 10 }}>
              <summary className="small">Period-by-period table ({pts.length} periods)</summary>
              <div className="table-wrap" style={{ maxHeight: 340, overflow: 'auto' }}>
                <table className="data-table">
                  <thead><tr><th>Period</th><th className="align-right">Outstanding</th><th className="align-right">Net change</th><th className="align-right">% change</th><th className="align-right">Share</th><th className="align-right">Rank</th><th>Note</th></tr></thead>
                  <tbody>
                    {[...pts].reverse().map((p) => (
                      <tr key={p.period}>
                        <td>{periodLabel(p.period)}</td><td className="align-right">{money(p.stock, ccy)}</td>
                        <td className="align-right" style={{ color: tone(p.net_change) }}>{sign(p.net_change, ccy)}</td><td className="align-right" style={{ color: tone(p.pct_change) }}>{pctTxt(p.pct_change)}</td>
                        <td className="align-right">{p.share_pct == null ? 'n/a' : `${p.share_pct.toFixed(1)}%`}</td><td className="align-right">{p.rank_stock ?? '-'}</td><td className="tiny dim">{p.flag ?? ''}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </>
        )}
        {last && <p className="tiny dim" style={{ marginBottom: 0 }}>Source: {meta?.source_name ?? s.source_name}{meta ? `, series ${meta.mnemonic}` : ''}. {h && h.revisions > 0 ? `${h.revisions} earlier value${h.revisions === 1 ? ' was' : 's were'} revised by the source; the history of revisions is kept.` : 'No revisions recorded.'}</p>}
      </div>

      <Meaning row={row} pts={h?.history ?? []} ccy={ccy} />
      <Trade map={map} dash={dash} sector={row.sector_name} />
    </>
  );
}

interface TipProps { active?: boolean; payload?: { payload: CreditPoint }[]; ccy: string }
function PointTip({ active, payload, ccy }: TipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="cr-tip">
      <strong>{periodLabel(p.period)}</strong>
      <div>Outstanding: {exact(p.stock, ccy)}</div>
      {p.net_change != null && <div style={{ color: tone(p.net_change) }}>Net change in stock: {sign(p.net_change, ccy)} ({pctTxt(p.pct_change)})</div>}
      {p.share_pct != null && <div>Share of total: {p.share_pct.toFixed(1)}%</div>}
      {p.flag && <div className="tiny">{p.flag}</div>}
      <div className="tiny dim">Credit assets, not money supply</div>
    </div>
  );
}

/** What the credit trend may imply. Fixed wording rules over the data; stated as evidence, never as advice. */
function Meaning({ row, pts, ccy }: { row: CreditSectorRow; pts: CreditPoint[]; ccy: string }) {
  if (row.kind !== 'stock' || pts.length < 14) return null;
  const monthly = /^\d{4}-\d{2}$/.test(pts[pts.length - 1].period);
  const lag = monthly ? 12 : 4;
  const now = pts[pts.length - 1];
  const then = pts[pts.length - 1 - lag];
  if (!then || then.stock == null || now.stock == null) return null;
  const chg = then.stock > 0 ? ((now.stock - then.stock) / then.stock) * 100 : null;
  const bits: string[] = [];
  if (chg != null) bits.push(`Outstanding credit to ${row.sector_name} is ${Math.abs(chg).toFixed(1)}% ${chg >= 0 ? 'higher' : 'lower'} than a year earlier (${money(then.stock, ccy)} in ${periodLabel(then.period)}, ${money(now.stock, ccy)} in ${periodLabel(now.period)}).`);
  if (now.share_pct != null && then.share_pct != null) {
    const d = now.share_pct - then.share_pct;
    bits.push(`Its share of all sector credit ${Math.abs(d) < 0.05 ? 'is unchanged' : `${d > 0 ? 'rose' : 'fell'} by ${Math.abs(d).toFixed(1)} percentage points`}, from ${then.share_pct.toFixed(1)}% to ${now.share_pct.toFixed(1)}%.`);
  }
  if (now.rank_stock != null && then.rank_stock != null && now.rank_stock !== then.rank_stock) bits.push(`Its rank by balance moved from ${then.rank_stock} to ${now.rank_stock}.`);
  return (
    <div className="card">
      <p className="card-title">What this may mean</p>
      <ul className="small" style={{ margin: '0 0 8px', paddingLeft: 18 }}>{bits.map((b, i) => <li key={i}>{b}</li>)}</ul>
      <p className="tiny dim" style={{ marginBottom: 0 }}>This is evidence about where bank credit is outstanding. A growing balance can reflect new lending, slower repayment, interest being added or a change in coverage. It does not show that a sector is profitable or that financing will continue, and it is not investment advice.</p>
    </div>
  );
}

/** Goods trade linked to the sector through the maintained map. Where no defensible link exists, none is shown. */
function Trade({ map, dash, sector }: { map: CreditSectorMap | undefined; dash: Dash; sector: string }) {
  if (!map) return null;
  if (map.trade_scope === 'none') {
    return (
      <div className="card">
        <p className="card-title">Trade and business links</p>
        <p className="small dim" style={{ margin: 0 }}>No defensible link between {sector} and goods trade is held, so none is shown. {map.note}</p>
      </div>
    );
  }
  if (!dash) return <div className="card"><p className="card-title">Trade and business links</p><p className="small dim" style={{ margin: 0 }}>Loading trade data...</p></div>;
  if (dash.inactive || !dash.overview) {
    return <div className="card"><p className="card-title">Trade and business links</p><p className="small dim" style={{ margin: 0 }}>Trade data is not loaded for this country yet. {map.note}</p></div>;
  }
  const prefixes = (map.hs_prefixes ?? '').split(',').filter(Boolean);
  const inScope = (code: string) => (map.trade_scope === 'hs' ? prefixes.some((p) => code.startsWith(p)) : true);
  const sum = (b: typeof dash.families_export) => (b ? b.families.filter((f) => inScope(f.code)) : []);
  const ex = map.trade_flow !== 'M' ? sum(dash.families_export) : [];
  const im = map.trade_flow !== 'X' ? sum(dash.families_import) : [];
  const total = (f: typeof ex) => f.reduce((a, x) => a + x.value_usd, 0);
  const year = dash.overview.year;
  const exTotal = map.trade_scope === 'exports' ? dash.overview.export_usd : total(ex);
  const imTotal = map.trade_scope === 'imports' ? dash.overview.import_usd : total(im);
  const top = (f: typeof ex) => [...f].sort((a, b) => b.value_usd - a.value_usd).slice(0, 5);
  const label = map.trade_scope === 'hs' ? `HS ${prefixes.join(', ')}` : map.trade_scope === 'exports' ? 'all exports' : 'all imports';
  return (
    <div className="card">
      <p className="card-title">Trade and business links</p>
      <div className="row" style={{ gap: 6, marginBottom: 6 }}>
        <span className={`badge ${map.confidence === 'direct' ? 'on' : 'warning'}`}>{map.confidence === 'direct' ? 'Direct link' : 'Indicative link'}</span>
        <span className="tiny dim">{label}, UN Comtrade {year}</span>
      </div>
      <p className="small" style={{ marginTop: 0 }}>{map.note}</p>
      <div className="cr-grid">
        {map.trade_flow !== 'M' && <TradeList title="Exports" total={exTotal} fam={top(ex)} />}
        {map.trade_flow !== 'X' && <TradeList title="Imports" total={imTotal} fam={top(im)} />}
      </div>
      <p className="tiny dim" style={{ marginBottom: 0 }}>
        Related inputs, transport, storage and services around these goods are places to look for business opportunities, to be checked against the Tereflow country page and local conditions. The link between a credit sector and a product group is a maintained mapping, not a measured relationship.
      </p>
    </div>
  );
}

function TradeList({ title, total, fam }: { title: string; total: number; fam: { code: string; name: string; value_usd: number }[] }) {
  return (
    <div className="stat">
      <div className="label">{title}</div>
      <div className="value" style={{ fontSize: 20 }}>{total > 0 ? usd(total) : 'None recorded'}</div>
      {fam.map((f) => <div className="cr-line" key={f.code}><span className="tiny">HS {f.code} {f.name}</span><span className="tiny dim">{usd(f.value_usd)}</span></div>)}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// D. System diagram
// ---------------------------------------------------------------------------------------------------------------

function wrap(text: string, n: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of text.replace(/,/g, '').split(/\s+/)) {
    if ((cur + ' ' + w).trim().length > n && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}

function SystemDiagram({ data, s, sel, onPick }: { data: CreditCountry; s: CreditSummary; sel: string | null; onPick: (id: string) => void }) {
  const ccy = ccyOf(s.unit);
  const [scale, setScale] = useState<'linear' | 'sqrt'>('linear');
  const rows = s.sectors;
  const n = rows.length;
  const W = Math.max(940, n * 84 + 110);
  const M = 64; // left margin reserved for the feedback loop
  const gap = (W - M - 30) / n;
  const tankW = Math.min(58, gap - 14);
  const top = 262, base = 470, H = base - top;
  const maxStock = Math.max(...rows.map((r) => r.stock), 1);
  const maxChg = Math.max(...rows.map((r) => Math.abs(r.net_change ?? 0)), 1);
  const f = (v: number) => (scale === 'linear' ? v / maxStock : Math.sqrt(v / maxStock));
  const cx = (i: number) => M + gap * i + gap / 2;
  const mid = (M + W - 30) / 2;
  return (
    <>
      <h3 style={{ marginBottom: 6 }}>How credit flows through the economy</h3>
      <p className="tiny dim" style={{ marginTop: 0 }}>
        Policy and regulation shape how banks lend; banks hold credit outstanding to each sector; sectors connect to trade and services. Each column is a sector's outstanding credit at {periodLabel(s.common_period)}. Arrows show the latest <strong>net change in outstanding credit</strong>, not gross lending or repayments.
      </p>
      <div className="chips" role="group" aria-label="Bar scale" style={{ marginBottom: 6 }}>
        <button type="button" className={`chip${scale === 'linear' ? ' active' : ''}`} onClick={() => setScale('linear')}>One linear scale</button>
        <button type="button" className={`chip${scale === 'sqrt' ? ' active' : ''}`} onClick={() => setScale('sqrt')}>Square-root scale (small sectors visible)</button>
      </div>
      <div className="cr-diagram">
        <svg viewBox={`0 0 ${W} 640`} role="img" aria-label="Capital Hill, banks, sector credit stocks and trade, with net change arrows" style={{ minWidth: Math.min(W, 940), width: '100%', height: 'auto' }}>
          <defs>
            <marker id="arUp" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,1 L11,6 L0,11 z" fill="var(--up)" /></marker>
            <marker id="arDown" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,1 L11,6 L0,11 z" fill="var(--down)" /></marker>
            <marker id="arCon" markerUnits="userSpaceOnUse" markerWidth="12" markerHeight="12" refX="10" refY="6" orient="auto"><path d="M0,1 L11,6 L0,11 z" fill="#8b93a7" /></marker>
          </defs>

          <rect x={mid - 250} y={8} width={500} height={58} rx={10} fill="var(--surface-2)" stroke="var(--line-soft)" />
          <text x={mid} y={30} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--ink)">Capital Hill: policy and regulation</text>
          <text x={mid} y={50} textAnchor="middle" fontSize="11.5" fill="var(--muted)">Parliament sets the laws; regulators supervise banks and credit</text>

          <rect x={mid - 250} y={112} width={500} height={58} rx={10} fill="var(--surface-2)" stroke="var(--line-soft)" />
          <text x={mid} y={134} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--ink)">Banks: financial intermediaries</text>
          <text x={mid} y={154} textAnchor="middle" fontSize="11.5" fill="var(--muted)">Manage and allocate credit to sectors of the economy</text>

          <path d={`M ${mid - 60} 66 L ${mid - 60} 112`} stroke="#8b93a7" strokeWidth="1.6" strokeDasharray="5 4" fill="none" markerEnd="url(#arCon)" />
          <path d={`M ${mid + 60} 112 L ${mid + 60} 66`} stroke="#8b93a7" strokeWidth="1.6" strokeDasharray="5 4" fill="none" markerEnd="url(#arCon)" />
          <text x={mid + 70} y={92} fontSize="10.5" fill="var(--muted)">conceptual: rules shape lending; lending conditions inform policy</text>

          {rows.map((r, i) => {
            const x = cx(i);
            const hgt = Math.max(r.stock > 0 ? 3 : 0, f(r.stock) * H);
            const up = (r.net_change ?? 0) > 0, down = (r.net_change ?? 0) < 0;
            const w = 1.6 + (Math.abs(r.net_change ?? 0) / maxChg) * 4;
            const bx = mid - 230 + (460 / Math.max(1, n - 1)) * i;
            const colour = up ? 'var(--up)' : down ? 'var(--down)' : '#9aa3b5';
            const mapEntry = data.sector_map[r.sector_key];
            const trade = mapEntry && mapEntry.trade_scope !== 'none' ? (mapEntry.trade_scope === 'hs' ? `HS ${(mapEntry.hs_prefixes ?? '').split(',').slice(0, 3).join(', ')}${(mapEntry.hs_prefixes ?? '').split(',').length > 3 ? '...' : ''}` : mapEntry.trade_scope === 'exports' ? 'all exports' : 'all imports') : 'no goods link';
            const chosen = r.series_id === sel;
            return (
              <g key={r.series_id} onClick={() => onPick(r.series_id)} style={{ cursor: 'pointer' }} tabIndex={0} role="button" aria-label={`${r.sector_name}: ${exact(r.stock, ccy)}, net change ${sign(r.net_change, ccy)}`} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onPick(r.series_id); }}>
                <title>{`${r.sector_name}\nOutstanding credit ${exact(r.stock, ccy)} (${periodLabel(r.period)})\nNet change in outstanding credit ${sign(r.net_change, ccy)} (${pctTxt(r.pct_change)})\nCredit assets, not money supply`}</title>
                <path d={`M ${bx} 170 C ${bx} 205, ${x} 195, ${x} ${top - 36}`} stroke={colour} strokeWidth={w} strokeDasharray={up || down ? undefined : '4 4'} fill="none" markerEnd={up ? 'url(#arUp)' : undefined} markerStart={down ? 'url(#arDown)' : undefined} opacity={0.85} />
                <text x={x} y={top - 12} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={colour}>{r.net_change == null ? 'n/a' : sign(r.net_change, ccy)}</text>
                <rect x={x - tankW / 2} y={top} width={tankW} height={H} rx={6} fill="#fff" stroke={chosen ? 'var(--brand)' : 'var(--line-soft)'} strokeWidth={chosen ? 2.5 : 1.2} />
                <rect x={x - tankW / 2 + 1} y={base - hgt} width={tankW - 2} height={hgt} rx={5} fill="var(--brand)" opacity={0.78} />
                <text x={x} y={hgt > H - 18 ? top + 14 : base - hgt - 5} textAnchor="middle" fontSize="10.5" fontWeight="700" fill={hgt > H - 18 ? '#fff' : 'var(--ink)'}>{money(r.stock, '').trim()}</text>
                {wrap(r.sector_name, 13).map((l, k) => <text key={k} x={x} y={base + 16 + k * 13} textAnchor="middle" fontSize="10.5" fill="var(--ink)">{l}</text>)}
                <path d={`M ${x} ${base + 56} L ${x} 566`} stroke="#c9cfdc" strokeWidth="1.2" />
                <text x={x} y={552} textAnchor="middle" fontSize="9.5" fill="var(--muted)">{trade}</text>
              </g>
            );
          })}

          <rect x={M} y={566} width={W - M - 30} height={52} rx={10} fill="var(--surface-2)" stroke="var(--line-soft)" />
          <text x={mid} y={588} textAnchor="middle" fontSize="14" fontWeight="700" fill="var(--ink)">Trade, imports, exports and related services</text>
          <text x={mid} y={607} textAnchor="middle" fontSize="11.5" fill="var(--muted)">Businesses that produce, buy, sell, move and service goods</text>
          <path d={`M ${M} 592 L 36 592 L 36 141 L ${mid - 254} 141`} stroke="#8b93a7" strokeWidth="1.6" strokeDasharray="5 4" fill="none" markerEnd="url(#arCon)" />
          <text x={22} y={370} fontSize="10.5" fill="var(--muted)" textAnchor="middle" transform="rotate(-90 22 370)">conceptual: activity and repayment inform future lending</text>
        </svg>
      </div>
      <div className="row tiny dim" style={{ gap: 14, flexWrap: 'wrap', marginTop: 6 }}>
        <span><span style={{ color: 'var(--up)' }}>&#9632;</span> net increase in outstanding credit</span>
        <span><span style={{ color: 'var(--down)' }}>&#9632;</span> net decrease</span>
        <span>dashed grey line: unchanged or unavailable</span>
        <span>dashed arrows between layers: conceptual relationships, not measured</span>
        <span>{scale === 'linear' ? 'Bar heights use one linear scale across sectors.' : 'Bar heights use the square root of each balance, so small sectors are visible. Compare values using the labels.'}</span>
      </div>
      <p className="tiny dim">The diagram shows balances and their net change. It does not show which loans were issued or repaid, and the data cannot separate gross inflows from outflows. Click a column to open the sector. On a phone, swipe sideways to see every sector.</p>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// E. Method and coverage
// ---------------------------------------------------------------------------------------------------------------

function Method({ data, s, src, hist, hasBanks }: { data: CreditCountry; s: CreditSummary; src: CreditSourceKey; hist: CreditHistory | undefined; hasBanks: boolean }) {
  const series = data.series.filter((x) => x.source_key === src);
  const run = data.last_run;
  return (
    <>
      <h3 style={{ marginBottom: 6 }}>Method and data coverage</h3>
      <div className="card">
        <p className="card-title">What is measured</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          <li><strong>Outstanding credit (stock)</strong> is the balance owed to banks at a date. The latest value for each sector is the balance at its latest reporting date.</li>
          <li><strong>Net change in outstanding credit</strong> = closing balance minus opening balance for the same series. It equals new credit minus repayments and write-offs, plus reclassifications, valuation and coverage effects, and source revisions. Gross disbursements and repayments are not observable from these series.</li>
          <li><strong>Not money supply.</strong> A credit balance is a bank asset. It does not measure currency created or money held by a sector.</li>
          <li><strong>Share of total</strong> is shown only at dates where the sectors add up to the reported total (within 0.5%). A total is shown only when that holds.</li>
          <li><strong>Frequency and units</strong> are as published. Quarter-end and year-end views take the balance at that date, never a sum or average. A missing value is never treated as zero.</li>
          <li><strong>Sources are never merged.</strong> National and IMF series stay separate, each with its own definition and coverage.</li>
          {src === 'IMF' && <li><strong>IMF categories</strong> are claims of other depository corporations on private sector (businesses and households together), public non-financial corporations and other financial corporations. They are not industries, and household credit is not credit to entrepreneurs.</li>}
        </ul>
      </div>

      <div className="card">
        <p className="card-title">Series behind this view ({series.length})</p>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Sector</th><th>Source series</th><th>Kind</th><th>Unit</th><th>Frequency</th><th>Coverage</th><th>Last fetched</th></tr></thead>
            <tbody>
              {series.map((m) => {
                const k = kindLabel(m.measure_kind, m.kind_basis);
                return (
                  <tr key={m.id}>
                    <td>{m.sector_name}</td>
                    <td className="tiny"><code>{m.mnemonic}</code>{m.databank ? <div className="dim">{m.dataflow ?? m.databank}</div> : null}</td>
                    <td><span className={`badge ${k.cls}`} title={k.hint}>{k.text}</span></td>
                    <td className="tiny">{m.unit_label ?? 'n/a'}{m.unit_verified === 0 && m.source_key === 'IMF' ? <div className="dim">converted to millions</div> : null}</td>
                    <td>{m.frequency ? FREQ_NAME[m.frequency] : 'n/a'}</td>
                    <td className="tiny">{periodLabel(m.first_obs)} to {periodLabel(m.latest_obs)} ({m.obs_count})</td>
                    <td className="tiny">{m.last_fetch_at ? m.last_fetch_at.slice(0, 16) : 'never'} {m.fetch_status === 'ok' ? '' : <span className="badge error">{m.fetch_status ?? 'pending'}</span>}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <details style={{ marginTop: 8 }}>
          <summary className="small">Definitions</summary>
          {series.map((m) => <p className="tiny" key={m.id}><strong>{m.sector_name}.</strong> {m.definition_notes ?? 'No definition recorded by the source.'}</p>)}
        </details>
      </div>

      <div className="card">
        <p className="card-title">Known gaps and limitations</p>
        <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
          {data.flags.filter((f) => series.some((x) => x.id === f.series_id) && f.flag_code === 'zero_run').map((f, i) => <li key={i}>{series.find((x) => x.id === f.series_id)?.sector_name}: {f.message}</li>)}
          {s.sectors.filter((r) => !r.at_common_period).map((r) => <li key={r.series_id}>{r.sector_name} last reported {periodLabel(r.latest_own_period)}, earlier than the common period, so its figures are at {periodLabel(r.period)}.</li>)}
          {src === 'BOG' && <li>The Bank of Ghana does not state in the series metadata whether these are stocks. They are treated as stocks because the sectors add up to the total and the balances carry forward. Confirm with the Bank of Ghana before relying on net changes for decisions.</li>}
          {hist && hist.revisions > 0 && <li>The source revised {hist.revisions} past value{hist.revisions === 1 ? '' : 's'} of the series shown in the sector detail. Revisions are stored, not overwritten.</li>}
          <li>Source figures can be revised. Each run stores a new copy only when the data changed.</li>
        </ul>
      </div>
      <p className="tiny dim">
        Source: {s.source_name}. Figures calculated {s.generated_at.slice(0, 16)} UTC.
        {run ? ` Last pipeline run ${run.finished_at.slice(0, 16)} UTC: ${run.status}, ${run.series_ok} series updated${run.series_failed ? `, ${run.series_failed} failed` : ''}, ${run.obs_new} new and ${run.obs_revised} revised observations.` : ''}
        {hasBanks && <> <Link to={`/finance/${data.country.iso3}/banks`}>Bank by bank published figures (earlier view)</Link>.</>}
      </p>
    </>
  );
}
