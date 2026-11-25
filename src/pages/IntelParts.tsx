import { useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Empty, Skeletons } from '../components/ui';
import { ISO3_NAME } from '../../shared/country-names';
import type { IntelGravity, IntelIo, IntelMapping, IntelRegion, ProductIntel } from '../lib/intel-types';

const nm = (iso: string) => ISO3_NAME[iso] ?? iso;
const usd = (v: number | null | undefined) => (v == null ? 'n/a' : Math.abs(v) >= 1e9 ? `USD ${(v / 1e9).toFixed(2)}bn` : Math.abs(v) >= 1e6 ? `USD ${(v / 1e6).toFixed(1)}m` : `USD ${Math.round(v).toLocaleString()}`);
const pct = (v: number | null | undefined, d = 1) => (v == null ? 'n/a' : `${v > 0 ? '+' : ''}${v.toFixed(d)}%`);
const tone = (v: number | null | undefined) => (v == null || v === 0 ? 'var(--muted)' : v > 0 ? 'var(--up)' : 'var(--down)');
const cents = (v: number | null | undefined) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} cents`);

const FLAG_TEXT: Record<string, string> = {
  revealed_advantage: 'RCA above 1', growing_faster_than_this_market: 'Growing faster than this market', lower_unit_value_than_this_market: 'Lower value per kg than this market', within_8000km: 'Within 8000 km',
};
const CATEGORY_TEXT: Record<string, string> = { direct: 'Direct: one industry reached', derived_multiple: 'Derived: several industries, unweighted', unresolved: 'Unresolved' };

export function Opportunities({ d }: { d: ProductIntel }) {
  const p = d.product;
  const o = p.opportunities;
  const a = p.armington;
  const [grav, setGrav] = useState<IntelGravity | null>(null);
  useEffect(() => { setGrav(null); api.intel.gravity(p.hs6).then(setGrav).catch(() => setGrav(null)); }, [p.hs6]);
  return (
    <>
      <h3>Market opportunities (screening)</h3>
      {!o ? <p className="tiny dim">Opportunity screening has not been calculated for this product yet. Run the product intelligence pipeline again.</p> : (
        <>
          <p className="small">For each of the largest importing markets, suppliers that already trade this product with the coverage countries, are not entrenched in that market (under 5 percent share), and meet at least two evidence tests. This is a screening signal, not a forecast.</p>
          {o.markets.map((m) => (
            <div key={m.iso3} style={{ marginBottom: 14 }}>
              <strong>{nm(m.iso3)}</strong> <span className="tiny dim">imports {usd(m.value_usd)}, {pct(m.growth_pct)} since {p.period.base}, {m.supplier_count} suppliers{m.effective_suppliers != null ? `, about ${m.effective_suppliers} effective suppliers` : ''}{m.top3_share_pct != null ? `, top three hold ${m.top3_share_pct.toFixed(0)}%` : ''}</span>
              {m.candidates.length === 0 ? <div className="tiny dim">No supplier passes two tests here.</div> : (
                <div style={{ overflowX: 'auto' }}><table className="data-table">
                  <thead><tr><th>Candidate supplier</th><th>Share here</th><th>Global sales</th><th>Global growth</th><th>RCA</th><th>Value per kg</th><th>Distance</th><th>Why it is listed</th></tr></thead>
                  <tbody>
                    {m.candidates.map((c) => (
                      <tr key={c.iso3}><td>{nm(c.iso3)}</td><td>{c.share_in_market_pct.toFixed(2)}%</td><td>{usd(c.global_sales_usd)}</td><td style={{ color: tone(c.global_growth_pct) }}>{pct(c.global_growth_pct)}</td>
                        <td>{c.rca == null ? 'n/a' : c.rca.toFixed(2)}</td><td>{c.unit_value == null ? 'n/a' : `USD ${c.unit_value.toFixed(2)}`}</td><td>{c.distance_km == null ? 'n/a' : `${c.distance_km.toLocaleString()} km`}</td>
                        <td className="tiny">{c.flags.map((f) => FLAG_TEXT[f] ?? f).join('; ')}</td></tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </div>
          ))}
          <p className="tiny dim">{o.limits.join(' ')}</p>
        </>
      )}

      <h3>Supplier differentiation (descriptive)</h3>
      {!a ? <p className="tiny dim">Not calculated yet.</p> : (
        <>
          <p className="small">
            About {a.effective_suppliers ?? 'n/a'} effective suppliers. Value per kg varies across the leading suppliers by a coefficient of variation of {a.unit_value_dispersion_cv ?? 'n/a'}.
            {a.rank_corr_unit_value_change_vs_share_change != null ? ` Suppliers whose value per kg rose relative to the market ${a.rank_corr_unit_value_change_vs_share_change > 0 ? 'tended to gain' : 'tended to lose'} share (rank correlation ${a.rank_corr_unit_value_change_vs_share_change.toFixed(2)}).` : ''}
          </p>
          <div style={{ overflowX: 'auto' }}><table className="data-table">
            <thead><tr><th>Supplier</th><th>Value per kg</th><th>Against market</th><th>Relative change since {p.period.base}</th><th>Share change</th></tr></thead>
            <tbody>
              {a.suppliers.map((s) => (
                <tr key={s.iso3}><td>{nm(s.iso3)}</td><td>{s.unit_value == null ? 'n/a' : `USD ${s.unit_value.toFixed(2)}`}</td><td>{pct(s.unit_value_vs_market_pct, 0)}</td>
                  <td>{s.relative_unit_value_change_pp == null ? 'n/a' : `${s.relative_unit_value_change_pp > 0 ? '+' : ''}${s.relative_unit_value_change_pp.toFixed(1)} pts`}</td>
                  <td style={{ color: tone(s.share_change_pp) }}>{s.share_change_pp == null ? 'n/a' : `${s.share_change_pp > 0 ? '+' : ''}${s.share_change_pp.toFixed(2)} pts`}</td></tr>
              ))}
            </tbody>
          </table></div>
          <p className="tiny dim">{a.note}</p>
        </>
      )}

      <h3>Trade potential (model estimate)</h3>
      <Gravity g={grav} hs6={p.hs6} latest={p.period.latest} />
    </>
  );
}

function Gravity({ g, hs6, latest }: { g: IntelGravity | null; hs6: string; latest: number }) {
  if (!g) return <Skeletons n={1} />;
  const m = g.model;
  if (!m) return <p className="tiny dim">No gravity model could be fitted for HS chapter {hs6.slice(0, 2)}{g.meta?.failed?.[hs6.slice(0, 2)] ? `: ${g.meta.failed[hs6.slice(0, 2)]}` : ' (not calculated yet)'}.</p>;
  const v = m.validation;
  const beats = v.model_beats_baseline;
  const c = m.coefficients;
  const rows = Object.entries(m.model_vs_observed).flatMap(([imp, lst]) => lst.slice(0, 3).map((r) => ({ imp, ...r }))).sort((a, b) => b.model_usd * (1 - b.observed_over_model) - a.model_usd * (1 - a.observed_over_model)).slice(0, 15);
  return (
    <>
      <div className="callout">
        <span className="callout-title">Estimate, not observed trade. </span>
        Fitted on HS chapter {g.chapter} for {g.year ?? latest}: {m.pairs.toLocaleString()} country pairs ({m.positive_flows.toLocaleString()} with trade, {m.zero_flows.toLocaleString()} with none), importer and exporter effects, distance and shared borders, language and colonial ties.
        {' '}Held-out test: {beats ? 'the model predicted unseen pairs better than a model with no trade costs' : 'the model did NOT clearly beat a model with no trade costs, so treat these gaps with extra caution'}
        {v.better_than_baseline_on && v.better_than_baseline_on.length > 0 ? ` (better on ${v.better_than_baseline_on.join(' and ').replace('_', ' ')})` : ''}.
      </div>
      <p className="tiny dim">
        Distance elasticity {c.ln_distance?.coef.toFixed(2)} (s.e. {c.ln_distance?.se.toFixed(2)}); contiguity {c.contiguity?.coef.toFixed(2)}; common language {c.common_language?.coef.toFixed(2)}; colonial tie {c.colonial_tie?.coef.toFixed(2)}. Pseudo R squared {m.pseudo_r2 ?? 'n/a'}.
      </p>
      {rows.length > 0 && (
        <div style={{ overflowX: 'auto' }}><table className="data-table">
          <thead><tr><th>Importer</th><th>Exporter</th><th>Observed imports (whole chapter)</th><th>Model-expected</th><th>Observed over expected</th><th>Distance</th></tr></thead>
          <tbody>
            {rows.map((r) => <tr key={`${r.imp}-${r.exporter}`}><td>{nm(r.imp)}</td><td>{nm(r.exporter)}</td><td>{usd(r.observed_usd)}</td><td>{usd(r.model_usd)}</td><td>{r.observed_over_model.toFixed(2)}</td><td>{r.distance_km.toLocaleString()} km</td></tr>)}
          </tbody>
        </table></div>
      )}
      <p className="tiny dim">{m.note} The figures are for the whole HS chapter, not this single product. Distance data: {g.meta?.source?.name}, {g.meta?.source?.licence?.split('(')[0]}.</p>
    </>
  );
}

export function Mapping({ d }: { d: ProductIntel }) {
  const hs6 = d.product.hs6;
  const [m, setM] = useState<IntelMapping | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => { setM(null); setErr(''); api.intel.mapping(hs6).then(setM).catch((e) => setErr(String(e?.message ?? e))); }, [hs6]);
  if (err) return <Empty title="No industry mapping for this product" hint={err} />;
  if (!m) return <Skeletons n={2} />;
  const map = m.map;
  return (
    <>
      <p className="small">
        HS {hs6} is linked to industries through official UN correspondence tables: HS to Central Product Classification (CPC 2.1), then to ISIC Rev.4, then to the Eurostat FIGARO industry list. Every pairing shown is a possible link. The tables carry no weights, so none are shown.
      </p>
      <p><span className={`chip ${m.category === 'direct' ? 'on' : m.category === 'unresolved' ? 'error' : 'warning'}`}>{CATEGORY_TEXT[m.category] ?? m.category}</span>
        <span className="tiny dim" style={{ marginLeft: 8 }}>HS basis {map.hs_basis}; relationship to HS2017: {map.hs2022_hs2017_relationship.join(', ') || 'n/a'}; mapping {m.version}</span></p>
      {map.industries.length === 0 ? <p className="small">{map.unresolved_reason ?? 'No industry could be reached.'} Nothing is forced into an industry.</p> : (
        <div style={{ overflowX: 'auto' }}><table className="data-table">
          <thead><tr><th>Industry (FIGARO)</th><th>ISIC Rev.4</th><th>CPC 2.1</th><th>Partial links</th></tr></thead>
          <tbody>
            {map.industries.map((i) => (
              <tr key={i.figaro}><td><strong>{i.figaro}</strong> {m.industries[i.figaro] ?? ''}</td><td>{i.isic4.join(', ')}</td><td>{i.cpc21.join(', ')}</td><td>{i.any_partial ? 'Yes: only part of the product or industry is covered by this pairing' : 'No'}</td></tr>
            ))}
          </tbody>
        </table></div>
      )}
      <ul className="tiny dim">{map.caveats.map((c) => <li key={c}>{c}</li>)}</ul>
      <p className="tiny dim">Sources: {m.sources.map((s) => s.name).join('; ')}. Retrieved {m.sources[0]?.retrieved_at ?? 'n/a'}.</p>
    </>
  );
}

export function Network({ d }: { d: ProductIntel }) {
  const hs6 = d.product.hs6;
  const [map, setMap] = useState<IntelMapping | null>(null);
  const [regions, setRegions] = useState<IntelRegion[]>([]);
  const [country, setCountry] = useState('');
  const [industry, setIndustry] = useState('');
  const [io, setIo] = useState<IntelIo | null>(null);
  const [err, setErr] = useState('');
  const [ioErr, setIoErr] = useState('');
  useEffect(() => {
    setMap(null); setErr('');
    Promise.all([api.intel.mapping(hs6), api.intel.regions()]).then(([m, r]) => {
      setMap(m); setRegions(r.regions);
      const inds = m.map.industries.map((i) => i.figaro);
      setIndustry(inds[0] ?? '');
      const byIso = new Map(r.regions.filter((x) => x.iso3).map((x) => [x.iso3 as string, x.code]));
      const top = d.product.supply.suppliers.map((s) => byIso.get(s.iso3)).find(Boolean);
      setCountry(top ?? 'DE');
    }).catch((e) => setErr(String(e?.message ?? e)));
  }, [hs6, d.product.supply.suppliers]);
  useEffect(() => {
    if (!country || !industry) return;
    setIo(null); setIoErr('');
    api.intel.io(country, industry).then(setIo).catch((e) => setIoErr(String(e?.message ?? e)));
  }, [country, industry]);
  const label = useMemo(() => new Map(regions.map((r) => [r.code, r.name ?? r.code])), [regions]);
  if (err) return <Empty title="No production network for this product" hint={err} />;
  if (!map) return <Skeletons n={2} />;
  if (map.map.industries.length === 0) return <Empty title="Production network not available" hint="This product could not be linked to an industry, so no upstream dependencies are shown." />;
  const x = io?.io;
  const cname = (code: string, iso3: string | null) => (iso3 ? nm(iso3) : label.get(code) ?? code);
  return (
    <>
      <p className="small">Which industries, and in which countries, supply the industry that makes this product, from the Eurostat FIGARO inter-country input-output table. These are industry averages for a whole industry, not a bill of materials for HS {hs6}.</p>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 8 }}>
        <label className="small">Producing industry{' '}
          <select value={industry} onChange={(e) => setIndustry(e.target.value)}>
            {map.map.industries.map((i) => <option key={i.figaro} value={i.figaro}>{i.figaro} {map.industries[i.figaro]}</option>)}
          </select>
        </label>
        <label className="small">Producing country or region{' '}
          <select value={country} onChange={(e) => setCountry(e.target.value)}>
            {regions.map((r) => <option key={r.code} value={r.code}>{r.name ?? r.code}</option>)}
          </select>
        </label>
      </div>
      {map.map.industries.length > 1 && <p className="tiny dim">This product maps to several industries with no weights, so each is shown separately. Pick one; nothing is averaged.</p>}
      {ioErr ? <Empty title="No result for this choice" hint={ioErr} /> : !x ? <Skeletons n={2} /> : (
        <>
          <div className="portal-tiles">
            <div className="stat"><div className="label">Industry output, {x.year}</div><div className="value">EUR {(x.output_meur / 1000).toFixed(1)}bn</div><div className="tiny dim">{cname(x.country, x.country_iso3)}, {x.industry_name}</div></div>
            <div className="stat"><div className="label">Inputs bought per euro of output</div><div className="value">{cents(x.intermediate_input_share)}</div><div className="tiny dim">direct, all suppliers</div></div>
            <div className="stat"><div className="label">Total upstream requirement</div><div className="value">{cents(x.total_requirement)}</div><div className="tiny dim">direct plus indirect, excluding its own industry</div></div>
            <div className="stat"><div className="label">Supplied from the same country</div><div className="value">{x.domestic_share_total == null ? 'n/a' : `${(x.domestic_share_total * 100).toFixed(0)}%`}</div><div className="tiny dim">{x.domestic_share_direct == null ? '' : `${(x.domestic_share_direct * 100).toFixed(0)}% of direct inputs`}</div></div>
          </div>
          <h3>Largest direct suppliers</h3>
          <div style={{ overflowX: 'auto' }}><table className="data-table">
            <thead><tr><th>Supplier</th><th>Industry</th><th>Per euro of output</th><th>Value</th></tr></thead>
            <tbody>{x.direct_top.slice(0, 10).map((r) => <tr key={`${r.country}-${r.industry}`}><td>{cname(r.country, r.iso3)}</td><td>{r.industry} {r.industry_name}{r.self ? ' (own industry)' : ''}</td><td>{cents(r.coef)}</td><td>EUR {(r.value_meur ?? 0).toLocaleString(undefined, { maximumFractionDigits: 0 })}m</td></tr>)}</tbody>
          </table></div>
          <h3>Largest suppliers including indirect (the whole chain)</h3>
          <div style={{ overflowX: 'auto' }}><table className="data-table">
            <thead><tr><th>Supplier</th><th>Industry</th><th>Total</th><th>Of which direct</th><th>Of which indirect</th></tr></thead>
            <tbody>{x.total_top.slice(0, 10).map((r) => <tr key={`${r.country}-${r.industry}`}><td>{cname(r.country, r.iso3)}</td><td>{r.industry} {r.industry_name}</td><td>{cents(r.total)}</td><td>{cents(r.direct)}</td><td>{cents(r.indirect)}</td></tr>)}</tbody>
          </table></div>
          <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 280, maxWidth: '100%' }}>
              <h3>By supplier country (total)</h3>
              <div style={{ overflowX: 'auto' }}><table className="data-table"><thead><tr><th>Country</th><th>Direct</th><th>Total</th></tr></thead>
                <tbody>{x.by_supplier_country.slice(0, 10).map((r) => <tr key={r.country}><td>{cname(r.country, r.iso3)}</td><td>{cents(r.direct)}</td><td>{cents(r.total)}</td></tr>)}</tbody></table></div>
            </div>
            <div style={{ flex: 1, minWidth: 280, maxWidth: '100%' }}>
              <h3>By supplier industry (total)</h3>
              <div style={{ overflowX: 'auto' }}><table className="data-table"><thead><tr><th>Industry</th><th>Direct</th><th>Total</th></tr></thead>
                <tbody>{x.by_supplier_industry.slice(0, 10).map((r) => <tr key={r.industry}><td>{r.industry} {r.industry_name}</td><td>{cents(r.direct)}</td><td>{cents(r.total)}</td></tr>)}</tbody></table></div>
            </div>
          </div>
          <p className="tiny dim">Cents of input per euro of the industry's output, {x.price_basis}. Direct requirement is input bought straight from the supplier industry. Total requirement comes from the Leontief inverse and also counts what those suppliers had to buy in turn; indirect is the total minus the direct. A country coverage note: {io?.source?.coverage_note}</p>
          {io?.source && <p className="tiny dim">Source: {io.source.dataset}, year {io.source.year}, last updated {io.source.last_update.join(', ')}. {io.source.licence} {io.source.modification_note}</p>}
        </>
      )}
    </>
  );
}
