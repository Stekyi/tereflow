import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api, getTier } from '../lib/api';
import { BarRow, Chips, Empty, Skeletons, Stat } from '../components/ui';
import {
  fmtPct,
  fmtUsd,
  linkHealth,
  LINK_HEALTH_LABEL,
  type CountryDashboard,
  type RankedItem,
  type Recommendation,
} from '../../shared/types';

type Tab = 'summary' | 'products' | 'partners' | 'outlook';

export default function Country() {
  const { slug = '' } = useParams();
  const [data, setData] = useState<(CountryDashboard & { inactive?: boolean; message?: string }) | null>(
    null,
  );
  const [sources, setSources] = useState<Awaited<ReturnType<typeof api.dashboardSources>> | null>(
    null,
  );
  const [tab, setTab] = useState<Tab>('summary');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const tier = getTier();

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
        sub={`${data.entity.continent ?? ''} · figures for ${o.year}`}
      />

      <Chips
        options={[
          { value: 'summary' as Tab, label: 'Summary' },
          { value: 'products' as Tab, label: 'Products' },
          { value: 'partners' as Tab, label: 'Partners' },
          { value: 'outlook' as Tab, label: 'Outlook' },
        ]}
        value={tab}
        onChange={setTab}
      />
      <div style={{ height: 14 }} />

      {tab === 'summary' && (
        <>
          <div className="grid two" style={{ marginBottom: 12 }}>
            <Stat
              label="Exports"
              value={fmtUsd(o.export_usd)}
              delta={o.export_yoy_pct != null ? `${fmtPct(o.export_yoy_pct)} yr/yr` : null}
              deltaTone={o.export_yoy_pct != null ? (o.export_yoy_pct >= 0 ? 'up' : 'down') : null}
            />
            <Stat
              label="Imports"
              value={fmtUsd(o.import_usd)}
              delta={o.import_yoy_pct != null ? `${fmtPct(o.import_yoy_pct)} yr/yr` : null}
              deltaTone={o.import_yoy_pct != null ? (o.import_yoy_pct >= 0 ? 'up' : 'down') : null}
            />
            <Stat
              label="Trade balance"
              value={fmtUsd(o.balance_usd)}
              delta={o.balance_usd >= 0 ? 'Surplus' : 'Deficit'}
              deltaTone={o.balance_usd >= 0 ? 'up' : 'down'}
            />
            <Stat
              label="Trading partners"
              value={String(o.partner_count)}
              delta={`${o.product_count} product groups`}
            />
          </div>

          {o.export_concentration != null && (
            <div className="card tight">
              <div className="row between">
                <span className="small muted">Export concentration</span>
                <span
                  className={`badge ${
                    o.export_concentration > 0.25
                      ? 'watch'
                      : o.export_concentration > 0.15
                        ? 'moderate'
                        : 'strong'
                  }`}
                >
                  {o.export_concentration > 0.25
                    ? 'Concentrated'
                    : o.export_concentration > 0.15
                      ? 'Moderate'
                      : 'Diversified'}
                </span>
              </div>
              <div
                style={{
                  height: 7,
                  background: 'var(--bg-2)',
                  borderRadius: 999,
                  marginTop: 9,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    height: '100%',
                    width: `${Math.min(100, o.export_concentration * 200)}%`,
                    background:
                      o.export_concentration > 0.25 ? 'var(--warn)' : 'var(--brand)',
                  }}
                />
              </div>
              <p className="tiny dim" style={{ margin: '8px 0 0' }}>
                How much of what this country sells depends on a handful of products. Higher means
                one price shock moves the whole economy.
              </p>
            </div>
          )}

          {data.trend.length > 1 && (
            <div className="card">
              <p className="card-title">Yearly trend</p>
              <div style={{ height: 210, margin: '0 -8px' }}>
                <ResponsiveContainer width="100%" height="100%">
                  <AreaChart data={data.trend} margin={{ top: 4, right: 8, left: -14, bottom: 0 }}>
                    <defs>
                      <linearGradient id="gx" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3ba9ff" stopOpacity={0.45} />
                        <stop offset="100%" stopColor="#3ba9ff" stopOpacity={0.02} />
                      </linearGradient>
                      <linearGradient id="gm" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#fb7185" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="#fb7185" stopOpacity={0.02} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="#26375a" strokeDasharray="3 3" vertical={false} />
                    <XAxis
                      dataKey="year"
                      stroke="#6c80a6"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                    />
                    <YAxis
                      stroke="#6c80a6"
                      tick={{ fontSize: 11 }}
                      tickLine={false}
                      axisLine={false}
                      tickFormatter={(v: number) => fmtUsd(v).replace('$', '')}
                      width={52}
                    />
                    <Tooltip
                      contentStyle={{
                        background: '#16233c',
                        border: '1px solid #26375a',
                        borderRadius: 12,
                        fontSize: 13,
                      }}
                      labelStyle={{ color: '#93a4c4' }}
                      formatter={(v: number, n: string) => [fmtUsd(v), n]}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} iconType="circle" />
                    <Area
                      type="monotone"
                      dataKey="export_usd"
                      name="Exports"
                      stroke="#3ba9ff"
                      strokeWidth={2}
                      fill="url(#gx)"
                    />
                    <Area
                      type="monotone"
                      dataKey="import_usd"
                      name="Imports"
                      stroke="#fb7185"
                      strokeWidth={2}
                      fill="url(#gm)"
                    />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {data.services.length > 0 && (
            <div className="card">
              <p className="card-title">Services</p>
              {data.services.map((s) => (
                <div className="row between" key={s.code} style={{ marginBottom: 7 }}>
                  <span className="small">{s.name}</span>
                  <span className="small" style={{ fontWeight: 700 }}>
                    {fmtUsd(s.value_usd)}{' '}
                    {s.yoy_pct != null && (
                      <span className={s.yoy_pct >= 0 ? 'up' : 'down'}>{fmtPct(s.yoy_pct)}</span>
                    )}
                  </span>
                </div>
              ))}
            </div>
          )}

          {o.coverage_note && (
            <p className="tiny dim" style={{ marginTop: 14 }}>
              ⓘ {o.coverage_note}
            </p>
          )}
        </>
      )}

      {tab === 'products' && (
        <>
          <Ranked title="What it sells most" items={data.top_exports} />
          <Ranked title="What it buys most" items={data.top_imports} />
        </>
      )}

      {tab === 'partners' && (
        <>
          <Ranked title="Where exports go" items={data.partners_export} />
          <Ranked title="Where imports come from" items={data.partners_import} />
        </>
      )}

      {tab === 'outlook' && (
        <>
          <div className="section-head">
            <h2>What this means</h2>
          </div>
          {data.recommendations.length === 0 ? (
            <Empty title="No read yet" hint="Recommendations appear after the first analysis run." />
          ) : (
            data.recommendations.map((r, i) => <Rec key={i} rec={r} />)
          )}

          <div className="section-head">
            <h2>Early signals</h2>
            <span className="badge premium">Premium</span>
          </div>

          {tier === 'premium' && data.opportunities ? (
            data.opportunities.length === 0 ? (
              <Empty title="No emerging signal detected" hint="Nothing is growing fast enough outside the top products yet." />
            ) : (
              data.opportunities.map((s) => (
                <div className="card" key={s.id}>
                  <div className="row between" style={{ marginBottom: 6 }}>
                    <strong style={{ fontSize: 15 }}>{s.product_name}</strong>
                    <span className={`badge ${s.momentum > 0.6 ? 'strong' : 'watch'}`}>
                      {(s.momentum * 100).toFixed(0)}% momentum
                    </span>
                  </div>
                  <p className="small muted" style={{ margin: 0 }}>
                    {s.rationale}
                  </p>
                  <div className="row" style={{ marginTop: 10, gap: 16 }}>
                    <span className="tiny dim">
                      Rank now <strong style={{ color: 'var(--text)' }}>{s.current_rank ?? '—'}</strong>
                    </span>
                    <span className="tiny dim">
                      Projected in {s.horizon_years}y{' '}
                      <strong style={{ color: 'var(--brand-2)' }}>{s.projected_rank ?? '—'}</strong>
                    </span>
                    <span className="tiny dim">
                      Confidence{' '}
                      <strong style={{ color: 'var(--text)' }}>
                        {s.confidence != null ? `${(s.confidence * 100).toFixed(0)}%` : '—'}
                      </strong>
                    </span>
                  </div>
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
              <span className="badge premium">Premium feature</span>
            </div>
          )}
        </>
      )}

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

function Header({ name, iso3, sub }: { name: string; iso3: string | null; sub: string }) {
  return (
    <div className="row" style={{ marginBottom: 16, gap: 12 }}>
      <span className="flag" style={{ width: 44, height: 32, fontSize: 12 }}>
        {iso3 ?? '??'}
      </span>
      <div>
        <div style={{ fontSize: 22, fontWeight: 750, letterSpacing: '-0.03em', lineHeight: 1.15 }}>
          {name}
        </div>
        <div className="tiny dim">{sub}</div>
      </div>
    </div>
  );
}

function Ranked({ title, items }: { title: string; items: RankedItem[] }) {
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
          meta={
            <>
              {i.share_pct.toFixed(1)}% share
              {i.cagr_3y != null && (
                <>
                  {' · '}
                  <span className={i.cagr_3y >= 0 ? 'up' : 'down'}>
                    {fmtPct(i.cagr_3y, 0)}/yr
                  </span>
                </>
              )}
            </>
          }
        />
      ))}
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
