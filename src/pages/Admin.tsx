import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, getAdminToken, setAdminToken } from '../lib/api';
import { Chips, Empty, Skeletons, Toggle, useToast } from '../components/ui';
import { KIND_LABEL, linkHealth, type EntityWithSources } from '../../shared/types';

type Filter = 'all' | 'country' | 'intl_org' | 'regional_body' | 'active';

export default function Admin() {
  const [token, setToken] = useState(getAdminToken());
  const [authed, setAuthed] = useState(Boolean(getAdminToken()));
  const [entities, setEntities] = useState<EntityWithSources[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState('');
  const t = useToast();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await api.admin.list();
      setEntities(r.entities);
      setAuthed(true);
    } catch (e) {
      setAuthed(false);
      t.err((e as Error).message);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (getAdminToken()) void load();
  }, [load]);

  async function signIn() {
    setAdminToken(token.trim());
    await load();
  }

  async function toggle(slug: string, next: boolean) {
    setEntities((prev) =>
      prev.map((e) => (e.slug === slug ? { ...e, is_active: next ? 1 : 0 } : e)),
    );
    try {
      await api.admin.setActive(slug, next);
      t.ok(`${slug} ${next ? 'activated' : 'deactivated'}`);
    } catch (e) {
      setEntities((prev) =>
        prev.map((x) => (x.slug === slug ? { ...x, is_active: next ? 0 : 1 } : x)),
      );
      t.err((e as Error).message);
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
      t.err((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  async function runNow(slug?: string) {
    setBusy(slug ?? 'run');
    try {
      const r = await api.admin.runNow(slug);
      const failed = r.errors?.length
        ? ` — ${r.errors.map((x) => `${x.slug}: ${x.error}`).join('; ').slice(0, 160)}`
        : '';
      t.ok(`Run ${r.status}: ${r.entities_ok} ok, ${r.entities_failed} failed${failed}`);
      await load();
    } catch (e) {
      t.err((e as Error).message);
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
      t.err((e as Error).message);
    } finally {
      setBusy('');
    }
  }

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return entities.filter(
      (e) =>
        (filter === 'all' ||
          (filter === 'active' ? e.is_active === 1 : e.kind === filter)) &&
        (!needle ||
          e.name.toLowerCase().includes(needle) ||
          (e.iso3 ?? '').toLowerCase().includes(needle)),
    );
  }, [entities, filter, q]);

  const activeCount = entities.filter((e) => e.is_active).length;

  if (!authed) {
    return (
      <>
        {t.node}
        <div className="card">
          <p className="card-title">Admin sign in</p>
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

      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="small dim">
          {entities.length} records · {activeCount} active
        </span>
        <Link className="btn primary sm" to="/admin/new">
          + New record
        </Link>
      </div>

      <div className="row" style={{ gap: 8, marginBottom: 12 }}>
        <button
          className="btn sm"
          onClick={() => runNow()}
          disabled={busy !== ''}
          style={{ flex: 1 }}
        >
          {busy === 'run' ? 'Running…' : 'Run analysis'}
        </button>
        <button
          className="btn sm"
          onClick={checkLinks}
          disabled={busy !== ''}
          style={{ flex: 1 }}
        >
          {busy === 'links' ? 'Checking…' : 'Check links'}
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
          { value: 'all' as Filter, label: 'All' },
          { value: 'active' as Filter, label: `Active (${activeCount})` },
          { value: 'country' as Filter, label: 'Countries' },
          { value: 'intl_org' as Filter, label: 'International' },
          { value: 'regional_body' as Filter, label: 'Regional' },
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
          const links =
            e.sources.export.length + e.sources.import.length + e.sources.commerce.length;
          const broken = (['export', 'import', 'commerce'] as const)
            .flatMap((c) => e.sources[c])
            .filter((s) => linkHealth(s.last_status, s.fmt) === 'dead').length;
          return (
            <div className="admin-row" key={e.slug}>
              <Toggle checked={e.is_active === 1} onChange={(v) => toggle(e.slug, v)} />
              <div style={{ minWidth: 0 }}>
                <div className="name">{e.name}</div>
                <div className="tiny dim">
                  {KIND_LABEL[e.kind]}
                  {e.iso3 ? ` · ${e.iso3}` : ''} · {links} links
                  {broken > 0 && <span className="down"> · {broken} broken</span>}
                  {e.last_error && <span className="down"> · error</span>}
                  {e.last_ingest_at && ` · ${e.last_ingest_at.slice(0, 10)}`}
                </div>
              </div>
              <div className="row" style={{ gap: 6 }}>
                {e.kind === 'country' && e.iso3 && (
                  <button
                    className="btn ghost sm"
                    onClick={() => runNow(e.slug)}
                    disabled={busy !== ''}
                    title="Run analysis for this country now"
                  >
                    {busy === e.slug ? '…' : '▶'}
                  </button>
                )}
                <Link className="btn ghost sm" to={`/admin/edit/${e.slug}`}>
                  Edit
                </Link>
              </div>
            </div>
          );
        })
      )}

      <p className="tiny dim" style={{ marginTop: 18 }}>
        Ticking a country puts it in the weekly pipeline: its data is fetched, cross-referenced with
        the international and regional bodies, analysed, and published to its dashboard. The
        scheduled run is every Friday at 21:00 GMT.
      </p>
    </>
  );
}
