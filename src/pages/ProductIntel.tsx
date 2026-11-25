import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';
import { ISO3_NAME } from '../../shared/country-names';
import type { IntelListRow, ProductIntel } from '../lib/intel-types';

const TABS = [
  { k: 'overview', label: 'Overview' }, { k: 'demand', label: 'Global demand' }, { k: 'supply', label: 'Global supply' },
  { k: 'pressure', label: 'Market pressure' }, { k: 'competitiveness', label: 'Competitiveness' }, { k: 'opportunities', label: 'Market opportunities' },
  { k: 'mapping', label: 'Industry mapping' }, { k: 'network', label: 'Production network' }, { k: 'method', label: 'Methodology and data' },
] as const;
type TabKey = (typeof TABS)[number]['k'];

const nm = (iso: string) => ISO3_NAME[iso] ?? iso;
const usd = (v: number | null | undefined) => (v == null ? 'n/a' : Math.abs(v) >= 1e9 ? `USD ${(v / 1e9).toFixed(2)}bn` : Math.abs(v) >= 1e6 ? `USD ${(v / 1e6).toFixed(1)}m` : `USD ${Math.round(v).toLocaleString()}`);
const kg = (v: number | null | undefined) => (v == null ? 'n/a' : v >= 1e9 ? `${(v / 1e9).toFixed(2)} million tonnes` : v >= 1e6 ? `${(v / 1e6).toFixed(1)} thousand tonnes` : `${Math.round(v / 1000).toLocaleString()} tonnes`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'var(--muted)' : v > 0 ? 'var(--up)' : 'var(--down)');
const rankTxt = (v: number | null) => (v == null ? 'n/a' : v > 0 ? `up ${v}` : v < 0 ? `down ${-v}` : 'no change');
const STATE_TEXT: Record<string, string> = {
  demand_strengthening: 'Demand strengthening', demand_weakening: 'Demand weakening', unit_value_rising: 'Unit value rising', unit_value_falling: 'Unit value falling',
  supplier_concentration_increasing: 'Supplier concentration increasing', supplier_concentration_decreasing: 'Supplier concentration decreasing',
  supply_expansion: 'Supply expansion', potential_supply_pressure: 'Potential supply pressure',
};

export function IntelIndex() {
  const nav = useNavigate();
  const [hs, setHs] = useState('');
  const [rows, setRows] = useState<IntelListRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    setRows(null);
    api.intel.list(hs).then((r) => setRows(r.products)).catch((e) => setErr(String(e?.message ?? e)));
  }, [hs]);
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Pick a product by its six-digit HS code to see its calculated demand, supply, concentration, competitiveness and market-pressure indicators. Everything is computed from reported trade and shows its method and coverage.
      </p>
      <form onSubmit={(e) => { e.preventDefault(); if (/^\d{6}$/.test(hs)) nav(`/intel/${hs}`); }} style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        <input value={hs} onChange={(e) => setHs(e.target.value.replace(/\D/g, '').slice(0, 6))} placeholder="HS code or start of one, for example 0901" aria-label="HS code" style={{ flex: 1, maxWidth: 360 }} />
        <button className="mm-cta" type="submit" disabled={!/^\d{6}$/.test(hs)}>Open</button>
      </form>
      {err ? <Empty title="Could not load products" hint={err} /> : !rows ? <Skeletons n={3} /> : rows.length === 0 ? <Empty title="No products found" hint="No calculated product starts with that code." /> : (
        <>
          <p className="tiny dim">{hs ? `Products starting with ${hs}` : 'Largest products by reported imports'}, latest year.</p>
          {rows.map((r) => (
            <Link className="list-item" key={r.hs6} to={`/intel/${r.hs6}`}>
              <span className="name">HS {r.hs6}</span>
              <span className="tiny dim">{usd(r.demand_usd)} imported, {r.latest_year}</span>
            </Link>
          ))}
        </>
      )}
    </>
  );
}

export default function ProductIntelPage() {
  const { hs6 = '' } = useParams();
  const [data, setData] = useState<ProductIntel | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<TabKey>('overview');
  useEffect(() => {
    setData(null); setErr('');
    api.intel.product(hs6).then(setData).catch((e) => setErr(String(e?.message ?? e)));
  }, [hs6]);
  if (err) return <Empty title="No calculated intelligence for this product" hint={err} />;
  if (!data) return <Skeletons n={4} />;
  const p = data.product;
  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}><Link to="/intel">All products</Link> / HS {p.hs6}</p>
      <h2 style={{ margin: '4px 0' }}>{p.description ?? `HS ${p.hs6}`}</h2>
      <p className="tiny dim" style={{ marginTop: 0 }}>
        HS {p.hs6}, comparing {p.period.base} with {p.period.latest}. Based on reported imports of {p.coverage.importer_count} countries, not the whole world. Calculated {data.computed_at} UTC, method {p.method_version}.
      </p>
      <div className="chips" role="tablist" aria-label="Sections" style={{ marginBottom: 12, flexWrap: 'wrap' }}>
        {TABS.map((t) => (
          <button key={t.k} role="tab" aria-selected={tab === t.k} className={`chip${tab === t.k ? ' on' : ''}`} onClick={() => setTab(t.k)}>{t.label}</button>
        ))}
      </div>
      {tab === 'overview' && <Overview d={data} />}
      {tab === 'demand' && <Demand d={data} />}
      {tab === 'supply' && <Supply d={data} />}
      {tab === 'pressure' && <Pressure d={data} />}
      {tab === 'competitiveness' && <Competitiveness d={data} />}
      {tab === 'method' && <Method d={data} />}
      {(tab === 'opportunities' || tab === 'mapping' || tab === 'network') && <NotBuilt which={tab} d={data} />}
    </>
  );
}

function Stat({ label, value, sub, color }: { label: string; value: string; sub?: string; color?: string }) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value" style={color ? { color } : undefined}>{value}</div>
      {sub && <div className="tiny dim">{sub}</div>}
    </div>
  );
}

function Overview({ d }: { d: ProductIntel }) {
  const p = d.product;
  const dm = p.demand;
  return (
    <>
      <div className="portal-tiles">
        <Stat label={`Reported imports, ${p.period.latest}`} value={usd(dm.value_usd)} sub={`${pct(dm.growth_pct)} since ${p.period.base}`} color={tone(dm.growth_pct)} />
        <Stat label="Import quantity" value={kg(dm.weight_kg)} sub={`${pct(dm.weight_growth_pct)} since ${p.period.base}`} color={tone(dm.weight_growth_pct)} />
        <Stat label="Trade value per kg" value={dm.unit_value == null ? 'n/a' : `USD ${dm.unit_value.toFixed(2)}`} sub={`${pct(dm.unit_value_change_pct)} since ${p.period.base}`} />
        <Stat label="Named suppliers" value={String(p.supply.supplier_count)} sub={p.supply.hhi == null ? undefined : `Concentration (HHI) ${p.supply.hhi.toFixed(3)}`} />
      </div>
      {p.pressure.states.length > 0 ? (
        <div className="callout" style={{ marginTop: 12 }}>
          <span className="callout-title">Signals. </span>
          {p.pressure.states.map((s) => <span key={s.state} className={`chip ${s.kind === 'heuristic' ? 'warning' : 'on'}`} title={s.basis} style={{ marginRight: 6 }}>{STATE_TEXT[s.state] ?? s.state}{s.kind === 'heuristic' ? ' (heuristic)' : ''}</span>)}
          <div className="tiny dim" style={{ marginTop: 6 }}>These are positions among all products in the same calculation, not observed facts. See Market pressure.</div>
        </div>
      ) : (
        <p className="tiny dim" style={{ marginTop: 12 }}>{p.pressure.note}</p>
      )}
      <p className="tiny dim">
        Coverage: reported imports of {p.coverage.importers.map(nm).join(', ')}. Countries that did not report in both years are left out: {p.coverage.reporters_not_in_universe.map(nm).join(', ') || 'none'}.
      </p>
    </>
  );
}

function Demand({ d }: { d: ProductIntel }) {
  const p = d.product;
  const dm = p.demand;
  return (
    <>
      <h3>Reported imports by year</h3>
      <div style={{ height: 240 }}>
        <ResponsiveContainer>
          <LineChart data={dm.series.map((s) => ({ year: s.year, value: s.value_usd == null ? null : s.value_usd / 1e6, uv: s.unit_value }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="year" />
            <YAxis yAxisId="l" tickFormatter={(v) => `${Math.round(v)}m`} />
            <YAxis yAxisId="r" orientation="right" tickFormatter={(v) => Number(v).toFixed(1)} />
            <Tooltip formatter={(v: number, n: string) => (n === 'value' ? [`USD ${Number(v).toFixed(0)} million`, 'Value'] : [`USD ${Number(v).toFixed(2)} per kg`, 'Unit value'])} />
            <Line yAxisId="l" type="monotone" dataKey="value" stroke="var(--accent)" dot />
            <Line yAxisId="r" type="monotone" dataKey="uv" stroke="var(--muted)" strokeDasharray="4 3" dot />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="tiny dim">Solid line: value in USD million (left). Dashed: trade value per kg (right). Only years in which every importer in the coverage reported are shown.</p>
      <h3>Largest importers</h3>
      <table className="data-table">
        <thead><tr><th>Importer</th><th>Imports {p.period.latest}</th><th>Share</th><th>Change since {p.period.base}</th><th>Rank change</th></tr></thead>
        <tbody>
          {dm.importers.map((r) => (
            <tr key={r.iso3}><td>{nm(r.iso3)}</td><td>{usd(r.value_usd)}</td><td>{r.share_pct == null ? 'n/a' : `${r.share_pct.toFixed(1)}%`}</td>
              <td style={{ color: tone(r.growth_pct) }}>{pct(r.growth_pct)}</td><td>{rankTxt(r.rank_change)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="tiny dim">Imports are what these countries reported receiving. Unattributed partner areas stay in the totals. Unit values are value divided by reported weight; they move with product mix and quality and are not prices.</p>
    </>
  );
}

function Supply({ d }: { d: ProductIntel }) {
  const p = d.product;
  const s = p.supply;
  const ex = s.reported_exports;
  return (
    <>
      <div className="portal-tiles">
        <Stat label="Supplier concentration (HHI)" value={s.hhi == null ? 'n/a' : s.hhi.toFixed(3)} sub={`${s.hhi_change == null ? 'n/a' : (s.hhi_change > 0 ? '+' : '') + s.hhi_change.toFixed(4)} since ${p.period.base}`} />
        <Stat label="Largest supplier's share" value={s.top_share_pct == null ? 'n/a' : `${s.top_share_pct.toFixed(1)}%`} sub={s.base_top_share_pct == null ? undefined : `${s.base_top_share_pct.toFixed(1)}% in ${p.period.base}`} />
        <Stat label="Exports reported by coverage countries" value={usd(ex.value_usd)} sub={`${pct(ex.value_growth_pct)} value, ${pct(ex.weight_growth_pct)} quantity`} />
      </div>
      <h3>Largest suppliers into the coverage countries</h3>
      <table className="data-table">
        <thead><tr><th>Supplier</th><th>Sales {p.period.latest}</th><th>Share</th><th>Share change</th><th>Growth</th><th>Value per kg</th><th>Rank change</th></tr></thead>
        <tbody>
          {s.suppliers.map((r) => (
            <tr key={r.iso3}><td>{nm(r.iso3)}</td><td>{usd(r.value_usd)}</td><td>{r.share_pct == null ? 'n/a' : `${r.share_pct.toFixed(1)}%`}</td>
              <td style={{ color: tone(r.share_change_pp) }}>{r.share_change_pp == null ? 'n/a' : `${r.share_change_pp > 0 ? '+' : ''}${r.share_change_pp.toFixed(1)} pts`}</td>
              <td style={{ color: tone(r.growth_pct) }}>{pct(r.growth_pct)}</td><td>{r.unit_value == null ? 'n/a' : `USD ${r.unit_value.toFixed(2)}`}</td>
              <td>{rankTxt(r.rank_change)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="tiny dim">Suppliers are named countries as seen by the importers in the coverage. Exports reported by the coverage countries themselves are a separate, smaller view of supply and do not reconcile exactly with imports.</p>
      <h3>Reported exports against reported imports</h3>
      <p className="small">
        For {p.mirror.pairs} country pairs where both sides reported in {p.period.latest}: suppliers reported {usd(p.mirror.exports_reported_usd)} and buyers reported {usd(p.mirror.imports_reported_usd)}
        {p.mirror.imports_over_exports != null ? `, a ratio of ${p.mirror.imports_over_exports.toFixed(2)} imports to exports` : ''}. Differences are expected from freight and insurance, timing and re-exports.
      </p>
    </>
  );
}

function Pressure({ d }: { d: ProductIntel }) {
  const pr = d.product.pressure;
  const i = pr.indicators;
  const rows: [string, number | null | undefined, string][] = [
    ['Import value growth', i.demand_value_growth, '%'], ['Import quantity growth', i.demand_qty_growth, '%'], ['Unit value change', i.unit_value_change, '%'],
    ['Supplier concentration change (HHI)', i.hhi_change, ''], ['Largest supplier share change', i.top_share_change_pp, ' pts'],
    ['Reported export quantity growth', i.supply_qty_growth, '%'], ['Reported export value growth', i.supply_value_growth, '%'], ['Reported export unit value change', i.supply_unit_value_change, '%'],
  ];
  return (
    <>
      <p className="small">Each indicator below is calculated from reported trade. The signals are the product's position among all products in the same calculation (top or bottom fifth). There is no composite score and no shortage estimate.</p>
      {pr.states.length === 0 && <p className="tiny dim">{pr.note}</p>}
      {pr.states.map((s) => (
        <div key={s.state} className="callout" style={{ marginBottom: 8 }}>
          <span className="callout-title">{STATE_TEXT[s.state] ?? s.state} </span><span className={`chip ${s.kind === 'heuristic' ? 'warning' : 'on'}`}>{s.kind === 'heuristic' ? 'Heuristic signal' : 'Derived from data'}</span>
          <div className="tiny dim">{s.basis}</div>
        </div>
      ))}
      <table className="data-table">
        <thead><tr><th>Indicator</th><th>Value</th></tr></thead>
        <tbody>{rows.map(([l, v, u]) => <tr key={l}><td>{l}</td><td>{v == null ? 'n/a' : `${v > 0 ? '+' : ''}${u === '' ? v.toFixed(4) : v.toFixed(1)}${u}`}</td></tr>)}</tbody>
      </table>
      <p className="tiny dim">Rising import value with falling quantity usually means higher prices, not more demand. Rising unit value does not by itself show a shortage. Import growth alone does not show unmet demand.</p>
    </>
  );
}

function Competitiveness({ d }: { d: ProductIntel }) {
  const p = d.product;
  return (
    <>
      <p className="small">How the leading suppliers' sales into the coverage countries changed between {p.period.base} and {p.period.latest}, split into what came from the market growing, from where they sold, and from everything else (an accounting residual, not proof of better productivity).</p>
      <table className="data-table">
        <thead><tr><th>Supplier</th><th>Change in sales</th><th>Market growth effect</th><th>Distribution effect</th><th>Competitiveness effect</th><th>New markets</th><th>RCA</th></tr></thead>
        <tbody>
          {p.competitiveness.map((c) => (
            <tr key={c.iso3}><td>{nm(c.iso3)}</td>
              <td>{c.cms ? usd(c.cms.total_change) : 'n/a'}</td><td>{c.cms ? usd(c.cms.growth) : 'n/a'}</td><td>{c.cms ? usd(c.cms.distribution) : 'n/a'}</td>
              <td style={{ color: c.cms ? tone(c.cms.competitiveness) : undefined }}>{c.cms ? usd(c.cms.competitiveness) : 'n/a'}</td><td>{c.cms ? usd(c.cms.new_markets) : 'n/a'}</td>
              <td title={`Supplier product ${usd(c.rca_terms.supplier_product_usd)}, supplier all products ${usd(c.rca_terms.supplier_all_usd)}, product in all imports ${usd(c.rca_terms.world_product_usd)}, all imports ${usd(c.rca_terms.world_all_usd)}`}>{c.rca == null ? 'n/a' : c.rca.toFixed(2)}</td></tr>
          ))}
        </tbody>
      </table>
      <p className="tiny dim">The four effects add up to the change in sales. RCA above 1 means the product is a larger share of that supplier's sales into these countries than of all imports into them; it is not a measure of productivity or profit. Hover an RCA value to see its four terms.</p>
    </>
  );
}

function NotBuilt({ which, d }: { which: string; d: ProductIntel }) {
  const text = d.methods?.not_implemented ?? [];
  const title = which === 'opportunities' ? 'Market opportunities' : which === 'mapping' ? 'Industry mapping' : 'Production network';
  const hint = which === 'opportunities'
    ? 'Opportunity screening by target market is the next step and is not calculated yet. Nothing is shown rather than an illustration.'
    : 'This needs an HS to industry concordance and a licensed input-output source, neither of which is loaded. Nothing is shown rather than an illustration.';
  return (
    <>
      <Empty title={`${title}: not built yet`} hint={hint} />
      {text.length > 0 && <ul className="tiny dim">{text.map((t) => <li key={t}>{t}</li>)}</ul>}
    </>
  );
}

function Method({ d }: { d: ProductIntel }) {
  const m = d.methods;
  const run = d.run;
  return (
    <>
      <h3>How the figures are calculated</h3>
      {m ? (
        <dl className="small">
          {(['universe', 'imports', 'shares', 'hhi', 'unit_value', 'rca', 'cms', 'mirror', 'pressure'] as const).map((k) => (
            <div key={k} style={{ marginBottom: 8 }}><dt><strong>{k.replace('_', ' ')}</strong></dt><dd style={{ margin: 0 }}>{m[k]}</dd></div>
          ))}
        </dl>
      ) : <p className="tiny dim">Method text unavailable.</p>}
      <h3>Data and coverage</h3>
      {run && (
        <p className="small">
          Calculated {run.computed_at} UTC for {run.products.toLocaleString()} products. Base year {run.base}, latest year {run.latest}. Importers in the comparison: {run.importers.map(nm).join(', ')}.
          Reporters left out because they did not report in both years: {run.excluded_reporters.map(nm).join(', ') || 'none'}.
        </p>
      )}
      <p className="tiny dim">Source: UN Comtrade, as ingested into Tereflow. The coverage is the set of reporting countries Tereflow holds, not every country in the world.</p>
    </>
  );
}
