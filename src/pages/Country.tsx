import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  LabelList,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../lib/api';
import { useSession } from '../lib/auth';
import { CHART } from '../lib/theme';
import { Term } from '../components/Term';
import { shortProductName } from '../../shared/product-name';
import { BarRow, Empty, FollowButton, Skeletons, Stat, useToast } from '../components/ui';
import GlobalProductModal from '../components/ProductModal';
import {
  EXPORT_CATEGORY_HINT,
  EXPORT_CATEGORY_LABEL,
  fmtPct,
  fmtUsd,
  linkHealth,
  LINK_HEALTH_LABEL,
  type CountryDashboard,
  type ExportCategory,
  type ProductBreakdown,
  type RankedItem,
  type Recommendation,
} from '../../shared/types';

export default function Country() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<(CountryDashboard & { inactive?: boolean; message?: string }) | null>(
    null,
  );
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.dashboardSources>> | null>(
    null,
  );
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const { user, refresh } = useSession();
  const t = useToast();
  const [subs, setSubs] = useState<Map<string, string>>(new Map());
  const [productDetail, setProductDetail] = useState<ProductBreakdown | null>(null);
  const [productLoading, setProductLoading] = useState(false);
  // The HS code of the product currently open in the country-scoped breakdown,
  // so the reader can jump from it to the global worldwide view.
  const [openHs, setOpenHs] = useState<string | null>(null);
  const [worldHs, setWorldHs] = useState<string | null>(null);
  // Traditional/gated products (gold, oil, ...) are hidden from the products
  // list by default -- an SME can't act on them -- with an explicit toggle
  // to reveal them, rather than ranking them alongside things it can trade.
  const [showMajor, setShowMajor] = useState(false);

  // Key a subscription by kind+value so follow state survives a re-render.
  const subKey = (kind: string, value: string) => `${kind}:${value.toLowerCase()}`;

  useEffect(() => {
    if (!user) return setSubs(new Map());
    api.premium
      .subscriptions()
      .then((r) => setSubs(new Map(r.subscriptions.map((s) => [subKey(s.kind, s.value), s.id]))))
      .catch(() => undefined);
  }, [user]);

  async function toggleFollow(
    next: boolean,
    kind: string,
    value: string,
    label: string,
  ) {
    if (!user) {
      t.err('Join free to follow markets and products');
      return;
    }
    const key = subKey(kind, value);
    try {
      if (next) {
        await api.premium.follow({
          kind: kind as 'product' | 'sector' | 'country' | 'hs_code',
          value,
          label,
        });
        const r = await api.premium.subscriptions();
        setSubs(new Map(r.subscriptions.map((s) => [subKey(s.kind, s.value), s.id])));
        t.ok(`Following ${label}`);
      } else {
        const id = subs.get(key);
        if (id) await api.premium.unfollow(id);
        setSubs((prev) => {
          const copy = new Map(prev);
          copy.delete(key);
          return copy;
        });
        t.ok(`Unfollowed ${label}`);
      }
      await refresh();
    } catch (e) {
      t.err((e as Error).message);
    }
  }

  async function openProduct(item: RankedItem, flow: 'export' | 'import') {
    if (!item.code) return;
    setProductLoading(true);
    setProductDetail(null);
    setOpenHs(item.code);
    try {
      setProductDetail(await api.productBreakdown(slug, flow, item.code));
    } catch (e) {
      t.err((e as Error).message);
    } finally {
      setProductLoading(false);
    }
  }

  useEffect(() => {
    setLoading(true);
    setError('');
    api
      .dashboard(slug)
      .then(setData)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
    api.dashboardSources(slug).then(setSources).catch(() => undefined);
  }, [slug]);

  if (loading) return <Skeletons n={6} />;
  if (error) return <Empty title="Could not load this market" hint={error} />;
  if (!data) return <Empty title="Nothing here" />;

  if (data.inactive) {
    return (
      <>
        <Header name={data.entity.name} iso3={data.entity.iso3} sub={data.entity.continent ?? ''} />
        <Empty title="Not activated yet" hint={data.message} />
      </>
    );
  }

  const o = data.overview;
  if (!o) {
    return (
      <>
        <Header name={data.entity.name} iso3={data.entity.iso3} sub={data.entity.continent ?? ''} />
        <Empty
          title="Activated, but not analysed yet"
          hint="Run the analysis from Admin, or wait for the Friday 21:00 GMT job."
        />
      </>
    );
  }

  return (
    <>
      <Header
        name={data.entity.name}
        iso3={data.entity.iso3}
        sub={data.entity.continent ?? ''}
        action={
          <FollowButton
            kind="country"
            value={data.entity.slug}
            label={data.entity.name}
            following={subs.has(subKey('country', data.entity.slug))}
            onChange={toggleFollow}
          />
        }
      />
      <p className="tiny dim" style={{ margin: '-6px 0 14px' }}>
        Trade figures for {o.year}
        {o.coverage_note ? ` · ${o.coverage_note}` : ''}
      </p>
      {t.node}
      {(productLoading || productDetail) && (
        <ProductModal
          detail={productDetail}
          loading={productLoading}
          onWorldwide={openHs ? () => setWorldHs(openHs) : undefined}
          onClose={() => {
            setProductDetail(null);
            setProductLoading(false);
            setOpenHs(null);
          }}
        />
      )}
      {worldHs && <GlobalProductModal hsCode={worldHs} onClose={() => setWorldHs(null)} />}
      <div style={{ height: 12 }} />

      <div className="grid three" style={{ marginBottom: 16 }}>
        <Stat
          label={
            <>
              Total exports <span className="dim">({o.year})</span>
            </>
          }
          value={fmtUsd(o.export_usd)}
          delta={o.export_yoy_pct != null ? `${fmtPct(o.export_yoy_pct)} yr/yr` : null}
          deltaTone={o.export_yoy_pct != null ? (o.export_yoy_pct >= 0 ? 'up' : 'down') : null}
        />
        <Stat
          label={
            <>
              Total imports <span className="dim">({o.year})</span>
            </>
          }
          value={fmtUsd(o.import_usd)}
          delta={o.import_yoy_pct != null ? `${fmtPct(o.import_yoy_pct)} yr/yr` : null}
          deltaTone={o.import_yoy_pct != null ? (o.import_yoy_pct >= 0 ? 'up' : 'down') : null}
        />
        <Stat
          label={<Term k="trade_balance">Trade balance</Term>}
          value={fmtUsd(o.balance_usd)}
          delta={
            o.balance_usd >= 0 ? (
              <Term k="surplus">Surplus</Term>
            ) : (
              <Term k="deficit">Deficit</Term>
            )
          }
          deltaTone={o.balance_usd >= 0 ? 'up' : 'down'}
        />
      </div>

      <label className="row small dim" style={{ gap: 6, marginBottom: 14, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={showMajor}
          onChange={(e) => setShowMajor(e.target.checked)}
          style={{ width: 'auto' }}
        />
        Include major traditional trade (gold, oil, and similar) in the imports chart
      </label>

      <ProductBarChart
        title="Top imports by value"
        caption="What this country buys most. Green bars are non-traditional lines an SME can supply; grey bars are large licensed trade. Tap a bar for its partner breakdown."
        items={reRank(data.top_imports, showMajor)}
        flow="import"
        colorByCategory
        onProductClick={openProduct}
        emptyHint="No import breakdown recorded for this year."
      />

      <ProductBarChart
        title="Non-traditional exports"
        caption="Value sold abroad outside the headline commodities, with recent yearly growth per line. Tap a bar for its partner breakdown."
        items={data.top_exports.filter((i) => i.category === 'non_traditional')}
        flow="export"
        showGrowth
        onProductClick={openProduct}
        emptyHint="No non-traditional export lines recorded for this year."
      />

      {data.trend.length > 1 ? (
        <div className="card">
          <p className="card-title">Merchandise trade balance</p>
          <div style={{ height: 220, margin: '0 -8px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data.trend} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                <defs>
                  <linearGradient id="gx" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.brand} stopOpacity={0.22} />
                    <stop offset="100%" stopColor={CHART.brand} stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="gm" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.contrast} stopOpacity={0.16} />
                    <stop offset="100%" stopColor={CHART.contrast} stopOpacity={0.01} />
                  </linearGradient>
                  <linearGradient id="gb" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={CHART.up} stopOpacity={0.2} />
                    <stop offset="100%" stopColor={CHART.up} stopOpacity={0.01} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                <XAxis
                  dataKey="year"
                  stroke={CHART.axis}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                />
                <YAxis
                  stroke={CHART.axis}
                  tick={{ fontSize: 11 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmtUsd(v).replace('$', '')}
                  width={52}
                />
                <Tooltip
                  contentStyle={{
                    background: CHART.tooltipBg,
                    border: `1px solid ${CHART.tooltipBorder}`,
                    borderRadius: 8,
                    fontSize: 13,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
                  }}
                  labelStyle={{ color: CHART.tooltipLabel }}
                  formatter={(v: number, n: string) => [fmtUsd(v), n]}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                <Area
                  type="monotone"
                  dataKey="export_usd"
                  name="Exports"
                  stroke={CHART.brand}
                  strokeWidth={2}
                  fill="url(#gx)"
                />
                <Area
                  type="monotone"
                  dataKey="import_usd"
                  name="Imports"
                  stroke={CHART.contrast}
                  strokeWidth={2}
                  fill="url(#gm)"
                />
                <Area
                  type="monotone"
                  dataKey="balance_usd"
                  name="Balance"
                  stroke={CHART.up}
                  strokeWidth={2}
                  fill="url(#gb)"
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
          <p className="tiny dim" style={{ margin: '8px 4px 0' }}>
            Exports, imports and the balance between them over {data.trend[0].year} to{' '}
            {data.trend[data.trend.length - 1].year}. Balance above zero is a surplus.
          </p>
        </div>
      ) : (
        <div className="card">
          <p className="card-title">Merchandise trade balance</p>
          <Empty title="Not enough history" hint="A trend needs at least two years of data." />
        </div>
      )}

      <div className="section-head">
        <h2>What this means</h2>
      </div>
      {data.recommendations.length === 0 ? (
        <Empty title="No read yet" hint="Recommendations appear after the first analysis run." />
      ) : (
        data.recommendations.map((r, i) => <Rec key={i} rec={r} />)
      )}

      <Ranked title="Where exports go" items={data.partners_export} />
      <Ranked title="Where imports come from" items={data.partners_import} />

      {sources && (
        <>
          <div className="section-head">
            <h2>Where this comes from</h2>
          </div>
          <div className="card">
            <p className="tiny dim" style={{ marginTop: 0 }}>
              {sources.note}
            </p>
            {(['export', 'import', 'commerce'] as const).map((cat) =>
              sources.official[cat]?.length ? (
                <div key={cat} style={{ marginTop: 12 }}>
                  <p className="card-title" style={{ marginBottom: 7 }}>
                    {cat === 'commerce' ? 'Commerce flow' : cat}
                  </p>
                  {sources.official[cat].map((s) => (
                    <a
                      className="src-link"
                      key={s.id}
                      href={s.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={LINK_HEALTH_LABEL[linkHealth(s.last_status, s.fmt)]}
                    >
                      <span className={`dot ${linkHealth(s.last_status, s.fmt)}`} />
                      <span className="u">{s.label ?? s.url}</span>
                      <span className="tiny dim">{s.fmt}</span>
                    </a>
                  ))}
                </div>
              ) : null,
            )}
          </div>
        </>
      )}

      {data.computed_at && (
        <p className="tiny dim" style={{ textAlign: 'center', margin: '18px 0 0' }}>
          Analysis computed {new Date(data.computed_at + 'Z').toLocaleString()}
        </p>
      )}
    </>
  );
}

function Header({
  name,
  iso3,
  sub,
  action,
}: {
  name: string;
  iso3: string | null;
  sub: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="row" style={{ marginBottom: 16, gap: 12 }}>
      <span className="flag" style={{ width: 44, height: 32, fontSize: 12 }}>
        {iso3 ?? '??'}
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-0.03em', lineHeight: 1.15 }}>
          {name}
        </div>
        <div className="tiny dim">{sub}</div>
      </div>
      {action}
    </div>
  );
}

interface FollowWiring {
  subs: Map<string, string>;
  toggle: (next: boolean, kind: string, value: string, label: string) => void;
  subKey: (kind: string, value: string) => string;
}

/** Drops traditional/gated products unless explicitly revealed, then
 *  renumbers so the visible list reads as a clean 1..N ranking rather than
 *  showing gaps where a hidden item used to sit. */
function reRank(items: RankedItem[], showMajor: boolean): RankedItem[] {
  const visible = showMajor ? items : items.filter((i) => i.category !== 'traditional');
  return visible.map((i, idx) => ({ ...i, rank: idx + 1 }));
}

function Ranked({
  title,
  items,
  follow,
  flow,
  onProductClick,
}: {
  title: string;
  items: RankedItem[];
  follow?: FollowWiring;
  flow?: 'export' | 'import';
  onProductClick?: (item: RankedItem, flow: 'export' | 'import') => void;
}) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.share_pct), 1);
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      {items.map((i) => (
        <BarRow
          key={`${i.rank}-${i.code}`}
          rank={i.rank}
          name={i.name}
          value={fmtUsd(i.value_usd)}
          share={i.share_pct}
          max={max}
          action={
            follow && i.code ? (
              <FollowButton
                kind="hs_code"
                value={i.code}
                label={i.name}
                following={follow.subs.has(follow.subKey('hs_code', i.code))}
                onChange={follow.toggle}
              />
            ) : undefined
          }
          meta={
            <>
              {i.category && (
                <span
                  className={`badge ${i.category === 'traditional' ? 'watch' : 'on'}`}
                  style={{ marginRight: 6 }}
                  title={EXPORT_CATEGORY_HINT[i.category]}
                >
                  {EXPORT_CATEGORY_LABEL[i.category]}
                </span>
              )}
              {i.share_pct.toFixed(1)}% share
              {i.cagr_3y != null && (
                <>
                  {' · '}
                  <span className={i.cagr_3y >= 0 ? 'up' : 'down'}>
                    <Term k="cagr" tone="quiet">
                      {fmtPct(i.cagr_3y, 0)}/yr
                    </Term>
                  </span>
                </>
              )}
            </>
          }
          onClick={
            flow && onProductClick && i.code ? () => onProductClick(i, flow) : undefined
          }
        />
      ))}
    </div>
  );
}

function ProductModal({
  detail,
  loading,
  onClose,
  onWorldwide,
}: {
  detail: ProductBreakdown | null;
  loading: boolean;
  onClose: () => void;
  onWorldwide?: () => void;
}) {
  useEffect(() => {
    if (!loading && !detail) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detail, loading, onClose]);

  return (
    <div className="modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-modal-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="row between" style={{ gap: 12 }}>
          <div>
            <p className="overline" style={{ margin: 0 }}>
              Product breakdown
            </p>
            <h2 id="product-modal-title" style={{ margin: '3px 0 0', fontSize: 24 }}>
              {detail?.product_name ?? 'Loading product details'}
            </h2>
          </div>
          <button className="icon-btn" type="button" onClick={onClose} aria-label="Close">
            ×
          </button>
        </div>

        {loading || !detail ? (
          <div className="skeleton" style={{ height: 120, marginTop: 18 }} />
        ) : (
          <>
            <div className="product-summary">
              <div>
                <span className="tiny dim">Flow</span>
                <strong>{detail.flow === 'export' ? 'Exported' : 'Imported'}</strong>
              </div>
              <div>
                <span className="tiny dim">Year</span>
                <strong>{detail.year}</strong>
              </div>
              <div>
                <span className="tiny dim">Product total</span>
                <strong>{fmtUsd(detail.product_value_usd)}</strong>
              </div>
              <div>
                <span className="tiny dim">Volume</span>
                <strong>
                  {detail.product_qty != null
                    ? `${detail.product_qty.toLocaleString()}${detail.product_qty_unit ? ` ${detail.product_qty_unit}` : ''}`
                    : 'Not reported'}
                </strong>
              </div>
            </div>
            <p className="small muted" style={{ margin: '16px 0 10px' }}>
              {detail.note}
            </p>
            {onWorldwide && (
              <button
                type="button"
                className="btn ghost sm"
                onClick={onWorldwide}
                style={{ marginBottom: 10 }}
              >
                See this product worldwide
              </button>
            )}
            {detail.rows.length ? (
              <div className="table-wrap">
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Trading partner</th>
                      <th>Volume</th>
                      <th className="align-right">Amount</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.rows.map((row, index) => (
                      <tr key={`${row.partner_iso3 ?? row.partner_name}-${index}`}>
                        <td>
                          <strong>{row.partner_name}</strong>
                          {row.partner_iso3 && <span className="tiny dim"> {row.partner_iso3}</span>}
                        </td>
                        <td>
                          {row.qty != null
                            ? `${row.qty.toLocaleString()}${row.qty_unit ? ` ${row.qty_unit}` : ''}`
                            : 'Not reported'}
                        </td>
                        <td className="align-right num">{fmtUsd(row.value_usd)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <Empty title="No partner rows reported" hint="The product total is available above." />
            )}
          </>
        )}
      </section>
    </div>
  );
}

function Rec({ rec }: { rec: Recommendation }) {
  return (
    <div className={`rec ${rec.angle}`}>
      <div className="row between" style={{ marginBottom: 4 }}>
        <h3>{rec.headline}</h3>
        <span className={`badge ${rec.strength}`}>{rec.strength}</span>
      </div>
      <p>{rec.detail}</p>
      {rec.evidence.length > 0 && (
        <div className="evidence">
          {rec.evidence.map((e, i) => (
            <div key={i}>• {e}</div>
          ))}
        </div>
      )}
    </div>
  );
}

interface ChartDatum {
  name: string;
  short: string;
  value: number;
  growthLabel: string;
  category?: ExportCategory;
  item: RankedItem;
}

/**
 * Axis labels for these charts.
 *
 * Product names arrive as full tariff descriptions, which repeat a shelving
 * word before the semicolon: four different vehicle lines all begin
 * "Vehicles; with...". Truncating those to one short line produced four
 * identical labels. So the shortener runs first to drop the repeated head,
 * then the result is split across two lines. The untouched name stays in the
 * tooltip.
 */
function axisLabel(name: string): string[] {
  const short = shortProductName(name);
  const words = short.split(' ');
  const lines: string[] = [];
  let line = '';

  for (const word of words) {
    if (lines.length === 1 && `${line} ${word}`.trim().length > AXIS_CHARS) break;
    if (`${line} ${word}`.trim().length > AXIS_CHARS) {
      lines.push(line.trim());
      line = word;
    } else {
      line = `${line} ${word}`.trim();
    }
  }
  if (line && lines.length < 2) lines.push(line.trim());

  // Mark that something was cut so nobody reads a clipped label as complete.
  const consumed = lines.join(' ').length;
  if (consumed < short.length - 1) lines[lines.length - 1] += '...';
  return lines.length ? lines : [short];
}

/** Characters per axis line. Two of these is the budget. */
const AXIS_CHARS = 22;

/** Renders the two-line label; recharts ticks do not wrap on their own. */
function AxisTick({
  x,
  y,
  payload,
}: {
  x?: number;
  y?: number;
  payload?: { value?: string };
}) {
  const lines = (payload?.value ?? '').split('\n');
  return (
    <g transform={`translate(${x ?? 0},${y ?? 0})`}>
      {lines.map((line, i) => (
        <text
          key={i}
          x={-6}
          y={i * 11 - (lines.length - 1) * 5.5}
          dy={3.5}
          textAnchor="end"
          fontSize={10}
          fill={CHART.axis}
        >
          {line}
        </text>
      ))}
    </g>
  );
}

function BarTooltip({
  active,
  payload,
}: {
  active?: boolean;
  payload?: Array<{ payload: ChartDatum }>;
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
        maxWidth: 240,
      }}
    >
      <div style={{ color: CHART.tooltipLabel, marginBottom: 2 }}>{d.name}</div>
      <div style={{ fontWeight: 700 }}>{fmtUsd(d.value)}</div>
      {d.growthLabel && (
        <div className="tiny" style={{ color: CHART.tooltipLabel, marginTop: 2 }}>
          {d.growthLabel} growth
        </div>
      )}
    </div>
  );
}

/** Horizontal bar chart of products. Bars are tappable and open the product
 *  modal rather than navigating away. When colorByCategory is set, non-traditional
 *  (SME-accessible) lines are drawn in the up/green colour and traditional lines
 *  in the muted one. */
function ProductBarChart({
  title,
  caption,
  items,
  flow,
  onProductClick,
  colorByCategory,
  showGrowth,
  emptyHint,
}: {
  title: string;
  caption: string;
  items: RankedItem[];
  flow: 'export' | 'import';
  onProductClick: (item: RankedItem, flow: 'export' | 'import') => void;
  colorByCategory?: boolean;
  showGrowth?: boolean;
  emptyHint: string;
}) {
  const rows: ChartDatum[] = items.map((i) => ({
    name: i.name,
    short: axisLabel(i.name).join('\n'),
    value: i.value_usd,
    growthLabel: i.cagr_3y != null ? `${fmtPct(i.cagr_3y, 0)}/yr` : '',
    category: i.category,
    item: i,
  }));
  // Height grows with the row count so bars stay tall enough to tap on a phone,
  // and so two-line axis labels are not clipped by their neighbours.
  const height = Math.max(150, rows.length * 40 + 24);
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      {rows.length === 0 ? (
        <Empty title="Nothing to show" hint={emptyHint} />
      ) : (
        <>
          <div style={{ height, margin: '0 -8px' }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={rows}
                margin={{ top: 4, right: showGrowth ? 52 : 12, left: 4, bottom: 0 }}
              >
                <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" horizontal={false} />
                <XAxis
                  type="number"
                  stroke={CHART.axis}
                  tick={{ fontSize: 10 }}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => fmtUsd(v).replace('$', '')}
                />
                <YAxis
                  type="category"
                  dataKey="short"
                  stroke={CHART.axis}
                  tickLine={false}
                  axisLine={false}
                  width={132}
                  interval={0}
                  tick={<AxisTick />}
                />
                <Tooltip cursor={{ fill: CHART.brandSoft }} content={<BarTooltip />} />
                <Bar
                  dataKey="value"
                  radius={[0, 3, 3, 0]}
                  cursor="pointer"
                  onClick={(entry) => {
                    const item = (entry as unknown as { payload?: ChartDatum }).payload?.item;
                    if (item?.code) onProductClick(item, flow);
                  }}
                >
                  {rows.map((r, idx) => (
                    <Cell
                      key={idx}
                      fill={
                        colorByCategory
                          ? r.category === 'non_traditional'
                            ? CHART.up
                            : CHART.muted
                          : CHART.up
                      }
                    />
                  ))}
                  {showGrowth && (
                    <LabelList
                      dataKey="growthLabel"
                      position="right"
                      fill={CHART.tooltipLabel}
                      fontSize={10}
                    />
                  )}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <p className="tiny dim" style={{ margin: '8px 4px 0' }}>
            {caption}
          </p>
        </>
      )}
    </div>
  );
}
