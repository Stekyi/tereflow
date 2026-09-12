import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
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
        <span className={`badge ${band}`} title={SCORE_BASIS}>
          {product.score}/100
        </span>
        <span className="tiny dim" style={{ display: 'block', marginTop: 4 }}>
          {SCORE_BAND_LABEL[band]}
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
function PartnerFlows({ flows }: { flows: NonNullable<ProductInsight['partner_flows']> }) {
  const top = flows.partners.slice(0, 12);
  const rest = flows.partners.length - top.length;
  const direction = flows.trade_flow === 'import' ? 'comes from' : 'goes to';

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
                    k="YoY growth"
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
                  <PartnerFlows flows={insight.partner_flows} />
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
