import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
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
import { usePageTitle } from '../lib/pageTitle';
import { CHART } from '../lib/theme';
import { Term } from '../components/Term';
import { disambiguateProductNames, shortProductName } from '../../shared/product-name';
import { BarRow, Empty, FollowButton, Skeletons, Stat, useToast } from '../components/ui';
import GlobalProductModal from '../components/ProductModal';
import SectionNav, { type Section } from '../components/SectionNav';
import {
  EXPORT_CATEGORY_HINT,
  EXPORT_CATEGORY_LABEL,
  fmtPct,
  fmtUsd,
  linkHealth,
  LINK_HEALTH_LABEL,
  type CountryDashboard,
  type CountrySummary,
  type ExportCategory,
  type RankedItem,
  type Recommendation,
} from '../../shared/types';

// --- sector colouring for the product charts ---------------------------------
//
// Colour carries meaning here: each bar is tinted by the product's sector,
// derived from its HS2 chapter (the first two digits of the code). We rebuild
// the chapter grouping on the client rather than importing the worker's
// hs2Sector, so no server code leaks into the bundle. A chapter we cannot place
// falls to an honest "Other" instead of being forced into a family.
interface Sector {
  key: string;
  label: string;
  color: string;
}

const SECTORS: Record<string, Sector> = {
  agrifood: { key: 'agrifood', label: 'Agriculture and food', color: '#4f7a3f' },
  minerals: { key: 'minerals', label: 'Minerals and fuels', color: '#6b5744' },
  chemicals: { key: 'chemicals', label: 'Chemicals and plastics', color: '#6f5aa0' },
  textiles: { key: 'textiles', label: 'Textiles and clothing', color: '#a4557a' },
  metals: { key: 'metals', label: 'Metals and gems', color: '#9c6b3b' },
  machinery: { key: 'machinery', label: 'Machinery and electronics', color: '#2f6f9f' },
  vehicles: { key: 'vehicles', label: 'Vehicles and transport', color: '#2b8a8a' },
  other: { key: 'other', label: 'Other sectors', color: '#8a94a2' },
};

// Stable order for the legend, so families always read in the same sequence.
const SECTOR_ORDER = [
  'agrifood',
  'minerals',
  'chemicals',
  'textiles',
  'metals',
  'machinery',
  'vehicles',
  'other',
];

/** Maps an HS code to a sector family via its HS2 chapter. A missing or
 *  unrecognised code returns the honest "Other" family rather than a guess. */
function sectorFor(code: string | null | undefined): Sector {
  const hs2 = code ? Number(code.slice(0, 2)) : NaN;
  if (!Number.isFinite(hs2)) return SECTORS.other;
  if (hs2 >= 1 && hs2 <= 24) return SECTORS.agrifood;
  if (hs2 >= 25 && hs2 <= 27) return SECTORS.minerals;
  if (hs2 >= 28 && hs2 <= 40) return SECTORS.chemicals;
  if (hs2 >= 50 && hs2 <= 67) return SECTORS.textiles;
  if (hs2 === 71 || (hs2 >= 72 && hs2 <= 83)) return SECTORS.metals;
  if (hs2 === 84 || hs2 === 85) return SECTORS.machinery;
  if (hs2 >= 86 && hs2 <= 89) return SECTORS.vehicles;
  return SECTORS.other;
}

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
  // One product modal, scoped to this country and the flow the row or bar was
  // listed under, so the reader sees this country's figures for that product.
  // A worldwide tap (an early signal) leaves slug and flow unset.
  const [modal, setModal] = useState<{ hs: string; slug?: string; flow?: 'export' | 'import' } | null>(
    null,
  );
  usePageTitle(data?.entity.name);
  // ISO3 -> slug for countries we actually have a page for, so partner names
  // only become links when the destination exists (no dead links to untracked
  // partners).
  const [partnerSlug, setPartnerSlug] = useState<Map<string, string>>(new Map());
  const navigate = useNavigate();
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

  // Open the shared modal scoped to this country and flow. Guard a null code
  // so a partner-style row with no HS code can never open an empty modal.
  function openProduct(item: RankedItem, flow: 'export' | 'import') {
    if (!item.code) return;
    setModal({ hs: item.code, slug, flow });
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

  // Build the ISO3 -> slug map once, from the countries that actually have a
  // page (active only), so a trading partner links through when we cover it and
  // stays plain text when we do not.
  useEffect(() => {
    api
      .countries({})
      .then((r) => {
        const map = new Map<string, string>();
        for (const c of r.countries as CountrySummary[]) {
          if (c.is_active && c.iso3) map.set(c.iso3.toUpperCase(), c.slug);
        }
        setPartnerSlug(map);
      })
      .catch(() => undefined);
  }, []);

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
          hint="Figures appear once the pipeline has fetched this country. That runs on the operator's machine, not in the cloud, so it fills in over time rather than on demand."
        />
      </>
    );
  }

  // Only advertise sections that actually render, so the sticky nav never points
  // at an anchor that is not on the page. The charts and balance always render
  // (they show their own empty state), so they are unconditional.
  const hasSignals = !!(data.opportunities?.length || data.opportunities_locked > 0);
  const hasPartners = data.partners_export.length > 0 || data.partners_import.length > 0;
  const sectionLinks: Section[] = [
    { id: 'overview', label: 'Overview' },
    { id: 'imports', label: 'Imports' },
    { id: 'exports', label: 'Exports' },
    { id: 'balance', label: 'Trade balance' },
    { id: 'read', label: 'What this means' },
    ...(hasSignals ? [{ id: 'signals', label: 'Early signals' }] : []),
    ...(hasPartners ? [{ id: 'partners', label: 'Partners' }] : []),
    ...(sources ? [{ id: 'sources', label: 'Sources' }] : []),
  ];

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
      {modal && (
        <GlobalProductModal
          hsCode={modal.hs}
          countrySlug={modal.slug ?? null}
          flow={modal.flow ?? null}
          onClose={() => setModal(null)}
        />
      )}

      <SectionNav sections={sectionLinks} />
      <div style={{ height: 12 }} />

      <section id="overview" className="section-anchor" aria-label="Overview">
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
      </section>

      <section id="imports" className="section-anchor" aria-label="Top imports">
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
        caption="What this country buys most, coloured by sector so you can read the mix at a glance. Faded bars are large licensed trade (gold, oil, and similar); solid bars are non-traditional lines an SME can supply. Tap a bar for this country's figures on that product."
        items={reRank(data.top_imports, showMajor)}
        flow="import"
        onProductClick={openProduct}
        emptyHint="No import breakdown recorded for this year."
      />
      </section>

      <section id="exports" className="section-anchor" aria-label="Non-traditional exports">
      <ProductBarChart
        title="Non-traditional exports"
        caption="Value sold abroad outside the headline commodities, coloured by sector, with recent yearly growth per line. Tap a bar for this country's figures on that product."
        items={data.top_exports.filter((i) => i.category === 'non_traditional')}
        flow="export"
        showGrowth
        onProductClick={openProduct}
        emptyHint="No non-traditional export lines recorded for this year."
      />
      </section>

      <section id="balance" className="section-anchor" aria-label="Trade balance">
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
      </section>

      <section id="read" className="section-anchor" aria-label="What this means">
      <div className="section-head">
        <h2>What this means</h2>
      </div>
      {data.recommendations.length === 0 ? (
        <Empty title="No read yet" hint="Recommendations appear after the first analysis run." />
      ) : (
        data.recommendations.map((r, i) => <Rec key={i} rec={r} />)
      )}
      </section>

      <section id="signals" className="section-anchor" aria-label="Early signals">
      {/* Premium. Kept on this page because the signals are per country: a
          reader looking at one market is exactly who this is for. The count is
          shown to everyone and the detail only to entitled accounts, so the
          paywall says what is behind it rather than being a blank wall. */}
      {(data.opportunities?.length || data.opportunities_locked > 0) && (
        <>
          <div className="section-head">
            <h2>Early signals</h2>
            <span className="badge premium">Premium</span>
          </div>

          {data.opportunities ? (
            data.opportunities.length === 0 ? (
              <Empty
                title="No emerging signal detected"
                hint="Nothing is growing fast enough outside the top products yet."
              />
            ) : (
              data.opportunities.map((s) => (
                <div className="card" key={s.id}>
                  <div className="row between" style={{ marginBottom: 6, gap: 10 }}>
                    <strong style={{ fontSize: 15 }}>{shortProductName(s.product_name)}</strong>
                    <span className={`badge ${s.momentum > 0.6 ? 'strong' : 'watch'}`}>
                      <Term k="momentum" tone="quiet">
                        {(s.momentum * 100).toFixed(0)}% momentum
                      </Term>
                    </span>
                  </div>
                  <p className="small muted" style={{ margin: 0 }}>
                    {s.rationale}
                  </p>
                  <div className="row wrap" style={{ marginTop: 12, gap: 16 }}>
                    <span className="tiny dim">
                      Rank now{' '}
                      <strong style={{ color: 'var(--ink)' }}>{s.current_rank ?? 'not ranked'}</strong>
                    </span>
                    <span className="tiny dim">
                      Projected in {s.horizon_years}y{' '}
                      <strong style={{ color: 'var(--gold)' }}>
                        {s.projected_rank ?? 'not projected'}
                      </strong>
                    </span>
                    <span className="tiny dim">
                      Confidence{' '}
                      <strong style={{ color: 'var(--ink)' }}>
                        {s.confidence != null ? `${(s.confidence * 100).toFixed(0)}%` : 'not scored'}
                      </strong>
                    </span>
                  </div>
                  {s.hs_code && (
                    <button
                      type="button"
                      className="btn ghost sm"
                      style={{ marginTop: 12 }}
                      onClick={() => setModal({ hs: s.hs_code as string })}
                    >
                      See this product worldwide
                    </button>
                  )}
                </div>
              ))
            )
          ) : (
            <div className="locked">
              <div style={{ fontSize: 26 }}>🔒</div>
              <h3>
                {data.opportunities_locked} emerging{' '}
                {data.opportunities_locked === 1 ? 'signal' : 'signals'} detected
              </h3>
              <p>
                Products growing fast enough to change this market inside four years, while they are
                still outside the headline rankings.
              </p>
              {user ? (
                <Link className="btn gold" to="/upgrade">
                  See premium
                </Link>
              ) : (
                <Link className="btn primary" to={`/join?next=/country/${slug}`}>
                  Join free to unlock
                </Link>
              )}
            </div>
          )}
        </>
      )}
      </section>

      <section id="partners" className="section-anchor" aria-label="Trading partners">
      <div className="section-head">
        <h2>Trading partners</h2>
      </div>
      <Ranked title="Where exports go" items={data.partners_export} partnerSlug={partnerSlug} onGo={(s) => navigate(`/country/${s}`)} />
      <Ranked title="Where imports come from" items={data.partners_import} partnerSlug={partnerSlug} onGo={(s) => navigate(`/country/${s}`)} />
      </section>

      {sources && (
        <section id="sources" className="section-anchor" aria-label="Where this comes from">
          <div className="section-head">
            <h2>Where this comes from</h2>
          </div>
          <div className="card">
            <p className="tiny dim" style={{ marginTop: 0 }}>
              {sources.note}
            </p>
            {sources.attempts?.length ? (
              <div className="tiny dim" style={{ marginTop: 10 }}>
                <strong>Data used and validation</strong>
                {sources.attempts.slice(0, 8).map((attempt) => (
                  <div key={`${attempt.attempted_at}-${attempt.source_ref}`}>
                    {attempt.role}: {attempt.source_ref} ({attempt.status}, {attempt.rows_written} rows)
                  </div>
                ))}
              </div>
            ) : null}
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
        </section>
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
  partnerSlug,
  onGo,
}: {
  title: string;
  items: RankedItem[];
  follow?: FollowWiring;
  flow?: 'export' | 'import';
  onProductClick?: (item: RankedItem, flow: 'export' | 'import') => void;
  // For partner lists: an ISO3 -> slug map and a go handler, so a partner we
  // cover becomes a tap through to its own market and one we do not stays plain.
  partnerSlug?: Map<string, string>;
  onGo?: (slug: string) => void;
}) {
  if (!items.length) return null;
  const max = Math.max(...items.map((i) => i.share_pct), 1);
  return (
    <div className="card">
      <p className="card-title">{title}</p>
      {items.map((i) => {
        const partnerDest =
          !flow && onGo && partnerSlug && i.code ? partnerSlug.get(i.code.toUpperCase()) : undefined;
        return (
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
              {partnerDest && (
                <>
                  {' · '}
                  <span className="u">View market {'\u203a'}</span>
                </>
              )}
            </>
          }
          onClick={
            flow && onProductClick && i.code
              ? () => onProductClick(i, flow)
              : partnerDest
                ? () => onGo!(partnerDest)
                : undefined
          }
        />
        );
      })}
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
 * Takes an already-shortened name. Shortening happens in
 * `disambiguateProductNames`, which needs to see every product in the chart at
 * once: four vehicle lines separated only by engine size shorten to the same
 * text, so what distinguishes them has to be carried through. Re-shortening
 * here would clip that distinguishing tail straight back off.
 *
 * The untouched name stays in the tooltip.
 */
function axisLabel(short: string): string[] {
  // A disambiguated label carries what distinguishes this line from its
  // neighbours in a trailing bracket. That part is the whole reason the label
  // exists, so it gets its own line rather than competing for the word budget
  // and losing.
  const distinct = short.match(/^(.*?)\s*\(([^()]+)\)$/);
  if (distinct) {
    return [clipLine(distinct[1]), clipLine(distinct[2], AXIS_DISTINCT_CHARS)];
  }

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

/**
 * The line carrying what distinguishes one product from its neighbours gets a
 * wider budget than the shared name above it, because it is the only part of
 * the label doing any work.
 */
const AXIS_DISTINCT_CHARS = 32;

/**
 * One axis line, marked when it had to be cut.
 *
 * Never breaks inside a number. "over 1500 but not over 3000cc" clipped to the
 * ordinary budget reads "over 1500 but not ove..." at best and "...over 300..."
 * at worst, and 300cc is a real engine size, so the clip would not look like a
 * clip. Where a digit run would be split the cut moves back to before it.
 */
function clipLine(text: string, max: number = AXIS_CHARS): string {
  const t = text.trim();
  if (t.length <= max) return t;
  let cut = max - 1;
  while (cut > 0 && /\d/.test(t[cut - 1]) && /[\d,.]/.test(t[cut])) cut -= 1;
  const head = t.slice(0, cut).trimEnd().replace(/[,;]$/, '');
  return head ? `${head}...` : `${t.slice(0, max - 1).trimEnd()}...`;
}

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
          // The second line of a two-line label is what separates this product
          // from its near-identical neighbours, and for engine or capacity
          // bands that runs long. Shrinking it keeps the whole band inside the
          // axis width, which matters more than matching the line above:
          // clipping it would cut a number in half and read as a smaller one.
          fontSize={i === 1 && line.length > AXIS_CHARS ? 8.5 : 10}
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
 *  modal rather than navigating away. Each bar is coloured by its product's
 *  sector (from the HS2 chapter) so the mix reads at a glance, and traditional
 *  (licensed) lines are drawn faded so that separate signal stays visible. A
 *  legend below lists only the sectors actually present. */
function ProductBarChart({
  title,
  caption,
  items,
  flow,
  onProductClick,
  showGrowth,
  emptyHint,
}: {
  title: string;
  caption: string;
  items: RankedItem[];
  flow: 'export' | 'import';
  onProductClick: (item: RankedItem, flow: 'export' | 'import') => void;
  showGrowth?: boolean;
  emptyHint: string;
}) {
  // Disambiguation needs the whole chart in view: whether a label collides is a
  // property of the set, not of any one product.
  const labels = disambiguateProductNames(
    items.map((i) => ({ code: i.code ?? i.name, description: i.name })),
  );
  const rows: ChartDatum[] = items.map((i) => ({
    name: i.name,
    short: axisLabel(labels.get(i.code ?? i.name) ?? shortProductName(i.name)).join('\n'),
    value: i.value_usd,
    growthLabel: i.cagr_3y != null ? `${fmtPct(i.cagr_3y, 0)}/yr` : '',
    category: i.category,
    item: i,
  }));
  // Sectors present in this chart, in the stable legend order, so the key only
  // shows families that actually appear.
  const present = new Set(rows.map((r) => sectorFor(r.item.code).key));
  const legend = SECTOR_ORDER.filter((k) => present.has(k)).map((k) => SECTORS[k]);
  const hasTraditional = rows.some((r) => r.category === 'traditional');
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
                      fill={sectorFor(r.item.code).color}
                      fillOpacity={r.category === 'traditional' ? 0.45 : 1}
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
          <div className="chart-legend" aria-hidden="true">
            {legend.map((s) => (
              <span className="chart-legend-item" key={s.key}>
                <span className="swatch" style={{ background: s.color }} />
                {s.label}
              </span>
            ))}
            {hasTraditional && (
              <span className="chart-legend-item">
                <span className="swatch faded" />
                Traditional (licensed)
              </span>
            )}
          </div>
          <p className="tiny dim" style={{ margin: '8px 4px 0' }}>
            {caption}
          </p>
        </>
      )}
    </div>
  );
}
