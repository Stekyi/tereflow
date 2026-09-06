import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { Link } from 'react-router-dom';
import {
  BarChart,
  Bar,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  api,
  getAdminToken,
  setAdminToken,
  type PortalOverview,
  type PortalRun,
  type PortalCountryRow,
  type PortalUser,
  type PortalCard,
  type PortalRating,
  type PortalBillingEvent,
  type PortalSource,
  type PortalPlaybook,
  type PortalSetup,
  type SourceHealth,
} from '../lib/api';
import { Chips, Empty, Skeletons, Toggle, useToast } from '../components/ui';
import {
  EXPORT_CATEGORY_LABEL,
  KIND_LABEL,
  linkHealth,
  type Entity,
  type EntityWithSources,
  type ExportCategory,
  type FeedbackKind,
  FEEDBACK_KIND_LABEL,
  type ResolvedClassification,
  type SourceFmt,
} from '../../shared/types';

type Toaster = ReturnType<typeof useToast>;
type OnError = (e: unknown) => void;

type SectionId =
  | 'overview'
  | 'registry'
  | 'pipeline'
  | 'sources'
  | 'products'
  | 'users'
  | 'network'
  | 'premium'
  | 'content'
  | 'feedback'
  | 'setup';

// Each entry drives one sidebar button and the matching panel. Icons are plain
// stroke glyphs so the nav stays monochrome with the rest of the shell.
const SECTIONS: { id: SectionId; label: string; icon: string }[] = [
  { id: 'overview', label: 'Overview', icon: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z' },
  { id: 'registry', label: 'Registry', icon: 'M4 6h16M4 12h16M4 18h16' },
  { id: 'pipeline', label: 'Pipeline', icon: 'M4 7h6M4 12h10M4 17h7M20 5v14' },
  { id: 'sources', label: 'Sources', icon: 'M9 15l6-6M8 9a3 3 0 0 0 0 6h1M16 9h-1a3 3 0 0 1 0 6' },
  { id: 'products', label: 'Products', icon: 'M20 12l-8 8-8-8 8-8h8zM16 8h.01' },
  { id: 'users', label: 'Users', icon: 'M16 11a3 3 0 1 0-6 0M4 20c0-3 3-5 6-5s6 2 6 5M18 14c2 0 4 1.5 4 4' },
  { id: 'network', label: 'Network', icon: 'M4 5h16v10H4zM8 19h8' },
  { id: 'premium', label: 'Premium', icon: 'M12 3l2.9 6 6.1.9-4.5 4.3 1 6-5.5-2.9L6.5 20l1-6L3 9.9 9.1 9z' },
  { id: 'content', label: 'Content', icon: 'M6 4h9l3 3v13H6zM9 9h6M9 13h6' },
  { id: 'feedback', label: 'Feedback', icon: 'M4 5h16v11H9l-5 4z' },
  { id: 'setup', label: 'Setup', icon: 'M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM4 12h2M18 12h2M12 4v2M12 18v2' },
];

export default function Portal() {
  const [token, setToken] = useState(getAdminToken());
  const [authed, setAuthed] = useState(Boolean(getAdminToken()));
  const [section, setSection] = useState<SectionId>('overview');
  const t = useToast();

  // One error path for every section: an auth failure drops back to the token
  // prompt, everything else surfaces as a toast.
  const onError = useCallback<OnError>(
    (e) => {
      const m = (e as Error).message || 'Request failed';
      if (/authoris|unauthor|\b401\b/i.test(m)) setAuthed(false);
      t.err(m);
    },
    [t],
  );

  function signIn() {
    setAdminToken(token.trim());
    setAuthed(true);
  }

  if (!authed) {
    return (
      <>
        {t.node}
        <div className="card">
          <p className="card-title">Owner sign in</p>
          <div className="field">
            <label htmlFor="tok">Admin token</label>
            <input
              id="tok"
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="The value of ADMIN_TOKEN"
              onKeyDown={(e) => e.key === 'Enter' && signIn()}
            />
            <div className="help">
              Set it once with <code>wrangler secret put ADMIN_TOKEN</code>. For local development
              put <code>ADMIN_TOKEN=...</code> in <code>.dev.vars</code>.
            </div>
          </div>
          <button className="btn primary block" onClick={signIn} disabled={!token.trim()}>
            Sign in
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {t.node}

      <div className="portal-head">
        <h2 className="display">Owner portal</h2>
        <p className="small dim" style={{ margin: 0 }}>
          Everything that runs Tereflow, in one place.
        </p>
      </div>

      <div className="portal">
        <nav className="portal-nav" aria-label="Portal sections">
          {SECTIONS.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`portal-nav-item ${section === s.id ? 'active' : ''}`}
              onClick={() => setSection(s.id)}
              aria-current={section === s.id ? 'page' : undefined}
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
                <path d={s.icon} />
              </svg>
              <span>{s.label}</span>
            </button>
          ))}
        </nav>

        <div className="portal-main">
          {section === 'overview' && <Overview onError={onError} />}
          {section === 'registry' && <Registry t={t} onError={onError} />}
          {section === 'pipeline' && <Pipeline onError={onError} />}
          {section === 'sources' && <Sources t={t} onError={onError} />}
          {section === 'products' && <Products t={t} onError={onError} />}
          {section === 'users' && <Users onError={onError} />}
          {section === 'network' && <Network onError={onError} />}
          {section === 'premium' && <Premium onError={onError} />}
          {section === 'content' && <Content onError={onError} />}
          {section === 'feedback' && <Feedback t={t} onError={onError} />}
          {section === 'setup' && <Setup onError={onError} />}
        </div>
      </div>
    </>
  );
}

/* ---- shared portal primitives (reference shape) ---- */

function Stat({
  label,
  value,
  sub,
  tone,
}: {
  label: ReactNode;
  value: ReactNode;
  sub?: ReactNode;
  tone?: 'up' | 'down' | 'gold' | 'warn';
}) {
  return (
    <div className="stat">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub != null && <div className={`delta ${tone ?? 'dim'}`}>{sub}</div>}
    </div>
  );
}

function Panel({
  title,
  action,
  children,
}: {
  title: ReactNode;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="card">
      <div className="row between" style={{ marginBottom: 10 }}>
        <p className="card-title" style={{ margin: 0 }}>
          {title}
        </p>
        {action}
      </div>
      {children}
    </section>
  );
}

/* ---- helpers ---- */

const fmtDate = (s: string | null | undefined) => (s ? s.slice(0, 10) : 'â€”');
const fmtDateTime = (s: string | null | undefined) =>
  s ? s.slice(0, 16).replace('T', ' ') : 'â€”';
const num = (n: number | null | undefined) => (n == null ? '0' : n.toLocaleString('en'));

function StatusBadge({ status }: { status: string }) {
  const cls = status === 'ok' || status === 'success' ? 'on' : status === 'error' || status === 'failed' ? 'off' : 'watch';
  return <span className={`badge ${cls}`}>{status}</span>;
}

/* ---- Overview ---- */

function Overview({ onError }: { onError: OnError }) {
  const [data, setData] = useState<PortalOverview | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .overview()
      .then(setData)
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <Skeletons n={5} />;
  if (!data) return <Empty title="Overview unavailable" hint="The request did not return data." />;

  const c = data.counts;
  const a = data.attention;
  const run = data.last_run;
  const lh = data.link_health;

  const attentionItems: string[] = [];
  if (a.active_never_run > 0)
    attentionItems.push(
      `${a.active_never_run} active ${a.active_never_run === 1 ? 'country has' : 'countries have'} never run. Run npm run pipeline locally to fetch their data.`,
    );
  if (a.stale_over_14_days > 0)
    attentionItems.push(
      `${a.stale_over_14_days} ${a.stale_over_14_days === 1 ? 'country has' : 'countries have'} not refreshed in over 14 days. Run the local pipeline to update them.`,
    );
  if (a.dead_links > 0)
    attentionItems.push(
      `${a.dead_links} source ${a.dead_links === 1 ? 'link is' : 'links are'} not reachable. Open Sources, filter to Dead, and repair or replace them.`,
    );
  if (a.feedback_new > 0)
    attentionItems.push(
      `${a.feedback_new} new feedback ${a.feedback_new === 1 ? 'message' : 'messages'} to read. Open Feedback.`,
    );

  const nothingWrong = attentionItems.length === 0 && a.countries_with_errors.length === 0;

  return (
    <>
      <div className="portal-tiles">
        <Stat label="Countries" value={num(c.countries)} sub={`${num(c.countries_active)} active`} />
        <Stat label="Facts stored" value={num(c.facts)} />
        <Stat label="Signals" value={num(c.signals)} />
        <Stat label="Sources" value={num(c.sources)} />
        <Stat label="Bodies" value={num(c.orgs + c.regional)} sub={`${num(c.orgs)} intl, ${num(c.regional)} regional`} />
        <Stat label="Users" value={num(c.users)} sub={`${num(c.premium_users)} premium`} tone="gold" />
        <Stat label="Cards" value={num(c.cards)} />
        <Stat label="Messages" value={num(c.messages)} />
        <Stat label="Ratings" value={num(c.ratings)} />
        <Stat label="Subscriptions" value={num(c.subscriptions)} />
        <Stat label="Playbooks" value={num(c.playbooks)} />
        <Stat label="New feedback" value={num(c.feedback_new)} tone={c.feedback_new > 0 ? 'warn' : undefined} />
      </div>

      <Panel title="Last run">
        {run ? (
          <div className="small">
            <div className="row wrap" style={{ gap: 8, marginBottom: 8 }}>
              <StatusBadge status={run.status} />
              <span className="dim">{run.trigger}</span>
              <span className="dim">{fmtDateTime(run.started_at)}</span>
            </div>
            <div className="tiny dim">
              {num(run.entities_ok)} ok, {num(run.entities_failed)} failed, {num(run.entities_skipped)} skipped
              {run.facts_written != null ? `, ${num(run.facts_written)} facts written` : ''}
              {run.finished_at ? ` Â· finished ${fmtDateTime(run.finished_at)}` : ' Â· still running'}
            </div>
          </div>
        ) : (
          <p className="small dim" style={{ margin: 0 }}>
            No run has been recorded yet. Run npm run pipeline locally to start one.
          </p>
        )}
      </Panel>

      <Panel title="Needs attention">
        {nothingWrong ? (
          <p className="small dim" style={{ margin: 0 }}>
            Nothing needs attention. Every active country has run, no links are dead, and there is no
            unread feedback.
          </p>
        ) : (
          <ul className="portal-list">
            {attentionItems.map((line, i) => (
              <li key={i} className="small">
                {line}
              </li>
            ))}
            {a.countries_with_errors.map((e) => (
              <li key={e.slug} className="small">
                {e.name} last failed with: {e.last_error}. Fix the source or deactivate the country.
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Link health">
        <div className="row wrap" style={{ gap: 14 }}>
          <span className="small"><span className="dot ok" /> {num(lh.ok)} reachable</span>
          <span className="small"><span className="dot gated" /> {num(lh.gated)} gated</span>
          <span className="small"><span className="dot dead" /> {num(lh.dead)} dead</span>
          <span className="small"><span className="dot unknown" /> {num(lh.unknown)} unchecked</span>
        </div>
      </Panel>
    </>
  );
}

/* ---- Registry (full port of the old admin table) ---- */

type RegistryFilter = 'all' | 'country' | 'intl_org' | 'regional_body' | 'active';

function Registry({ t, onError }: { t: Toaster; onError: OnError }) {
  const [entities, setEntities] = useState<EntityWithSources[]>([]);
  const [filter, setFilter] = useState<RegistryFilter>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.admin.list();
      setEntities(r.entities);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(slug: string, next: boolean) {
    setEntities((prev) => prev.map((e) => (e.slug === slug ? { ...e, is_active: next ? 1 : 0 } : e)));
    try {
      await api.admin.setActive(slug, next);
      t.ok(`${slug} ${next ? 'activated' : 'deactivated'}`);
    } catch (e) {
      setEntities((prev) => prev.map((x) => (x.slug === slug ? { ...x, is_active: next ? 0 : 1 } : x)));
      onError(e);
    }
  }

  async function bulk(next: boolean) {
    const slugs = filtered.map((e) => e.slug);
    if (!slugs.length) return;
    setBusy('bulk');
    try {
      const r = await api.admin.bulkActive(slugs, next);
      t.ok(`${r.updated} record${r.updated === 1 ? '' : 's'} ${next ? 'activated' : 'deactivated'}`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  }

  // Rebuilds subscriber feeds from stored signals only. Fetching and analysis
  // run on the operator machine via npm run pipeline, because one country now
  // costs well over a hundred source calls and a Worker cannot make that many
  // in a single invocation.
  async function rebuildFeeds() {
    setBusy('run');
    try {
      const r = await api.admin.rebuildFeeds();
      t.ok(
        r.feedError
          ? `Feed rebuild failed: ${r.feedError}`
          : `Feeds rebuilt for ${r.feed?.subscribers ?? 0} subscriber(s), ${r.feed?.items_written ?? 0} new item(s)`,
      );
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  }

  async function checkLinks() {
    setBusy('links');
    try {
      const r = await api.admin.checkLinks();
      t.ok(`Checked ${r.checked}: ${r.ok} healthy, ${r.gated} gated, ${r.broken} broken`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  }

  async function remove(slug: string, name: string) {
    if (!window.confirm(`Delete ${name}? This removes the record and its sources.`)) return;
    setBusy('del');
    try {
      await api.admin.remove(slug);
      t.ok(`${name} deleted`);
      setEntities((prev) => prev.filter((e) => e.slug !== slug));
    } catch (e) {
      onError(e);
    } finally {
      setBusy('');
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entities.filter(
      (e) =>
        (filter === 'all' || (filter === 'active' ? e.is_active === 1 : e.kind === filter)) &&
        (!needle ||
          e.name.toLowerCase().includes(needle) ||
          (e.iso3 ?? '').toLowerCase().includes(needle)),
    );
  }, [entities, filter, q]);

  const activeCount = entities.filter((e) => e.is_active).length;

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small dim">
          {entities.length} records Â· {activeCount} active
        </span>
        <Link className="btn primary sm" to="/admin/new">
          + New record
        </Link>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button
          className="btn sm"
          onClick={rebuildFeeds}
          disabled={busy !== ''}
          style={{ flex: 1 }}
          title="Rebuilds subscriber feeds from the stored analysis. Run the local pipeline to refresh the figures."
        >
          {busy === 'run' ? 'Rebuilding...' : 'Rebuild feeds'}
        </button>
        <button className="btn sm" onClick={checkLinks} disabled={busy !== ''} style={{ flex: 1 }}>
          {busy === 'links' ? 'Checking...' : 'Check links'}
        </button>
      </div>

      <input
        type="search"
        placeholder="Search records"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      <Chips
        options={[
          { value: 'all' as RegistryFilter, label: 'All' },
          { value: 'active' as RegistryFilter, label: `Active (${activeCount})` },
          { value: 'country' as RegistryFilter, label: 'Countries' },
          { value: 'intl_org' as RegistryFilter, label: 'International' },
          { value: 'regional_body' as RegistryFilter, label: 'Regional' },
        ]}
        value={filter}
        onChange={setFilter}
      />

      <div className="row" style={{ gap: 8, margin: '12px 0' }}>
        <button className="btn ghost sm" onClick={() => bulk(true)} disabled={busy !== ''}>
          Tick all shown
        </button>
        <button className="btn ghost sm" onClick={() => bulk(false)} disabled={busy !== ''}>
          Untick all shown
        </button>
      </div>

      {loading ? (
        <Skeletons n={6} />
      ) : filtered.length === 0 ? (
        <Empty title="No records match" />
      ) : (
        filtered.map((e) => {
          const links = e.sources.export.length + e.sources.import.length + e.sources.commerce.length;
          const broken = (['export', 'import', 'commerce'] as const)
            .flatMap((cat) => e.sources[cat])
            .filter((s) => linkHealth(s.last_status, s.fmt) === 'dead').length;
          return (
            <div className="admin-row" key={e.slug}>
              <Toggle checked={e.is_active === 1} onChange={(v) => toggle(e.slug, v)} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{e.name}</div>
                <div className="tiny dim">
                  {KIND_LABEL[e.kind]}
                  {e.iso3 ? ` Â· ${e.iso3}` : ''} Â· {links} links
                  {broken > 0 && <span className="down"> Â· {broken} broken</span>}
                  {e.last_error && <span className="down"> Â· error</span>}
                  {e.last_ingest_at && ` Â· ${e.last_ingest_at.slice(0, 10)}`}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                <Link className="btn ghost sm" to={`/admin/edit/${e.slug}`}>
                  Edit
                </Link>
                <button
                  className="btn ghost sm danger"
                  onClick={() => remove(e.slug, e.name)}
                  disabled={busy !== ''}
                >
                  Delete
                </button>
              </div>
            </div>
          );
        })
      )}

      <p className="tiny dim" style={{ marginTop: 18 }}>
        Ticking a country puts it in the pipeline: its data is fetched, cross-referenced with the
        international and regional bodies, analysed, and published to its dashboard.
      </p>
      <p className="tiny dim">
        The scheduled run happens on your own machine, not in the cloud, and publishes finished
        analysis here. Rebuild feeds only fans subscriber feeds out from analysis that already
        exists.
      </p>
    </>
  );
}

/* ---- Pipeline ---- */

function Pipeline({ onError }: { onError: OnError }) {
  const [runs, setRuns] = useState<PortalRun[]>([]);
  const [countries, setCountries] = useState<PortalCountryRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .pipeline()
      .then((r) => {
        setRuns(r.runs);
        setCountries(r.countries);
      })
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Problems first: errors, then active countries that have never ingested,
  // then everything else by name.
  const sorted = useMemo(() => {
    const rank = (c: PortalCountryRow) => {
      if (c.last_error) return 0;
      if (c.is_active === 1 && !c.last_ingest_at) return 1;
      return 2;
    };
    return [...countries].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [countries]);

  if (loading) return <Skeletons n={5} />;

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Ingest runs on your own machine via npm run pipeline. The Rebuild feeds button in Registry
        only fans subscriber feeds out from analysis that already exists, it does not refetch source
        data.
      </p>

      <Panel title="Recent runs">
        {runs.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No runs recorded yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Trigger</th>
                  <th>Status</th>
                  <th className="align-right">Ok</th>
                  <th className="align-right">Failed</th>
                  <th className="align-right">Skipped</th>
                  <th className="align-right">Facts</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td>{fmtDateTime(r.started_at)}</td>
                    <td>{r.trigger}</td>
                    <td><StatusBadge status={r.status} /></td>
                    <td className="align-right">{num(r.entities_ok)}</td>
                    <td className="align-right">{num(r.entities_failed)}</td>
                    <td className="align-right">{num(r.entities_skipped)}</td>
                    <td className="align-right">{r.facts_written == null ? 'â€”' : num(r.facts_written)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title={`Countries (${countries.length})`}>
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Country</th>
                <th>Active</th>
                <th>Last ingest</th>
                <th className="align-right">Coverage</th>
                <th className="align-right">Facts</th>
                <th className="align-right">Signals</th>
                <th>Error</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => (
                <tr key={c.slug}>
                  <td>{c.name}{c.iso3 ? ` (${c.iso3})` : ''}</td>
                  <td>
                    <span className={`badge ${c.is_active ? 'on' : 'off'}`}>
                      {c.is_active ? 'On' : 'Off'}
                    </span>
                  </td>
                  <td>{fmtDate(c.last_ingest_at)}</td>
                  <td className="align-right">{c.coverage_score == null ? 'â€”' : c.coverage_score.toFixed(0)}</td>
                  <td className="align-right">{num(c.facts)}</td>
                  <td className="align-right">{num(c.signals)}</td>
                  <td className="down tiny">{c.last_error ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Panel>
    </>
  );
}

/* ---- Sources ---- */

function Sources({ t, onError }: { t: Toaster; onError: OnError }) {
  const [health, setHealth] = useState<'all' | SourceHealth>('all');
  const [sources, setSources] = useState<PortalSource[]>([]);
  const [count, setCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.portal.sources(health === 'all' ? undefined : health);
      setSources(r.sources);
      setCount(r.count);
    } catch (e) {
      onError(e);
    } finally {
      setLoading(false);
    }
  }, [health, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  async function checkLinks() {
    setBusy(true);
    try {
      const r = await api.admin.checkLinks();
      t.ok(`Checked ${r.checked}: ${r.ok} healthy, ${r.gated} gated, ${r.broken} broken`);
      await load();
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small dim">{num(count)} links</span>
        <button className="btn sm" onClick={checkLinks} disabled={busy}>
          {busy ? 'Checking...' : 'Check links'}
        </button>
      </div>

      <Chips
        options={[
          { value: 'all' as const, label: 'All' },
          { value: 'ok' as const, label: 'Reachable' },
          { value: 'gated' as const, label: 'Gated' },
          { value: 'dead' as const, label: 'Dead' },
          { value: 'unknown' as const, label: 'Unchecked' },
        ]}
        value={health}
        onChange={setHealth}
      />
      <div style={{ height: 12 }} />

      {loading ? (
        <Skeletons n={6} />
      ) : sources.length === 0 ? (
        <Empty title="No links match this filter" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Health</th>
                <th>Entity</th>
                <th>Link</th>
                <th>Format</th>
                <th className="align-right">Status</th>
                <th>Checked</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => {
                const h = linkHealth(s.last_status, s.fmt as SourceFmt);
                return (
                  <tr key={s.id}>
                    <td><span className={`dot ${h}`} /></td>
                    <td>{s.entity_name}</td>
                    <td style={{ maxWidth: 280 }}>
                      <a className="src-link" href={s.url} target="_blank" rel="noreferrer">
                        {s.label || s.url}
                      </a>
                      {s.tls_warning ? <span className="badge watch" style={{ marginLeft: 6 }}>TLS warning</span> : null}
                    </td>
                    <td>{s.fmt}</td>
                    <td className="align-right">{s.last_status ?? 'â€”'}</td>
                    <td>{fmtDate(s.last_checked_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---- Products (full port of classifications) ---- */

const SOURCE_LABEL: Record<ResolvedClassification['source'], string> = {
  default: 'Universal default',
  heuristic: "This country's dominant export",
  override: 'Admin override',
};

function Products({ t, onError }: { t: Toaster; onError: OnError }) {
  const [countries, setCountries] = useState<Entity[]>([]);
  const [entitySlug, setEntitySlug] = useState('*');
  const [rows, setRows] = useState<ResolvedClassification[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState('');
  const [editing, setEditing] = useState<ResolvedClassification | null>(null);

  useEffect(() => {
    api.admin
      .list({ kind: 'country' })
      .then((r) => setCountries(r.entities))
      .catch(onError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setLoading(true);
    api.admin
      .classifications(entitySlug)
      .then((r) => setRows(r.rows))
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entitySlug]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return rows;
    return rows.filter((r) => r.label.toLowerCase().includes(needle) || r.hs_code.includes(needle));
  }, [rows, q]);

  async function save(hsCode: string, category: ExportCategory, note: string, sourceUrl: string) {
    try {
      await api.admin.setClassification({
        entity: entitySlug,
        hs_code: hsCode,
        category,
        note: note.trim() || null,
        source_url: sourceUrl.trim() || null,
      });
      t.ok(`HS ${hsCode} saved`);
      setEditing(null);
      const r = await api.admin.classifications(entitySlug);
      setRows(r.rows);
    } catch (e) {
      onError(e);
    }
  }

  async function revert(hsCode: string) {
    try {
      await api.admin.clearClassification(entitySlug, hsCode);
      t.ok(`HS ${hsCode} reverted to default`);
      const r = await api.admin.classifications(entitySlug);
      setRows(r.rows);
    } catch (e) {
      onError(e);
    }
  }

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Traditional exports are capital-intensive, licensed, or state and oligopoly controlled, so
        they are realistically closed to a new small exporter (oil, mining, precious metals, and per
        country a dominant legacy commodity). Everything else is a Non-Traditional Export (NTE), the
        same distinction real export-promotion agencies use. Choose{' '}
        <strong>Universal default</strong> to edit the rule that applies to every country, or a
        specific country to curate a sourced override for it.
      </p>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <select value={entitySlug} onChange={(e) => setEntitySlug(e.target.value)} style={{ flex: 1 }}>
          <option value="*">Universal default (every country)</option>
          {countries.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
            </option>
          ))}
        </select>
      </div>

      <input
        type="search"
        placeholder="Search a product name or HS chapter"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {loading ? (
        <Skeletons n={6} />
      ) : filtered.length === 0 ? (
        <Empty title="No chapters match" />
      ) : (
        filtered.map((r) => (
          <div className="list-item" key={r.hs_code} style={{ display: 'block', cursor: 'default' }}>
            <div className="row between">
              <span className="grow">
                <span className="name">
                  HS {r.hs_code} Â· {r.label}
                </span>
                <span className="tiny dim">{SOURCE_LABEL[r.source]}</span>
              </span>
              <span className={`badge ${r.category === 'traditional' ? 'watch' : 'on'}`}>
                {EXPORT_CATEGORY_LABEL[r.category]}
              </span>
            </div>

            {editing?.hs_code === r.hs_code ? (
              <ClassificationForm
                row={r}
                onCancel={() => setEditing(null)}
                onSave={(category, note, sourceUrl) => save(r.hs_code, category, note, sourceUrl)}
              />
            ) : (
              <div className="row" style={{ gap: 8, marginTop: 8 }}>
                <button className="btn ghost sm" onClick={() => setEditing(r)}>
                  {entitySlug === '*' ? 'Edit default' : 'Override for this country'}
                </button>
                {entitySlug !== '*' && r.override && (
                  <button className="btn ghost sm" onClick={() => revert(r.hs_code)}>
                    Revert to default
                  </button>
                )}
              </div>
            )}
          </div>
        ))
      )}
    </>
  );
}

function ClassificationForm({
  row,
  onSave,
  onCancel,
}: {
  row: ResolvedClassification;
  onSave: (category: ExportCategory, note: string, sourceUrl: string) => void;
  onCancel: () => void;
}) {
  const [category, setCategory] = useState<ExportCategory>(row.category);
  const [note, setNote] = useState(row.override?.note ?? '');
  const [sourceUrl, setSourceUrl] = useState(row.override?.source_url ?? '');

  return (
    <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--line-soft)' }}>
      <div className="field">
        <label>Category</label>
        <select value={category} onChange={(e) => setCategory(e.target.value as ExportCategory)}>
          <option value="non_traditional">Non-traditional export</option>
          <option value="traditional">Traditional export</option>
        </select>
      </div>
      <div className="field">
        <label>Note (why)</label>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. GEPA's published NTE list" />
      </div>
      <div className="field">
        <label>Source URL</label>
        <input value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} placeholder="https://..." />
      </div>
      <div className="row" style={{ gap: 8 }}>
        <button className="btn primary sm" onClick={() => onSave(category, note, sourceUrl)}>
          Save
        </button>
        <button className="btn ghost sm" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/* ---- Users ---- */

function Users({ onError }: { onError: OnError }) {
  const [q, setQ] = useState('');
  const [users, setUsers] = useState<PortalUser[]>([]);
  const [byTier, setByTier] = useState<{ tier: string; n: number }[]>([]);
  const [signups, setSignups] = useState<{ day: string; n: number }[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = setTimeout(() => {
      setLoading(true);
      api.portal
        .users(q.trim() || undefined)
        .then((r) => {
          setUsers(r.users);
          setByTier(r.by_tier);
          setSignups(r.signups_by_day);
        })
        .catch(onError)
        .finally(() => setLoading(false));
    }, 250);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  const chart = useMemo(
    () => signups.map((s) => ({ day: s.day.slice(5), n: s.n })),
    [signups],
  );

  return (
    <>
      <div className="portal-tiles">
        {byTier.length === 0 ? (
          <Stat label="Accounts" value="0" />
        ) : (
          byTier.map((row) => (
            <Stat key={row.tier} label={row.tier} value={num(row.n)} tone={row.tier === 'premium' ? 'gold' : undefined} />
          ))
        )}
      </div>

      <Panel title="Signups, last 30 days">
        {chart.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No signups in the last 30 days.
          </p>
        ) : (
          <div style={{ width: '100%', height: 180 }}>
            <ResponsiveContainer>
              <BarChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                <XAxis dataKey="day" tick={{ fontSize: 10 }} interval="preserveStartEnd" />
                <YAxis allowDecimals={false} tick={{ fontSize: 10 }} />
                <Tooltip />
                <Bar dataKey="n" fill="var(--brand)" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
      </Panel>

      <input
        type="search"
        placeholder="Search by email or name"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        style={{ marginBottom: 12 }}
      />

      {loading ? (
        <Skeletons n={6} />
      ) : users.length === 0 ? (
        <Empty title="No accounts match" />
      ) : (
        <div className="table-wrap">
          <table className="data-table">
            <thead>
              <tr>
                <th>Email</th>
                <th>Name</th>
                <th>Tier</th>
                <th>Country</th>
                <th className="align-right">Cards</th>
                <th className="align-right">Follows</th>
                <th>Joined</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id}>
                  <td>{u.email}{u.email_verified ? '' : ' (unverified)'}</td>
                  <td>{u.full_name ?? 'â€”'}</td>
                  <td>
                    <span className={`badge ${u.tier === 'premium' ? 'premium' : 'off'}`}>{u.tier}</span>
                  </td>
                  <td>{u.country_iso3 ?? 'â€”'}</td>
                  <td className="align-right">{num(u.cards)}</td>
                  <td className="align-right">{num(u.follows)}</td>
                  <td>{fmtDate(u.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/* ---- Network ---- */

function Network({ onError }: { onError: OnError }) {
  const [cards, setCards] = useState<PortalCard[]>([]);
  const [activity, setActivity] = useState<{ conversations: number; messages: number; messages_7d: number; ratings: number } | null>(null);
  const [ratings, setRatings] = useState<PortalRating[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .network()
      .then((r) => {
        setCards(r.cards);
        setActivity(r.activity);
        setRatings(r.recent_ratings);
      })
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <Skeletons n={5} />;

  return (
    <>
      {activity && (
        <div className="portal-tiles">
          <Stat label="Conversations" value={num(activity.conversations)} />
          <Stat label="Messages" value={num(activity.messages)} sub={`${num(activity.messages_7d)} in 7 days`} />
          <Stat label="Ratings" value={num(activity.ratings)} />
          <Stat label="Cards" value={num(cards.length)} />
        </div>
      )}

      <Panel title={`Business cards (${cards.length})`}>
        {cards.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No business cards have been created yet.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Company</th>
                  <th>Country</th>
                  <th>State</th>
                  <th className="align-right">Rating</th>
                  <th>Owner</th>
                </tr>
              </thead>
              <tbody>
                {cards.map((c) => (
                  <tr key={c.id}>
                    <td>{c.display_name}</td>
                    <td>{c.company ?? 'â€”'}</td>
                    <td>{c.country_iso3 ?? 'â€”'}</td>
                    <td>
                      <span className={`badge ${c.is_published ? 'on' : 'off'}`}>
                        {c.is_published ? 'Published' : 'Draft'}
                      </span>
                      {c.is_verified ? <span className="badge strong" style={{ marginLeft: 4 }}>Verified</span> : null}
                    </td>
                    <td className="align-right">
                      {c.rating_count > 0 ? `${(c.rating_avg ?? 0).toFixed(1)} (${c.rating_count})` : 'â€”'}
                    </td>
                    <td className="tiny dim">{c.owner_email ?? c.owner_name ?? 'â€”'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <Panel title="Recent ratings">
        {ratings.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No ratings have been left yet.
          </p>
        ) : (
          ratings.map((r) => (
            <div className="list-item" key={r.id} style={{ display: 'block', cursor: 'default' }}>
              <div className="row between">
                <span className="name">
                  {'â˜…'.repeat(Math.max(0, Math.min(5, r.score)))}
                  {'â˜†'.repeat(Math.max(0, 5 - r.score))}
                </span>
                <span className="tiny dim">{fmtDate(r.created_at)}</span>
              </div>
              {r.comment && <p className="small" style={{ margin: '6px 0 0' }}>{r.comment}</p>}
              <p className="tiny dim" style={{ margin: '6px 0 0' }}>
                {r.rater_name ?? 'Someone'} rated {r.rated_name ?? r.rated_headline ?? 'a card'}
                {r.dealt_in ? ` Â· dealt in ${r.dealt_in}` : ''}
              </p>
            </div>
          ))
        )}
      </Panel>
    </>
  );
}

/* ---- Premium ---- */

function Premium({ onError }: { onError: OnError }) {
  const [byKind, setByKind] = useState<{ kind: string; n: number }[]>([]);
  const [topFollowed, setTopFollowed] = useState<{ kind: string; value: string; label: string | null; followers: number }[]>([]);
  const [feed, setFeed] = useState<{ items: number; unread: number; premium_items: number } | null>(null);
  const [billing, setBilling] = useState<PortalBillingEvent[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .premium()
      .then((r) => {
        setByKind(r.by_kind);
        setTopFollowed(r.top_followed);
        setFeed(r.feed);
        setBilling(r.billing);
      })
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <Skeletons n={5} />;

  return (
    <>
      {feed && (
        <div className="portal-tiles">
          <Stat label="Feed items" value={num(feed.items)} />
          <Stat label="Unread" value={num(feed.unread)} />
          <Stat label="Premium items" value={num(feed.premium_items)} tone="gold" />
        </div>
      )}

      <Panel title="Follows by kind">
        {byKind.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            Nobody is following anything yet.
          </p>
        ) : (
          <div className="row wrap" style={{ gap: 14 }}>
            {byKind.map((k) => (
              <span key={k.kind} className="small">
                <strong>{num(k.n)}</strong> <span className="dim">{k.kind}</span>
              </span>
            ))}
          </div>
        )}
      </Panel>

      <Panel title="Most followed">
        {topFollowed.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No follows recorded yet.
          </p>
        ) : (
          topFollowed.map((f, i) => (
            <div className="row between list-item" key={`${f.kind}-${f.value}-${i}`} style={{ cursor: 'default' }}>
              <span className="grow">
                <span className="name">{f.label || f.value}</span>
                <span className="tiny dim">{f.kind}</span>
              </span>
              <span className="small">{num(f.followers)} following</span>
            </div>
          ))
        )}
      </Panel>

      <Panel title="Billing events">
        {billing.length === 0 ? (
          <p className="small dim" style={{ margin: 0 }}>
            No payment provider is configured yet, so there are no billing events to show.
          </p>
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>When</th>
                  <th>Kind</th>
                  <th>Provider</th>
                  <th>Plan</th>
                  <th className="align-right">Amount</th>
                  <th>User</th>
                </tr>
              </thead>
              <tbody>
                {billing.map((b) => (
                  <tr key={b.id}>
                    <td>{fmtDate(b.created_at)}</td>
                    <td>{b.kind}</td>
                    <td>{b.provider ?? 'â€”'}</td>
                    <td>{b.plan ?? 'â€”'}</td>
                    <td className="align-right">
                      {b.amount_minor == null ? 'â€”' : `${(b.amount_minor / 100).toFixed(2)} ${b.currency ?? ''}`}
                    </td>
                    <td className="tiny dim">{b.user_email ?? 'â€”'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}

/* ---- Content ---- */

function Content({ onError }: { onError: OnError }) {
  const [playbooks, setPlaybooks] = useState<PortalPlaybook[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .content()
      .then((r) => setPlaybooks(r.playbooks))
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <Skeletons n={5} />;
  if (playbooks.length === 0)
    return <Empty title="No playbooks yet" hint="Published how-to-start guides will appear here." />;

  return (
    <Panel title={`Playbooks (${playbooks.length})`}>
      <div className="table-wrap">
        <table className="data-table">
          <thead>
            <tr>
              <th>Title</th>
              <th>Sector</th>
              <th>Country</th>
              <th>Access</th>
              <th className="align-right">Minutes</th>
              <th>Published</th>
            </tr>
          </thead>
          <tbody>
            {playbooks.map((p) => (
              <tr key={p.slug}>
                <td>{p.title}</td>
                <td>{p.sector ?? 'â€”'}</td>
                <td>{p.country_iso3 ?? 'â€”'}</td>
                <td>
                  <span className={`badge ${p.premium_only ? 'premium' : 'on'}`}>
                    {p.premium_only ? 'Premium' : 'Free'}
                  </span>
                </td>
                <td className="align-right">{p.reading_minutes ?? 'â€”'}</td>
                <td>{fmtDate(p.published_at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}

/* ---- Feedback (full port) ---- */

type FeedbackRow = Awaited<ReturnType<typeof api.admin.feedback>>['feedback'][number];
type FeedbackFilter = 'new' | 'read' | 'done' | 'all';

function Feedback({ t, onError }: { t: Toaster; onError: OnError }) {
  const [rows, setRows] = useState<FeedbackRow[]>([]);
  const [filter, setFilter] = useState<FeedbackFilter>('new');
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    api.admin
      .feedback(filter === 'all' ? undefined : filter)
      .then((r) => setRows(r.feedback))
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function setStatus(id: string, status: 'new' | 'read' | 'done') {
    try {
      await api.admin.setFeedbackStatus(id, status);
      t.ok('Feedback updated');
      // Drop it from the list when it no longer matches the active filter, so
      // the visible rows never contradict the heading.
      setRows((prev) =>
        filter === 'all' ? prev.map((r) => (r.id === id ? { ...r, status } : r)) : prev.filter((r) => r.id !== id),
      );
    } catch (e) {
      onError(e);
    }
  }

  return (
    <>
      <p className="small muted" style={{ marginTop: 0 }}>
        Sent from the button in the corner of the app. Anyone can send, signed in or not.
      </p>

      <Chips
        options={[
          { value: 'new' as FeedbackFilter, label: 'New' },
          { value: 'read' as FeedbackFilter, label: 'Read' },
          { value: 'done' as FeedbackFilter, label: 'Done' },
          { value: 'all' as FeedbackFilter, label: 'All' },
        ]}
        value={filter}
        onChange={setFilter}
      />
      <div style={{ height: 14 }} />

      {loading ? (
        <Skeletons n={4} />
      ) : rows.length === 0 ? (
        <Empty
          title={filter === 'new' ? 'Nothing new' : 'Nothing here'}
          hint="Messages sent through the feedback button show up here."
        />
      ) : (
        rows.map((r) => (
          <div className="card" key={r.id}>
            <div className="row between" style={{ gap: 10, marginBottom: 8 }}>
              <span className="badge watch">
                {FEEDBACK_KIND_LABEL[r.kind as FeedbackKind] ?? r.kind}
              </span>
              <span className="tiny dim">{r.created_at?.slice(0, 16).replace('T', ' ')}</span>
            </div>

            <p style={{ margin: '0 0 10px', fontSize: 14.5, lineHeight: 1.55, whiteSpace: 'pre-wrap' }}>
              {r.message}
            </p>

            <p className="tiny dim" style={{ margin: '0 0 12px' }}>
              {r.user_name || r.user_email ? (
                <>
                  {r.user_name ?? 'Account'}
                  {r.user_email ? ` (${r.user_email})` : ''}
                </>
              ) : r.contact ? (
                <>Not signed in, left {r.contact}</>
              ) : (
                'Not signed in, no reply address'
              )}
              {r.path ? ` Â· from ${r.path}` : ''}
            </p>

            <div className="row" style={{ gap: 6 }}>
              {r.status !== 'read' && (
                <button className="btn ghost sm" type="button" onClick={() => setStatus(r.id, 'read')}>
                  Mark read
                </button>
              )}
              {r.status !== 'done' && (
                <button className="btn sm" type="button" onClick={() => setStatus(r.id, 'done')}>
                  Close
                </button>
              )}
              {r.status !== 'new' && (
                <button className="btn ghost sm" type="button" onClick={() => setStatus(r.id, 'new')}>
                  Reopen
                </button>
              )}
            </div>
          </div>
        ))
      )}
    </>
  );
}

/* ---- Setup ---- */

function Setup({ onError }: { onError: OnError }) {
  const [data, setData] = useState<PortalSetup | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api.portal
      .setup()
      .then(setData)
      .catch(onError)
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <Skeletons n={5} />;
  if (!data) return <Empty title="Setup unavailable" hint="The request did not return data." />;

  return (
    <>
      <Panel title="Configuration checklist">
        <p className="tiny dim" style={{ marginTop: 0 }}>
          Only whether each value is set is shown. Secret values are never sent to the browser.
        </p>
        {data.config.map((c) => (
          <div className="row between list-item" key={c.key} style={{ cursor: 'default' }}>
            <span className="grow">
              <span className="name">{c.key}</span>
              <span className="tiny dim">{c.why}</span>
            </span>
            <span className="row" style={{ gap: 6 }}>
              {c.required && !c.set && <span className="badge off">Required</span>}
              <span className={`badge ${c.set ? 'on' : 'watch'}`}>{c.set ? 'Set' : 'Not set'}</span>
            </span>
          </div>
        ))}
      </Panel>

      <Panel title="Database">
        <div className="row wrap" style={{ gap: 14 }}>
          <span className="small"><strong>{num(data.db.facts)}</strong> <span className="dim">facts</span></span>
          <span className="small"><strong>{num(data.db.results)}</strong> <span className="dim">results</span></span>
          <span className="small"><strong>{num(data.db.migrations)}</strong> <span className="dim">migrations</span></span>
        </div>
      </Panel>

      {data.notes.length > 0 && (
        <Panel title="Notes">
          <ul className="portal-list">
            {data.notes.map((n, i) => (
              <li key={i} className="small">
                {n}
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
