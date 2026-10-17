import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import SandboxLink from './SandboxLink';
import SaveButton from './SaveButton';
import type { RegulatorySummary } from '../../shared/regulatory';
import type { DiscoveryResult } from '../../shared/discovery';
import type { ProductionSignal } from '../../shared/production';
import { analyseUnitValues } from '../../shared/unit-value';
import { unitCostTrend } from '../../shared/unit-cost';
import { byproductAnalysis } from '../../shared/byproducts';
import { landedCost, INCOTERMS, type Incoterm } from '../../shared/frameworks';
import type { fxRisk, saturation } from '../../shared/prospect';
import type { readTariff } from '../../shared/tariff';
import { useBudget } from '../lib/budget';
import { budgetFit, fmtQuantity } from '../../shared/budget';
import { CHART } from '../lib/theme';
import { Empty, FollowButton } from './ui';
import {
  isNewTrade,
  MOMENTUM_SCORE_LABEL,
  scoreBand,
  SCORE_BAND_LABEL,
  SCORE_BASIS,
  SCORE_NOT_COMPARABLE,
} from '../../shared/opportunity';
import { hasLongerDescription } from '../../shared/product-name';
import {
  fmtPct,
  fmtUsd,
  PRICE_PREMIUM_LABEL,
  type ProductCard,
  type ProductCountryRow,
  type ProductInsight,
} from '../../shared/types';

/**
 * One product as a tappable row. The card design lives here so Home, the
 * product list and anywhere else that lists products all read the same way.
 * Tapping is the caller's job (it opens the modal), so this stays a plain
 * button and never navigates on its own.
 */
export function ProductCardRow({
  product,
  budget = 0,
  onOpen,
}: {
  product: ProductCard;
  /** Working budget in US dollars. Zero hides the quantity line entirely. */
  budget?: number;
  /**
   * The row names one country, so the modal opens on that country's figures.
   * Tapping Nigeria's cocoa and reading Cote d'Ivoire's numbers is the kind
   * of small mismatch that costs a reader their trust in the whole page.
   */
  onOpen: (hsCode: string, countrySlug: string, flow: 'export' | 'import') => void;
}) {
  const band = product.band;
  const fit = budget > 0 ? budgetFit(budget, product.unit_value_usd_t) : null;
  const qty = fit ? fmtQuantity(fit) : null;
  return (
    <button
      type="button"
      className="product-row"
      onClick={() => onOpen(product.hs_code, product.slug, product.flow)}
      aria-label={`${product.name}, ${product.country}, score ${product.score} of 100`}
    >
      <span className="flag">{product.iso3 ?? '??'}</span>
      <span className="grow">
        <span className="name">{product.name}</span>
        <span className="tiny dim product-row-meta">
          <span className={`badge ${product.flow === 'export' ? 'on' : 'moderate'}`}>
            {product.flow === 'export' ? 'Export' : 'Import'}
          </span>
          {product.country}
          {product.value_usd > 0 && <> {'\u00b7'} {fmtUsd(product.value_usd)}</>}
          {product.growth_pct != null &&
            (isNewTrade(product.growth_pct) ? (
              <> {'\u00b7'} <span className="up">Newly established</span></>
            ) : (
              <>
                {' \u00b7 '}
                <span className={product.growth_pct >= 0 ? 'up' : 'down'}>
                  {fmtPct(product.growth_pct, 0)}/yr
                </span>
              </>
            ))}
        </span>
        {product.best_market && (
          <span className="tiny dim">
            {product.best_market_product_specific
              ? `Biggest market for this product: ${product.best_market}`
              : `Biggest ${product.flow === 'export' ? 'buyer' : 'supplier'} overall: ${product.best_market}`}
          </span>
        )}
        {/* Three outcomes, and no price is its own answer rather than a no. */}
        {fit && (
          <span className="tiny budget-line">
            {fit.fits ? (
              <>
                <span className="up">Your budget buys about {qty}</span>
                <span className="dim"> at ${Math.round(fit.usd_per_tonne ?? 0).toLocaleString()}/t</span>
              </>
            ) : fit.tonnes != null ? (
              <span className="dim">
                Your budget buys {qty}, under a tonne at $
                {Math.round(fit.usd_per_tonne ?? 0).toLocaleString()}/t
              </span>
            ) : (
              <span className="dim">No weight reported, so no price to work from</span>
            )}
          </span>
        )}
      </span>
      <span className="product-row-score" style={{ flex: 'none', textAlign: 'right' }}>
        <span className={`badge ${band}`} title={product.has_signal ? SCORE_BASIS : 'This product was found in the trade data but has not been ranked as an opportunity.'}>
          {product.has_signal ? `${product.score}/100` : 'Not scored'}
        </span>
        <span className="tiny dim" style={{ display: 'block', marginTop: 4 }}>
          {product.has_signal ? SCORE_BAND_LABEL[band] : 'Trade data found'}
        </span>
      </span>
    </button>
  );
}

/* ---------- number formatting ---------- */

const NF0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const NF1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const NF2 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 });

function withDigits(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 100) return NF0.format(n);
  if (abs >= 10) return NF1.format(n);
  return NF2.format(n);
}

/**
 * Unit values run from a few thousand dollars a tonne for food to tens of
 * millions for gold. Printing gold as "$101,714,124/t" reads like a bug, so
 * the unit steps up to per kilo and then per gram once the number gets big.
 * Null means no weight was reported, which is not the same as a price of zero.
 */
function fmtUnitValue(usdPerTonne: number | null): string {
  if (usdPerTonne == null) return 'Not reported';
  let value = usdPerTonne;
  let unit = 't';
  if (value >= 1_000_000) {
    value = value / 1000;
    unit = 'kg';
  }
  if (value >= 1_000_000) {
    value = value / 1000;
    unit = 'g';
  }
  return `$${withDigits(value)}/${unit}`;
}

/**
 * Weight in kilograms as reported. Tonnes for anything of size, but a handful
 * of kilos must not round down to "0 t" and read as nothing traded, so small
 * quantities stay in kilograms.
 */
function fmtVolume(qtyKg: number | null): string {
  if (qtyKg == null) return 'Not reported';
  const tonnes = qtyKg / 1000;
  if (tonnes < 1) return `${NF0.format(qtyKg)} kg`;
  if (tonnes < 10) return `${NF1.format(tonnes)} t`;
  return `${NF0.format(Math.round(tonnes))} t`;
}

/**
 * Growth that came off a negligible base is not a rate, so it is named rather
 * than shown as a percentage that would imply a trend. Null stays blank.
 */
function growthText(cagr: number | null): { text: string; tone: string } {
  if (cagr == null) return { text: 'Not reported', tone: '' };
  if (isNewTrade(cagr)) return { text: 'Newly established', tone: 'up' };
  return { text: `${fmtPct(cagr, 1)}/yr`, tone: cagr >= 0 ? 'up' : 'down' };
}

/* ---------- target markets chart ---------- */

// Recharts needs concrete colours, so demand-growth bars cycle through a set
// of distinct tones rather than one flat colour.
const CHART_PALETTE = [
  '#0b3d67',
  '#a8802c',
  '#17604a',
  '#2f7db0',
  '#b5532a',
  '#6a4c93',
  '#3e8e7e',
  '#c0492f',
];

interface MarketDatum {
  name: string;
  growth: number;
  label: string;
}

function MarketTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: MarketDatum }>;
}) {
  if (!active || !payload?.length) return null;
  const d = payload[0].payload;
  return (
    <div
      style={{
        background: CHART.tooltipBg,
        border: `1px solid ${CHART.tooltipBorder}`,
        borderRadius: 8,
        fontSize: 13,
        padding: '8px 10px',
        boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
        maxWidth: 220,
      }}
    >
      <div style={{ color: CHART.tooltipLabel, marginBottom: 2 }}>{d.name}</div>
      <div style={{ fontWeight: 700 }}>{d.label} a year</div>
      <div className="tiny" style={{ color: CHART.tooltipLabel, marginTop: 2 }}>
        Import demand growth
      </div>
    </div>
  );
}

function TargetMarketsChart({ rows }: { rows: MarketDatum[] }) {
  const height = Math.max(140, rows.length * 40 + 24);
  return (
    <div style={{ height, margin: '0 -8px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart
          layout="vertical"
          data={rows}
          margin={{ top: 4, right: 48, left: 4, bottom: 0 }}
        >
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis
            type="number"
            stroke={CHART.axis}
            tick={{ fontSize: 10 }}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${Math.round(v)}%`}
          />
          <YAxis
            type="category"
            dataKey="name"
            stroke={CHART.axis}
            tickLine={false}
            axisLine={false}
            width={108}
            interval={0}
            tick={{ fontSize: 10, fill: CHART.axis }}
          />
          <Tooltip cursor={{ fill: CHART.brandSoft }} content={<MarketTooltip />} />
          <Bar dataKey="growth" radius={[0, 3, 3, 0]}>
            {rows.map((_, idx) => (
              <Cell key={idx} fill={CHART_PALETTE[idx % CHART_PALETTE.length]} />
            ))}
            <LabelList dataKey="label" position="right" fill={CHART.tooltipLabel} fontSize={10} />
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------- tiles and tables ---------- */

function Tile({
  k,
  v,
  s,
  tone,
  text,
  title,
  onClick,
  expanded,
}: {
  k: string;
  v: string;
  s?: string | null;
  tone?: string;
  text?: boolean;
  title?: string;
  /** When given, the tile becomes a button that reveals its own reasoning. */
  onClick?: () => void;
  expanded?: boolean;
}) {
  const body = (
    <>
      <span className="k">
        {k}
        {onClick && (
          <span className="tiny dim" style={{ marginLeft: 6 }}>
            {expanded ? 'hide' : 'why?'}
          </span>
        )}
      </span>
      <span className={`v${tone ? ` ${tone}` : ''}`} title={title}>
        {v}
      </span>
      {s && <span className="s">{s}</span>}
    </>
  );

  if (!onClick) {
    return <div className={`insight-tile${text ? ' text' : ''}`}>{body}</div>;
  }

  // A real button rather than a clickable div, so it reaches the keyboard and
  // announces itself to a screen reader instead of looking interactive only to
  // a mouse.
  return (
    <button
      type="button"
      className={`insight-tile${text ? ' text' : ''} tile-button`}
      onClick={onClick}
      aria-expanded={expanded}
    >
      {body}
    </button>
  );
}

/**
 * Where a country's trade in one product actually comes from or goes to.
 *
 * This is the question the modal used to carry a caption apologising for. On
 * the Comtrade tier it genuinely could not be answered: partner and product
 * cannot be fetched together without a key. A country read from its own
 * statistics office does carry it, so it is shown for those and still refused
 * for the rest rather than filled in with something that looks similar.
 *
 * Kept visually distinct from the world totals underneath for the same reason.
 * "United States 27.5%" means something entirely different in each table, and a
 * reader who conflates them has been misled by the layout rather than by any
 * individual number.
 */
function PartnerFlows({ flows, countrySlug }: { flows: NonNullable<ProductInsight['partner_flows']>; countrySlug: string | null }) {
  const top = flows.partners.slice(0, 12);
  const rest = flows.partners.length - top.length;
  const direction = flows.trade_flow === 'import' ? 'comes from' : 'goes to';
  const uv = analyseUnitValues(flows.partners);
  const uvByPartner = new Map(uv.rows.map((r) => [r.partner, r]));

  return (
    <div className="card">
      <p className="card-title">
        Where {flows.country_name}&apos;s {flows.trade_flow === 'import' ? 'supply' : 'trade'} {direction}
      </p>
      <p className="tiny dim" style={{ margin: '0 0 8px' }}>
        {flows.country_name}&apos;s own {flows.trade_flow}s of this line in {flows.year}, by partner
        country, from {flows.source}.
        {flows.is_chapter_level && (
          <>
            {' '}
            The source reports partners at chapter level, so these are chapter{' '}
            {flows.product_code} rather than {flows.requested_code} exactly.
          </>
        )}
      </p>

      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Partner</th>
              <th className="align-right">Value</th>
              <th className="align-right">Share</th>
              <th className="align-right">Unit value</th>
              <th className="align-right">vs median</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {top.map((p) => (
              <tr key={p.partner}>
                <td>{p.partner}</td>
                <td className="align-right">{fmtUsd(p.value_usd)}</td>
                <td className="align-right">{p.share_pct.toFixed(1)}%</td>
                <td className="align-right">
                  {/* Blank weight is common in this source. Saying so beats a
                      zero, which would read as goods that cost nothing. */}
                  {p.unit_value_usd_per_kg == null
                    ? <span className="dim">Weight not reported</span>
                    : '$' + p.unit_value_usd_per_kg.toFixed(2) + '/kg'}
                </td>
                <td className="align-right">
                  {(() => {
                    const r = uvByPartner.get(p.partner);
                    return r ? (
                      <span className={r.position === 'in-line' ? 'dim' : r.position === 'above' ? 'up' : 'down'}>
                        {r.vs_median_pct > 0 ? '+' : ''}{r.vs_median_pct.toFixed(0)}%
                      </span>
                    ) : <span className="dim">{'\u2013'}</span>;
                  })()}
                </td>
                <td className="align-right">
                  <SandboxLink primarySlug={countrySlug} partnerIso3={p.iso3} hs={flows.requested_code} flow={flows.trade_flow} />
                  <SaveButton countrySlug={countrySlug} partnerIso3={p.iso3} hs={flows.requested_code} flow={flows.trade_flow} title={`${flows.country_name} ${flows.trade_flow} of ${flows.requested_code} ${flows.trade_flow === 'import' ? 'from' : 'to'} ${p.partner}`} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="tiny dim" style={{ marginTop: 6 }}>
        {fmtUsd(flows.total_usd)} across {flows.partner_count} partner
        {flows.partner_count === 1 ? '' : 's'}
        {rest > 0 ? ', ' + rest + ' smaller ones not shown' : ''}.
      </p>
      <p className="tiny dim" style={{ margin: '6px 0 0' }}>
        {uv.median_usd_per_kg != null && <>Median unit value ${uv.median_usd_per_kg.toFixed(2)}/kg across {uv.covered} partners ({uv.covered_value_pct}% of the value); a gap of more than 15% is marked. </>}
        {uv.limitations.join(' ')}
      </p>
    </div>
  );
}

/**
 * What the momentum score is made of.
 *
 * Every term shows the figure it came from, what it was worth out of 100,
 * and a note when it is standing in for something missing. The parts add to
 * the total on purpose: a breakdown that does not reconcile with the number
 * beside it is worse than none, because it teaches the reader that neither
 * can be relied on.
 */
function ScoreBreakdown({ breakdown }: { breakdown: NonNullable<ProductInsight['score_breakdown']> }) {
  return (
    <div className="card" style={{ marginTop: 10 }}>
      <p className="card-title">How this score was reached</p>
      <p className="tiny dim" style={{ margin: "0 0 8px" }}>
        Four weighted terms, adding to {breakdown.score} out of 100. Same figures in, same
        score out, every time.
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Term</th>
              <th>From</th>
              <th className="align-right">Weight</th>
              <th className="align-right">Points</th>
            </tr>
          </thead>
          <tbody>
            {breakdown.components.map((c) => (
              <tr key={c.label}>
                <td>
                  <div>{c.label}</div>
                  <div className="tiny dim">{c.meaning}</div>
                  {c.note && <div className="tiny dim">{c.note}</div>}
                </td>
                <td>{c.input}</td>
                <td className="align-right">{c.weight}</td>
                <td className="align-right">{c.points.toFixed(1)}</td>
              </tr>
            ))}
            <tr>
              <td colSpan={3} style={{ fontWeight: 650 }}>Total</td>
              <td className="align-right" style={{ fontWeight: 650 }}>{breakdown.score}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p className="tiny dim" style={{ marginTop: 6 }}>
        A score ranks one line against others on the same evidence. It is not a measure of
        whether a business will work, which depends on things no trade dataset records.
      </p>
      <p className="tiny dim" style={{ marginTop: 4 }}>
        {SCORE_NOT_COMPARABLE}
      </p>
    </div>
  );
}

function CountryTable({ title, rows }: { title: string; rows: ProductCountryRow[] }) {
  if (rows.length === 0) return null;
  return (
    <>
      <p className="overline" style={{ margin: '14px 0 6px' }}>
        {title}
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Country</th>
              <th className="align-right">Value</th>
              <th className="align-right">Volume</th>
              <th className="align-right">Unit value</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 10).map((r) => (
              <tr key={r.slug}>
                <td>{r.name}</td>
                <td className="align-right">{fmtUsd(r.value_usd)}</td>
                <td className="align-right">{fmtVolume(r.qty_kg)}</td>
                <td className="align-right">{fmtUnitValue(r.unit_value_usd_t)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

/* ---------- where the figures came from ---------- */

export function fmtReleased(r: string | null): string | null {
  if (!r) return null;
  if (/^\d{6}$/.test(r)) {
    const d = new Date(Date.UTC(Number(r.slice(0, 4)), Number(r.slice(4)) - 1, 1));
    return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  }
  const d = new Date(r);
  return Number.isNaN(d.getTime()) ? r : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * One line per source and detail level, naming the years it covers, plus the conversion to dollars when
 * the source reports in local currency, and the quantity in the source's own unit for the latest year.
 */
function ProvenanceBlock({
  notes,
  rows,
}: {
  notes: NonNullable<ProductInsight['provenance']>;
  rows: NonNullable<ProductInsight['time_series']>;
}) {
  const years = new Set(rows.map((r) => r.year));
  const shown = notes.filter((n) => years.has(n.year));
  const latestQty = [...rows].reverse().find((r) => r.qty != null && r.qty_unit);
  if (!shown.length && !latestQty) return null;
  const groups = new Map<string, typeof shown>();
  for (const n of shown) {
    const key = `${n.source}|${n.level ?? ''}`;
    groups.set(key, [...(groups.get(key) ?? []), n]);
  }
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Where these figures come from</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        {[...groups.values()].map((g) => {
          const last = g[g.length - 1];
          const span = g.length > 1 ? `${g[0].year} to ${last.year}` : String(last.year);
          const released = fmtReleased(last.released);
          const fx = last.currency && last.usd_per_unit ? `, converted from ${last.currency} at about ${last.usd_per_unit.toFixed(2)} dollars each` : '';
          return (
            <li key={`${last.source}|${last.level}`}>
              {span}: {last.source}
              {last.level ? `, ${last.level} detail` : ''}
              {released ? `, latest release ${released}` : ''}
              {fx}.
            </li>
          );
        })}
      </ul>
      {latestQty && (
        <p style={{ margin: '4px 0 0' }}>
          {latestQty.year} quantity in the source's own unit: {NF0.format(latestQty.qty as number)} {latestQty.qty_unit}.
        </p>
      )}
    </div>
  );
}

export function UnitCostBlock({ rows }: { rows: NonNullable<ProductInsight['time_series']> }) {
  const t = unitCostTrend(rows);
  if (!t.rows.length) return null;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Unit cost by year</strong>
      <table className="data-table" style={{ marginTop: 4 }}>
        <thead>
          <tr><th>Year</th><th className="align-right">Price</th><th className="align-right">Change</th></tr>
        </thead>
        <tbody>
          {t.rows.map((r) => (
            <tr key={r.year}>
              <td>{r.year}</td>
              <td className="align-right">${r.price.toFixed(r.price < 10 ? 2 : 0)} per {r.unit_label}</td>
              <td className="align-right">{r.change_pct == null ? '\u2013' : `${r.change_pct > 0 ? '+' : ''}${r.change_pct.toFixed(0)}%`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <p style={{ margin: '4px 0 0' }}>{t.limitations.join(' ')}</p>
    </div>
  );
}

type ProspectResponse =
  | { locked: true; title: string; teaser: string }
  | { locked: false; available: false; reason: string }
  | {
      locked: false;
      available: true;
      country: string;
      hs: string;
      export_year: number;
      buyers: Array<{
        iso3: string; name: string; export_value_usd: number; share_pct: number | null; import_year: number | null;
        saturation: ReturnType<typeof saturation> | null; saturation_note: string | null;
        fx: ReturnType<typeof fxRisk> | null; fx_note: string | null;
      }>;
      home_fx: (ReturnType<typeof fxRisk> & { iso3: string; name: string }) | null;
      sources: string[];
      limitations: string[];
    };

const FX_LABEL: Record<string, string> = { low: 'Low', moderate: 'Moderate', high: 'High', insufficient: 'Not enough data' };

export function ProspectBlock({ slug, hs }: { slug: string; hs: string }) {
  const [r, setR] = useState<ProspectResponse | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    setR(null);
    fetch(`/api/prospect/${encodeURIComponent(slug)}/${encodeURIComponent(hs)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
      .then((x) => { if (live) setR(x); })
      .catch(() => { if (live) setR('failed'); });
    return () => { live = false; };
  }, [slug, hs]);
  if (r === null || r === 'failed') return null;
  if (r.locked) {
    return (
      <div className="tiny dim" style={{ margin: '10px 0 0' }}>
        <strong>{r.title} <span className="badge premium">Premium</span></strong>
        <p style={{ margin: '4px 0 0' }}>{r.teaser} <Link to="/upgrade">See Premium</Link></p>
      </div>
    );
  }
  if (!r.available) return <p className="tiny dim" style={{ margin: '10px 0 0' }}><strong>Business prospect view</strong>: {r.reason}</p>;
  const usdM = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(1)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Business prospect view <span className="badge premium">Premium</span></strong>
      <p style={{ margin: '4px 0 0' }}>
        Main buyers of {r.country}&apos;s exports of this product in {r.export_year}, how crowded each buyer&apos;s supply already is, and how its currency has behaved against the dollar.
      </p>
      <table className="data-table" style={{ marginTop: 4 }}>
        <thead>
          <tr><th>Buyer</th><th className="align-right">Bought</th><th>Market saturation</th><th>Currency risk</th></tr>
        </thead>
        <tbody>
          {r.buyers.map((b) => (
            <tr key={b.iso3}>
              <td>{b.name}</td>
              <td className="align-right">{usdM(b.export_value_usd)}{b.share_pct != null ? ` (${b.share_pct}%)` : ''}</td>
              <td title={b.saturation?.reason ?? b.saturation_note ?? ''}>
                {b.saturation
                  ? `${b.saturation.label}${b.saturation.top_supplier ? `: ${b.saturation.top_supplier} ${b.saturation.top_share_pct}%` : ''}`
                  : <span className="dim">Not held yet</span>}
              </td>
              <td title={b.fx?.reason ?? b.fx_note ?? ''}>{b.fx ? FX_LABEL[b.fx.level] : <span className="dim">Unavailable</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.home_fx && r.home_fx.level !== 'insufficient' && (
        <p style={{ margin: '4px 0 0' }}>
          {r.home_fx.name} currency: {FX_LABEL[r.home_fx.level].toLowerCase()} risk. {r.home_fx.reason}
          {r.home_fx.span_change_pct != null && ` Over ${r.home_fx.years[0]} to ${r.home_fx.years[r.home_fx.years.length - 1]} it moved ${r.home_fx.span_change_pct}% against the dollar.`}
        </p>
      )}
      <p style={{ margin: '4px 0 0' }}>{r.sources.join(' ')} Hover a row for the reasoning. {r.limitations.join(' ')}</p>
    </div>
  );
}

type TariffResponse =
  | { available: false; reason: string }
  | {
      available: true;
      country: string;
      hs: string;
      export_year: number;
      markets: Array<{
        market: string; reporter: string; export_value_usd: number; applies_to: string[];
        tariff: ReturnType<typeof readTariff>;
      }>;
      coverage: { markets_shown: number; markets_with_verified_tariff: number };
      notes: string[];
    };

const TARIFF_STATUS_LABEL: Record<string, string> = { verified: 'Verified', 'specific-duty': 'Fixed amount per unit', unavailable: 'Unavailable' };

export function TariffBlock({ slug, hs }: { slug: string; hs: string }) {
  const [r, setR] = useState<TariffResponse | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    setR(null);
    fetch(`/api/tariffs/${encodeURIComponent(slug)}/${encodeURIComponent(hs)}`, { headers: { accept: 'application/json' } })
      .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
      .then((x) => { if (live) setR(x); })
      .catch(() => { if (live) setR('failed'); });
    return () => { live = false; };
  }, [slug, hs]);
  if (r === null || r === 'failed') return null;
  if (!r.available) return <p className="tiny dim" style={{ margin: '10px 0 0' }}><strong>Import tariffs</strong>: {r.reason}</p>;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Import tariffs in the main buying markets</strong>
      <p style={{ margin: '4px 0 0' }}>
        What {r.country}&apos;s main buyers charge on imports of this product. {r.coverage.markets_with_verified_tariff} of {r.coverage.markets_shown} markets have a verified rate loaded.
      </p>
      <table className="data-table" style={{ marginTop: 4 }}>
        <thead>
          <tr><th>Market</th><th>MFN tariff</th><th>Status</th><th>Source</th></tr>
        </thead>
        <tbody>
          {r.markets.map((m) => (
            <tr key={m.reporter}>
              <td title={m.applies_to.length ? `Applies to: ${m.applies_to.join(', ')}` : undefined}>{m.market}</td>
              <td title={m.tariff.headline}>
                {m.tariff.status === 'verified' && m.tariff.rate_pct != null
                  ? `${Math.round(m.tariff.rate_pct * 10) / 10}%${m.tariff.mixed ? ` avg (${m.tariff.min_rate_pct}% to ${m.tariff.max_rate_pct}%)` : ''}`
                  : <span className="dim">{m.tariff.status === 'specific-duty' ? 'No % rate' : 'Not available'}</span>}
              </td>
              <td>{TARIFF_STATUS_LABEL[m.tariff.status]}{m.tariff.year ? `, ${m.tariff.year}` : ''}{m.tariff.hs_revision ? `, HS ${m.tariff.hs_revision}` : ''}</td>
              <td>{m.tariff.source_url
                ? <a href={m.tariff.source_url} target="_blank" rel="noopener noreferrer">UNCTAD TRAINS</a>
                : <span className="dim">None</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {r.markets.find((m) => m.tariff.status === 'verified') && (
        <p style={{ margin: '4px 0 0' }}>{r.markets.find((m) => m.tariff.status === 'verified')!.tariff.limitations.join(' ')}</p>
      )}
      <p style={{ margin: '4px 0 0' }}>{r.notes.join(' ')} Retrieved {r.markets.find((m) => m.tariff.retrieved_at)?.tariff.retrieved_at?.slice(0, 10) ?? 'not yet'}.</p>
    </div>
  );
}

export function CompanyLinksBlock({ name }: { name: string | null }) {
  const q = (name ?? '').replace(/\(.*?\)/g, '').split(/[,;]/)[0].trim().split(/\s+/).slice(0, 3).join(' ');
  if (!q) return null;
  const enc = encodeURIComponent(q);
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Find companies behind this trade</strong>
      <p style={{ margin: '4px 0 0' }}>
        UN Comtrade has no company names, so Tereflow cannot list them. These free searches open outside Tereflow, and we do not store or verify what they show:{' '}
        <a href={`https://www.importyeti.com/search?q=${enc}`} target="_blank" rel="noopener noreferrer">US import shipments (ImportYeti)</a>
        {' · '}
        <a href={`https://opencorporates.com/companies?q=${enc}`} target="_blank" rel="noopener noreferrer">company registers (OpenCorporates)</a>.
        {' '}ImportYeti covers only goods shipped into the United States. Search results match on the product wording, so expect noise.
      </p>
    </div>
  );
}

export function LandedCostBlock({ unitValueUsdT }: { unitValueUsdT: number | null }) {
  const [price, setPrice] = useState(unitValueUsdT ? Math.round(unitValueUsdT) : 1000);
  const [tonnes, setTonnes] = useState(20);
  const [freight, setFreight] = useState(2500);
  const [ins, setIns] = useState(0.5);
  const [duty, setDuty] = useState(0);
  const [vat, setVat] = useState(0);
  const [other, setOther] = useState(500);
  const [sale, setSale] = useState(0);
  const [term, setTerm] = useState<Incoterm>('FOB');
  const lc = landedCost({ goods_per_tonne: price, tonnes, freight_total: freight, insurance_pct: ins, duty_pct: duty, vat_pct: vat, other_costs: other, sale_per_tonne: sale > 0 ? sale : null });
  const info = INCOTERMS.find((t) => t.code === term);
  const num = (v: string) => Number(v) || 0;
  const usd0 = (n: number) => '$' + Math.round(n).toLocaleString('en-US');
  return (
    <details className="tiny dim" style={{ margin: '10px 0 0' }}>
      <summary><strong>Landed cost and margin calculator</strong></summary>
      <p style={{ margin: '4px 0' }}>
        Starts from this product's average unit value. Every figure is yours to change; Tereflow does not know your freight quote or the destination tariff.
      </p>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label>Price per tonne $<input type="number" min={0} value={price} onChange={(e) => setPrice(num(e.target.value))} style={{ width: 72 }} /></label>
        <label>Tonnes <input type="number" min={0} value={tonnes} onChange={(e) => setTonnes(num(e.target.value))} style={{ width: 56 }} /></label>
        <label>Freight $<input type="number" min={0} value={freight} onChange={(e) => setFreight(num(e.target.value))} style={{ width: 72 }} /></label>
        <label>Insurance % <input type="number" min={0} step={0.1} value={ins} onChange={(e) => setIns(num(e.target.value))} style={{ width: 48 }} /></label>
        <label>Duty % <input type="number" min={0} value={duty} onChange={(e) => setDuty(num(e.target.value))} style={{ width: 48 }} /></label>
        <label>VAT % <input type="number" min={0} value={vat} onChange={(e) => setVat(num(e.target.value))} style={{ width: 48 }} /></label>
        <label>Other charges $<input type="number" min={0} value={other} onChange={(e) => setOther(num(e.target.value))} style={{ width: 64 }} /></label>
        <label>Sale price per tonne $<input type="number" min={0} value={sale} onChange={(e) => setSale(num(e.target.value))} style={{ width: 72 }} /></label>
      </div>
      {lc ? (
        <>
          <p style={{ margin: '6px 0 0' }}>
            Goods {usd0(lc.goods)}, freight {usd0(lc.freight)}, insurance {usd0(lc.insurance)}, duty {usd0(lc.duty)}, VAT {usd0(lc.vat)}, other {usd0(lc.other)}.
            {' '}<strong>Landed cost {usd0(lc.total)}, or {usd0(lc.per_tonne)} per tonne.</strong>
            {lc.margin_pct != null && ` At a sale price of ${usd0(sale)} per tonne the margin is ${lc.margin_pct}% (${usd0(lc.margin_per_tonne as number)} per tonne).`}
          </p>
          <p style={{ margin: '4px 0 0' }}>{lc.limitations.join(' ')}</p>
        </>
      ) : <p style={{ margin: '6px 0 0' }}>Enter a positive price and tonnage.</p>}
      <p style={{ margin: '6px 0 0' }}>
        Trade term:{' '}
        <select value={term} onChange={(e) => setTerm(e.target.value as Incoterm)}>
          {INCOTERMS.map((t) => <option key={t.code} value={t.code}>{t.code}</option>)}
        </select>
        {info && ` ${info.name}: the seller carries cost up to ${info.seller_to}. ${info.buyer_note}`}
      </p>
    </details>
  );
}

const REEXPORT_TITLE: Record<NonNullable<ProductInsight['reexport']>['verdict'], string> = {
  possible: 'Possible re-export pattern',
  'one-directional': 'Trade runs one way',
  'volumes-differ': 'No re-export pattern',
  insufficient: 'Not enough years to tell',
};

export function ReexportBlock({ signal }: { signal: NonNullable<ProductInsight['reexport']> }) {
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>{REEXPORT_TITLE[signal.verdict]}</strong>
      <p style={{ margin: '4px 0 0' }}>
        {signal.reason}
        {signal.export_to_import_ratio != null && ` Exports to imports: ${signal.export_to_import_ratio} to 1${signal.years.length ? ` over ${signal.years[0]} to ${signal.years[signal.years.length - 1]}` : ''}.`}
        {signal.unit_value_ratio != null && ` Export price per kg is ${signal.unit_value_ratio} times the import price.`}
      </p>
      <p style={{ margin: '4px 0 0' }}>{signal.limitations.join(' ')}</p>
    </div>
  );
}
const MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const SEASON_TITLE: Record<string, string> = {
  seasonal: 'Seasonal',
  'mildly-seasonal': 'Mildly seasonal',
  'not-seasonal': 'Not seasonal',
  insufficient: 'Not enough monthly data to tell',
};

export function SeasonalityBlock({ signal }: { signal: NonNullable<ProductInsight['seasonality']> | null }) {
  if (!signal) {
    return (
      <p className="tiny dim" style={{ margin: '10px 0 0' }}>
        <strong>Seasonality</strong>: monthly figures are not stored for this country yet.
      </p>
    );
  }
  const max = signal.index ? Math.max(...signal.index, 1) : 1;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>{SEASON_TITLE[signal.verdict]}</strong>
      <p style={{ margin: '4px 0 0' }}>
        {signal.reason}
        {signal.years.length > 0 && ` Years used: ${signal.years[0]} to ${signal.years[signal.years.length - 1]}.`}
      </p>
      {signal.index && (
        <div role="img" aria-label={`Monthly index, peak in ${MONTH_ABBR[(signal.peak_month ?? 1) - 1]}`}
          style={{ display: 'flex', alignItems: 'flex-end', gap: 3, height: 64, margin: '8px 0 2px' }}>
          {signal.index.map((v, i) => (
            <div key={MONTH_ABBR[i]} title={`${MONTH_ABBR[i]}: ${v} times an average month`}
              style={{ flex: 1, textAlign: 'center' }}>
              <div style={{ height: Math.max(2, (v / max) * 48), background: i + 1 === signal.peak_month ? 'var(--accent, #0f9d58)' : 'var(--line, #cfd4dc)', borderRadius: 2 }} />
              <span style={{ fontSize: 9 }}>{MONTH_ABBR[i][0]}</span>
            </div>
          ))}
        </div>
      )}
      <p style={{ margin: '4px 0 0' }}>{signal.source ? `Source: ${signal.source}. ` : ''}{signal.limitations.join(' ')}</p>
    </div>
  );
}
const LEVEL_TITLE: Record<string, string> = {
  high: 'High supply concentration',
  moderate: 'Moderate supply concentration',
  low: 'Low supply concentration',
  insufficient: 'Not enough partner data to measure concentration',
};

export function SupplyBlock({ signal }: { signal: NonNullable<ProductInsight['supply']> }) {
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>{LEVEL_TITLE[signal.level]}</strong>
      <p style={{ margin: '4px 0 0' }}>{signal.reason}</p>
      <p style={{ margin: '4px 0 0' }}>{signal.limitations.join(' ')}</p>
    </div>
  );
}

type RegulatoryState =
  | { available: true; source: string; scope: string; summary: RegulatorySummary; lines: number; limitations: string[] }
  | { available: false; reason: string; scope: string };

export function RegulatoryBlock({ hs }: { hs: string }) {
  const [state, setState] = useState<RegulatoryState | 'loading' | 'failed'>('loading');
  useEffect(() => {
    let live = true;
    setState('loading');
    fetch(`/api/regulatory/${encodeURIComponent(hs)}`, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => { if (live) setState(d as RegulatoryState); })
      .catch(() => { if (live) setState('failed'); });
    return () => { live = false; };
  }, [hs]);

  if (state === 'loading') return <p className="tiny dim" style={{ margin: '10px 0 0' }}>Checking UK import rules.</p>;
  if (state === 'failed') return <p className="tiny dim" style={{ margin: '10px 0 0' }}><strong>UK import rules</strong>: could not be loaded right now.</p>;
  if (!state.available) {
    return <p className="tiny dim" style={{ margin: '10px 0 0' }}><strong>UK import rules</strong>: {state.reason} {state.scope}</p>;
  }
  const s = state.summary;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>UK import rules</strong>
      <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
        <li>Standard duty: {s.third_country_duty.length ? s.third_country_duty.join(' or ') : 'not listed'}{s.duty_suspended ? ', currently suspended' : ''}.</li>
        {s.vat && <li>VAT: {s.vat}.</li>}
        {s.controls.map((c) => <li key={c}>{c}.</li>)}
        {s.country_restrictions.length > 0 && <li>Country restrictions include {s.country_restrictions.slice(0, 4).map((r) => r.area).join(', ')}{s.country_restrictions.length > 4 ? ' and others' : ''}.</li>}
        {s.preference_areas > 0 && <li>{s.preference_areas} countries and groups have a preferential rate or quota.</li>}
      </ul>
      <p style={{ margin: '4px 0 0' }}>{state.source}. {state.scope} {state.limitations.join(' ')}</p>
    </div>
  );
}
export function DiscoveryBlock({ hs }: { hs: string }) {
  const [d, setD] = useState<DiscoveryResult | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    setD(null);
    fetch(`/api/discovery/${encodeURIComponent(hs)}`, { headers: { accept: 'application/json' }, credentials: 'same-origin' })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((x) => { if (live) setD(x as DiscoveryResult); })
      .catch(() => { if (live) setD('failed'); });
    return () => { live = false; };
  }, [hs]);
  if (d === null || d === 'failed') return null;
  const none = d.members.length === 0 && d.listings.length === 0;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Who trades this on Tereflow</strong>
      {none && <p style={{ margin: '4px 0 0' }}>No members or open listings for this product yet.</p>}
      {d.members.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {d.members.slice(0, 5).map((m) => (
            <li key={m.card_id}><Link to={`/network/${m.card_id}`}>{m.display_name}{m.company ? `, ${m.company}` : ''}</Link> ({m.country_iso3}; {m.intents.join(', ')})</li>
          ))}
        </ul>
      )}
      {d.listings.length > 0 && (
        <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
          {d.listings.slice(0, 5).map((l) => <li key={l.id}><Link to={`/market/${l.id}`}>{l.title}</Link> ({l.mode === 'auction' ? 'auction' : l.kind.replace(/_/g, ' ')})</li>)}
        </ul>
      )}
      <p style={{ margin: '4px 0 0' }}>{d.scope} {d.limitations.join(' ')}</p>
    </div>
  );
}
export function ProductionBlock({ slug, hs }: { slug: string; hs: string }) {
  const [p, setP] = useState<(ProductionSignal & { data_as_of?: string | null }) | null | 'failed'>(null);
  useEffect(() => {
    let live = true;
    setP(null);
    fetch(`/api/production/${encodeURIComponent(slug)}/${encodeURIComponent(hs)}`, { headers: { accept: 'application/json' } })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((x) => { if (live) setP(x); })
      .catch(() => { if (live) setP('failed'); });
    return () => { live = false; };
  }, [slug, hs]);
  if (p === null || p === 'failed') return null;
  if (!p.available) {
    // A product outside the crop list is not worth a line; a mapped crop with no data is.
    return p.item ? <p className="tiny dim" style={{ margin: '10px 0 0' }}><strong>Domestic production</strong>: {p.reason}</p> : null;
  }
  const t = (n: number) => `${Math.round(n).toLocaleString('en-US')} t`;
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>Domestic production</strong>
      <p style={{ margin: '4px 0 0' }}>
        {p.item}: {t(p.latest_tonnes as number)} in {p.latest_year}
        {p.change_5y_pct != null && `, ${p.change_5y_pct >= 0 ? 'up' : 'down'} ${Math.abs(p.change_5y_pct)}% over the last five years shown`}.
        {p.production_to_export_ratio != null && ` That is ${p.production_to_export_ratio} times the weight exported.`}
        {p.series.some((x) => x.year === p.latest_year && x.flag && x.flag !== 'A') && ' The latest figure is an estimate or from an external source, not an official national figure.'}
      </p>
      <p style={{ margin: '4px 0 0' }}>{p.source}{p.data_as_of ? `, file dated ${p.data_as_of}` : ''}. {p.scope} {p.limitations.join(' ')}</p>
    </div>
  );
}
type ByproductResponse = ReturnType<typeof byproductAnalysis> & { country: string; year: number | null; has_data: boolean };

const KB_CONFIDENCE_LABEL: Record<string, string> = {
  verified: 'Verified',
  plausible: 'Plausible, not machine-checked',
  unverified: 'Unverified',
  rejected: 'Rejected',
};

const VERDICT_LABEL: Record<string, string> = {
  'import-gap': 'Country imports this',
  'under-processed': 'Little made locally',
  covered: 'No gap shown',
  'no-data': 'No trade recorded',
};

export function ByproductBlock({ slug, hs }: { slug: string; hs: string }) {
  const [r, setR] = useState<ByproductResponse | null | 'failed'>(null);
  const [minMain, setMinMain] = useState(5);
  const [underPct, setUnderPct] = useState(10);
  const [importGap, setImportGap] = useState(0.5);
  useEffect(() => {
    let live = true;
    const qs = new URLSearchParams({
      min_main_usd: String(minMain * 1e6),
      under_ratio: String(underPct / 100),
      import_gap_usd: String(importGap * 1e6),
    });
    const t = setTimeout(() => {
      fetch(`/api/byproducts/${encodeURIComponent(slug)}/${encodeURIComponent(hs)}?${qs}`, { headers: { accept: 'application/json' } })
        .then((x) => (x.ok ? x.json() : Promise.reject(new Error(String(x.status)))))
        .then((x) => { if (live) setR(x); })
        .catch(() => { if (live) setR('failed'); });
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [slug, hs, minMain, underPct, importGap]);
  if (r === null || r === 'failed' || !r.has_data) return null;
  if (!r.rows.length && !r.services.length) return null;
  const money = (n: number | null) => (n == null ? 'none' : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n / 1e3)}K`);
  return (
    <div className="tiny dim" style={{ margin: '10px 0 0' }}>
      <strong>By-products and logistics</strong>
      {r.rows.length > 0 && (
        <table className="data-table" style={{ marginTop: 4 }}>
          <thead>
            <tr><th>By-product</th><th>Evidence</th><th className="align-right">Exports {r.year}</th><th className="align-right">Imports {r.year}</th><th>Read</th></tr>
          </thead>
          <tbody>
            {r.rows.map((x) => (
              <tr key={x.id}>
                <td title={[x.process_method, x.applications, x.detail_sourced ? '' : 'Process and uses are general knowledge, not yet tied to a cited source.'].filter(Boolean).join(' ')}>
                  {x.byproduct_name}{x.byproduct_code ? ` (HS ${x.byproduct_code})` : ''}
                </td>
                <td title={[x.evidence_note, x.trade_evidence_note, x.byproduct_hs_official ? `Official wording: ${x.byproduct_hs_official}` : ''].filter(Boolean).join(' ')}>
                  {KB_CONFIDENCE_LABEL[x.confidence]}, {x.status === 'established' ? 'established' : 'technically possible'}
                  {x.source_url && <>{' '}<a href={x.source_url} target="_blank" rel="noopener noreferrer">source</a></>}
                </td>
                <td className="align-right">{money(x.exports_usd)}</td>
                <td className="align-right">{money(x.imports_usd)}</td>
                <td title={x.reason}>{VERDICT_LABEL[x.verdict]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {r.unsupported.length > 0 && (
        <p style={{ margin: '4px 0 0' }}>
          <strong>Checked and ruled out:</strong>{' '}
          {r.unsupported.map((u) => `${u.byproduct_name}${u.byproduct_code ? ` (HS ${u.byproduct_code})` : ''}: ${u.evidence_note ?? 'not supported'}`).join(' ')}
        </p>
      )}
      {r.services.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {r.services.map((s) => <li key={s.title}>{s.title}: {s.note}</li>)}
        </ul>
      )}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', margin: '6px 0 0' }}>
        <label>Main exports at least $<input type="number" min={0} step={1} value={minMain} onChange={(e) => setMinMain(Number(e.target.value) || 0)} style={{ width: 56 }} />M</label>
        <label>Under-processed below <input type="number" min={0} max={100} step={1} value={underPct} onChange={(e) => setUnderPct(Number(e.target.value) || 0)} style={{ width: 48 }} />% of raw exports</label>
        <label>Import gap from $<input type="number" min={0} step={0.1} value={importGap} onChange={(e) => setImportGap(Number(e.target.value) || 0)} style={{ width: 56 }} />M</label>
      </div>
      <p style={{ margin: '4px 0 0' }}>{r.country}, trade of {r.year}, from UN Comtrade as held by Tereflow. {r.limitations.join(' ')}</p>
    </div>
  );
}

/* ---------- focused product history ---------- */

function ProductHistoryChart({ rows }: { rows: NonNullable<ProductInsight['time_series']> }) {
  if (rows.length < 2) {
    return (
      <p className="tiny dim" style={{ margin: 0 }}>
        Not enough annual observations to draw a trend.
      </p>
    );
  }
  return (
    <div style={{ height: 220, margin: '0 -8px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={rows} margin={{ top: 8, right: 18, left: 4, bottom: 0 }}>
          <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" />
          <XAxis dataKey="year" stroke={CHART.axis} tick={{ fontSize: 10 }} />
          <YAxis
            stroke={CHART.axis}
            tick={{ fontSize: 10 }}
            tickFormatter={(v: number) => fmtUsd(v)}
          />
          <Tooltip
            formatter={(value: number) => [fmtUsd(value), 'Trade value']}
            labelFormatter={(year) => String(year)}
          />
          <Line type="monotone" dataKey="value_usd" stroke={CHART.brand} strokeWidth={2} dot={{ r: 3 }} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

/* ---------- modal ---------- */

export default function ProductModal({
  hsCode,
  countrySlug = null,
  flow = null,
  onClose,
}: {
  hsCode: string;
  /** Country to open on, when the reader tapped a row belonging to one. */
  countrySlug?: string | null;
  /** Direction the reader arrived on, so the headline matches the row tapped. */
  flow?: 'export' | 'import' | null;
  onClose: () => void;
}) {
  const { user } = useSession();
  const [budget] = useBudget();
  const [hs, setHs] = useState(hsCode);
  const [history, setHistory] = useState<string[]>([]);
  const [focusSlug, setFocusSlug] = useState<string | null>(countrySlug);
  const [focusFlow, setFocusFlow] = useState<'export' | 'import' | null>(flow);
  /**
   * Which side the country list shows. It follows the row the reader arrived
   * on, so somebody who tapped an import row picks from buyers rather than
   * being offered sellers whose figures would not match the tiles above.
   */
  const [asideFlow, setAsideFlow] = useState<'export' | 'import'>(flow ?? 'export');
  const [insight, setInsight] = useState<ProductInsight | null>(null);
  // The score is the one figure here that asks to be trusted, so it opens to
  // show the four terms behind it rather than staying a bare number.
  const [scoreOpen, setScoreOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [following, setFollowing] = useState(false);
  const [followId, setFollowId] = useState<string | null>(null);

  // A different product is a fresh worldwide view. The country that was in
  // focus belonged to the product being left, so carrying it over would scope
  // the new one to a market that may not even trade it. Clearing the insight
  // too keeps the old product's numbers from flashing during the fetch.
  //
  // Keyed on the previous HS code rather than a "have I run before" flag:
  // StrictMode runs effects twice on mount in development, and a flag would
  // treat that second run as a product change and drop the country the reader
  // arrived with.
  const prevHs = useRef(hs);
  useEffect(() => {
    if (prevHs.current === hs) return;
    prevHs.current = hs;
    setFocusSlug(null);
    setFocusFlow(null);
    setAsideFlow('export');
    setInsight(null);
  }, [hs]);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    api
      .insight(hs, focusSlug ?? undefined, focusFlow ?? undefined)
      .then((data) => {
        if (!alive) return;
        setInsight(data);
      })
      .catch((err) => {
        if (!alive) return;
        setError(err instanceof Error ? err.message : 'Could not load this product');
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [hs, focusSlug, focusFlow]);

  useEffect(() => {
    if (!user) {
      setFollowing(false);
      setFollowId(null);
      return;
    }
    let alive = true;
    api.premium
      .subscriptions()
      .then(({ subscriptions }) => {
        if (!alive) return;
        const sub = subscriptions.find((s) => s.kind === 'hs_code' && s.value === hs);
        setFollowing(!!sub);
        setFollowId(sub?.id ?? null);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [user, hs]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  const openRelated = useCallback(
    (code: string) => {
      setHistory((h) => [...h, hs]);
      setHs(code);
    },
    [hs],
  );

  const goBack = useCallback(() => {
    setHistory((h) => {
      const next = [...h];
      const prev = next.pop();
      if (prev) setHs(prev);
      return next;
    });
  }, []);

  const toggleFollow = useCallback(
    async (next: boolean) => {
      if (!insight) return;
      const prevFollowing = following;
      const prevId = followId;
      setFollowing(next);
      try {
        if (next) {
          await api.premium.follow({ kind: 'hs_code', value: insight.hs_code, label: insight.name });
          const { subscriptions } = await api.premium.subscriptions();
          const sub = subscriptions.find((s) => s.kind === 'hs_code' && s.value === insight.hs_code);
          setFollowId(sub?.id ?? null);
        } else if (prevId) {
          await api.premium.unfollow(prevId);
          setFollowId(null);
        }
      } catch {
        setFollowing(prevFollowing);
        setFollowId(prevId);
      }
    },
    [insight, following, followId],
  );

  const marketRows = useMemo<MarketDatum[]>(() => {
    if (!insight) return [];
    return insight.target_markets
      .filter((m) => m.cagr_pct != null && !isNewTrade(m.cagr_pct))
      .sort((a, b) => (b.cagr_pct as number) - (a.cagr_pct as number))
      .slice(0, 8)
      .map((m) => ({
        name: m.name,
        growth: m.cagr_pct as number,
        label: fmtPct(m.cagr_pct as number, 0),
      }));
  }, [insight]);

  const newlyMarkets = useMemo(() => {
    if (!insight) return [];
    return insight.target_markets.filter((m) => m.cagr_pct != null && isNewTrade(m.cagr_pct));
  }, [insight]);

  const band = insight?.score != null ? scoreBand(insight.score) : 'watch';
  const asideRows = asideFlow === 'import' ? (insight?.buyers ?? []) : (insight?.sellers ?? []);
  const focusShare = focusSlug && focusFlow
    ? (focusFlow === 'import' ? insight?.buyers : insight?.sellers)?.find((row) => row.slug === focusSlug)?.share ?? null
    : null;
  // Against the unit value actually in view, so the number moves when the
  // reader rescopes to another country rather than staying on the first one.
  const modalFit = budgetFit(budget, insight?.unit_value_usd_t ?? null);
  const growth = insight ? growthText(insight.growth_pct) : { text: '', tone: '' };
  const growthWhose = insight?.focus_name ?? insight?.sellers[0]?.name ?? null;
  const showBorrowedPrice = !!insight?.price_from_name && !insight?.focus_slug;

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="global-product-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row between" style={{ gap: 12 }}>
          <div style={{ minWidth: 0 }}>
            <p className="overline" style={{ margin: 0 }}>
              {history.length > 0 ? (
                <button type="button" className="link-btn" onClick={goBack}>
                  {'\u2039'} Back
                </button>
              ) : insight?.focus_name ? (
                `Product in ${insight.focus_name}`
              ) : (
                'Product worldwide'
              )}
            </p>
            <h2 id="global-product-title" style={{ margin: '3px 0 0', fontSize: 24 }}>
              {insight?.name ?? 'Loading product'}
            </h2>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            {'\u00d7'}
          </button>
        </div>

        {loading ? (
          <div className="skeleton" style={{ height: 120, marginTop: 18 }} />
        ) : error || !insight ? (
          <Empty title="Could not load this product" hint={error ?? undefined} />
        ) : (
          <>
            <div className="row" style={{ gap: 8, flexWrap: 'wrap', margin: '12px 0 4px' }}>
              <span className={`badge ${insight.category === 'traditional' ? 'watch' : 'on'}`}>
                {insight.category === 'traditional' ? 'Traditional' : 'Non-traditional'}
              </span>
              <span className="partner-chip">HS {insight.hs_code}</span>
              <span className="partner-chip">HS{insight.hs_code.length}</span>
              {user && (
                <FollowButton
                  kind="hs_code"
                  value={insight.hs_code}
                  label={insight.name}
                  following={following}
                  onChange={toggleFollow}
                />
              )}
            </div>

            <p className="small muted" style={{ margin: '4px 0 0' }}>
              {insight.sector}
              {insight.chapter_label && insight.chapter_label !== insight.name && (
                <> {'\u00b7'} {insight.chapter_label}</>
              )}
            </p>

            {insight.name_full &&
              insight.name_full !== insight.name &&
              hasLongerDescription(insight.name_full) && (
                <p className="tiny dim" style={{ margin: '6px 0 0' }}>
                  Full description: {insight.name_full}
                </p>
              )}

            {insight.focus_slug && insight.focus_name && (
              <div className="focus-banner">
                <span>
                  Scoped to <strong>{insight.focus_name}</strong> for this product.
                </span>
                <button type="button" className="link-btn" onClick={() => { setFocusSlug(null); setFocusFlow(null); }}>
                  Back to worldwide
                </button>
              </div>
            )}

            <div className="insight-body">
              <div className="insight-main">
                <div className="insight-tiles">
                  <Tile
                    k={MOMENTUM_SCORE_LABEL}
                    v={insight.score != null ? `${insight.score}/100` : 'Not scored'}
                    onClick={insight.score_breakdown ? () => setScoreOpen((o) => !o) : undefined}
                    expanded={scoreOpen}
                    s={
                      insight.score == null
                        ? 'This line was not ranked in any market on record'
                        : insight.score_from_name && !insight.focus_slug
                          ? `${SCORE_BAND_LABEL[band]} for ${insight.score_from_name}`
                          : SCORE_BAND_LABEL[band]
                    }
                    title={
                      insight.score != null
                        ? `${SCORE_BASIS} ${SCORE_NOT_COMPARABLE}`
                        : 'A score is only given where the pipeline ranked this product for a country. No score is not a low score.'
                    }
                  />
                  <Tile
                    k="3-year growth"
                    v={growth.text}
                    s={growthWhose ? `For ${growthWhose}` : undefined}
                    tone={growth.tone}
                  />
                  <Tile
                    k="Unit value"
                    v={fmtUnitValue(insight.unit_value_usd_t)}
                    s={
                      insight.unit_value_usd_t == null
                        ? // A price is value divided by weight. Roughly half of all
                          // filings carry a value and no weight, so there is no
                          // price to show and no honest way to estimate one.
                          'No weight filed, so no price can be derived'
                        : showBorrowedPrice
                          ? `Price from ${insight.price_from_name}`
                          : insight.world_median_usd_t != null
                            ? `World median ${fmtUnitValue(insight.world_median_usd_t)}`
                            : undefined
                    }
                  />
                  <Tile
                    k={insight.focus_flow === 'import' ? 'Import value' : 'Export value'}
                    v={fmtUsd(insight.value_usd)}
                    s={
                      insight.focus_name
                        ? insight.year != null
                          ? `${insight.focus_name}, ${insight.year}`
                          : insight.focus_name
                        : insight.year != null
                          ? `${insight.year}`
                          : undefined
                    }
                  />
                  {focusShare != null && insight.focus_name && insight.focus_flow && (
                    <Tile
                      k="Market share"
                      v={fmtPct(focusShare * 100, 1)}
                      s={`Share of ${insight.focus_name}'s reported ${insight.focus_flow} product trade`}
                      text
                    />
                  )}
                  <Tile
                    k="Price premium"
                    v={PRICE_PREMIUM_LABEL[insight.price_premium]}
                    s={
                      insight.price_ratio != null
                        ? `${NF2.format(insight.price_ratio)}x the world median`
                        : undefined
                    }
                    text
                  />
                </div>

                {scoreOpen && insight.score_breakdown && (
                  <ScoreBreakdown breakdown={insight.score_breakdown} />
                )}

                {showBorrowedPrice && (
                  <p className="tiny dim" style={{ margin: '10px 0 0' }}>
                    The headline seller reported no weight for this product, so the unit value
                    shown is {insight.price_from_name}'s. It stands in for the price here rather
                    than being left blank, but it belongs to {insight.price_from_name}.
                  </p>
                )}

                {insight.focus_slug && (
                  <div className="card" style={{ marginTop: 16 }}>
                    <p className="card-title">Product performance over time</p>
                    <p className="tiny dim" style={{ margin: '0 0 8px' }}>
                      {insight.focus_name} {insight.focus_flow}s of HS {insight.hs_code}, by year.
                    </p>
                    <ProductHistoryChart rows={insight.time_series} />
                    <ProvenanceBlock notes={insight.provenance ?? []} rows={insight.time_series} />
                    <UnitCostBlock rows={insight.time_series} />
                {insight.reexport && <ReexportBlock signal={insight.reexport} />}
                {insight.seasonality !== undefined && <SeasonalityBlock signal={insight.seasonality} />}
                {insight.supply && <SupplyBlock signal={insight.supply} />}
                <RegulatoryBlock hs={insight.hs_code} />
                {insight.focus_slug && <ProductionBlock slug={insight.focus_slug} hs={insight.hs_code} />}
                {insight.focus_slug && insight.focus_flow !== 'import' && <ByproductBlock slug={insight.focus_slug} hs={insight.hs_code} />}
                {insight.focus_slug && insight.focus_flow !== 'import' && /^\d{6}$/.test(insight.hs_code) && <ProspectBlock slug={insight.focus_slug} hs={insight.hs_code} />}
                {insight.focus_slug && insight.focus_flow !== 'import' && /^\d{6}$/.test(insight.hs_code) && <TariffBlock slug={insight.focus_slug} hs={insight.hs_code} />}
                <LandedCostBlock key={insight.hs_code} unitValueUsdT={insight.unit_value_usd_t ?? null} />
                <CompanyLinksBlock name={insight.name ?? null} />
                {insight.focus_slug && <p className="tiny" style={{ margin: '10px 0 0' }}><Link to={`/feasibility/${insight.focus_slug}/${insight.hs_code}?flow=${insight.focus_flow ?? 'export'}`}>Open the full feasibility report</Link></p>}
                <DiscoveryBlock hs={insight.hs_code} />
                  </div>
                )}

                <div className="product-summary">
                  <div>
                    <span className="tiny dim">Exports on record</span>
                    <strong>{fmtUsd(insight.totals.export_usd)}</strong>
                  </div>
                  <div>
                    <span className="tiny dim">Imports on record</span>
                    <strong>{fmtUsd(insight.totals.import_usd)}</strong>
                  </div>
                  <div>
                    <span className="tiny dim">Reporting countries</span>
                    <strong>
                      {insight.totals.reporting_countries} of {insight.totals.countries_with_data}
                    </strong>
                  </div>
                </div>

                {insight.totals.countries_with_data > 0 && (
                  <p className="tiny dim" style={{ margin: '10px 0 0' }}>
                    {insight.totals.reporting_countries} of{' '}
                    {insight.totals.countries_with_data} countries carrying data in this product
                    reported a figure, so this is a sample of the trade, not the whole world
                    market.
                  </p>
                )}

                {budget > 0 && (
                  <div className="card budget-card" style={{ marginTop: 16 }}>
                    <p className="card-title">What ${budget.toLocaleString()} buys</p>
                    {modalFit.tonnes == null ? (
                      <p className="small" style={{ margin: 0 }}>
                        No weight was reported for this trade, so there is no price per tonne to
                        work from. The value is real, the quantity is not on record.
                      </p>
                    ) : (
                      <>
                        <p style={{ margin: 0, fontSize: 22, fontWeight: 650 }}>
                          {fmtQuantity(modalFit)}
                          <span className="dim" style={{ fontSize: 14, fontWeight: 400 }}>
                            {' '}at {fmtUnitValue(modalFit.usd_per_tonne)}
                          </span>
                        </p>
                        <p className="tiny dim" style={{ margin: '8px 0 0' }}>
                          {modalFit.fits
                            ? 'Goods value at the border, from the price this trade actually fetched. Freight, insurance, duty, clearing and financing sit on top.'
                            : 'That is under a tonne, which is not really a shipment. At this price the product needs a larger budget to be worth moving.'}
                        </p>
                      </>
                    )}
                  </div>
                )}

                <div className="card" style={{ marginTop: 16 }}>
                  <p className="card-title">Where demand is growing fastest</p>
                  {insight.target_markets.length === 0 ? (
                    <Empty
                      title="No importer growth on record"
                      hint="None of the reporting importers had a comparable earlier year for this product, so their demand growth is left blank rather than estimated."
                    />
                  ) : (
                    <>
                      {marketRows.length > 0 ? (
                        <TargetMarketsChart rows={marketRows} />
                      ) : (
                        <p className="tiny dim" style={{ margin: 0 }}>
                          Every importer with growth on record came off a negligible base, so
                          there is no rate to chart.
                        </p>
                      )}
                      {newlyMarkets.length > 0 && (
                        <p className="tiny dim" style={{ margin: '10px 0 0' }}>
                          Newly established demand:{' '}
                          {newlyMarkets.map((m) => m.name).join(', ')}. These came off almost no
                          prior trade, so they are named rather than shown as a growth rate.
                        </p>
                      )}
                      <p className="tiny dim" style={{ margin: '8px 4px 0' }}>
                        Importers ranked by how fast their demand is growing, not by size.
                      </p>
                    </>
                  )}
                </div>

                {/* Who this country actually trades with, when the source
                    knows. This is a different question from the world totals
                    below it, and the two must not be allowed to blur: one says
                    where Ghana's vehicles come from, the other says who is big
                    in vehicles worldwide. */}
                {insight.partner_flows && (
                  <PartnerFlows flows={insight.partner_flows} countrySlug={focusSlug} />
                )}

                <div className="card">
                  <p className="card-title">
                    {insight.partner_flows ? 'Who else trades this, worldwide' : 'Who trades this, by country'}
                  </p>
                  <p className="tiny dim" style={{ margin: '0 0 4px' }}>
                    {insight.partner_flows
                      ? "Each country's own totals for this product, for scale. These are not flows to or from " +
                        insight.partner_flows.country_name + '.'
                      : "These are each country's own totals for this product on the current sources, " +
                        'not proof of who ships to whom. Country to country flows are not available ' +
                        'on this data tier.'}
                  </p>
                  <CountryTable title="Sold by" rows={insight.sellers} />
                  <CountryTable title="Bought by" rows={insight.buyers} />
                </div>

                <div className="card">
                  <p className="card-title">Who else follows this</p>
                  {insight.subscriber_count === 0 ? (
                    <p className="tiny dim" style={{ margin: 0 }}>
                      Nobody is following this product yet. Follow it above to be the first, and
                      others looking at the same line will be able to find you here.
                    </p>
                  ) : (
                    <ul className="subscriber-list">
                      {insight.subscribers.map((sub, idx) => (
                        <li key={sub.card_id ?? `${sub.display_name}-${idx}`} className="list-item">
                          <div style={{ minWidth: 0 }}>
                            <span className="name">{sub.display_name}</span>
                            {sub.company && <span className="tiny dim"> {'\u00b7'} {sub.company}</span>}
                            {sub.headline && (
                              <span className="tiny dim" style={{ display: 'block', marginTop: 2 }}>
                                {sub.headline}
                              </span>
                            )}
                            {sub.intents.length > 0 && (
                              <span className="row" style={{ gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                                {sub.intents.map((intent) => (
                                  <span className="partner-chip" key={intent}>
                                    {intent}
                                  </span>
                                ))}
                              </span>
                            )}
                          </div>
                          {sub.card_id && (
                            <Link className="chip" to={`/network/${sub.card_id}`}>
                              View card
                            </Link>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}
                </div>

                {insight.related.length > 0 && (
                  <div className="card">
                    <p className="card-title">Related products</p>
                    <div className="row related-chips" style={{ gap: 8, flexWrap: 'wrap' }}>
                      {insight.related.map((r) => (
                        <button
                          type="button"
                          key={r.hs_code}
                          className="chip"
                          onClick={() => openRelated(r.hs_code)}
                        >
                          {r.name}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <Link
                  className="btn primary block"
                  to={
                    `/sandbox?${new URLSearchParams({
                      ...(focusSlug ? { primary: focusSlug } : {}),
                      hs: insight.hs_code,
                      flow: insight.focus_flow,
                    }).toString()}`
                  }
                >
                  Compare Markets in Sandbox
                </Link>

                <Link
                  className="btn block"
                  to={`/network?q=${encodeURIComponent(insight.name)}`}
                >
                  Find partners for this product
                </Link>
              </div>

              <aside className="insight-aside">
                <p className="overline" style={{ margin: '0 0 8px' }}>
                  {asideFlow === 'import' ? 'Focus a buyer' : 'Focus a seller'}
                </p>
                <div className="country-list">
                  <button
                    type="button"
                    className={`country-row${!focusSlug ? ' active' : ''}`}
                    onClick={() => { setFocusSlug(null); setFocusFlow(null); }}
                  >
                    <span className="grow name">Worldwide</span>
                    <span className="tiny dim">All reporters</span>
                  </button>
                  {asideRows.slice(0, 12).map((s) => (
                    <button
                      type="button"
                      key={s.slug}
                      className={`country-row${focusSlug === s.slug ? ' active' : ''}`}
                      onClick={() => { setFocusSlug(s.slug); setFocusFlow(asideFlow); }}
                    >
                      <span className="rank-badge">{s.rank}</span>
                      <span className="grow name">{s.name}</span>
                      <span className="tiny dim">{fmtUsd(s.value_usd)}</span>
                    </button>
                  ))}
                </div>
                <p className="tiny dim" style={{ margin: '8px 0 0' }}>
                  Pick a country to rescope every figure above to what it reports for this product.
                </p>
                <button
                  type="button"
                  className="link-btn"
                  style={{ marginTop: 8 }}
                  onClick={() => setAsideFlow(asideFlow === 'import' ? 'export' : 'import')}
                >
                  {asideFlow === 'import' ? 'Show who sells it instead' : 'Show who buys it instead'}
                </button>
              </aside>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
