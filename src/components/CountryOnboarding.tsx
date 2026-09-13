/**
 * Onboarding a country, and running it.
 *
 * Three steps, and the boundaries between them are the point:
 *
 *   DISCOVER   paste an endpoint, read its metadata, propose a config.
 *   CONFIRM    an admin checks every guess against the raw source values and
 *              corrects what is wrong. Nothing is saved until this happens.
 *   RUN        one button, a real progress bar, and a result summary.
 *
 * The confirm step exists because a guess reaching a live request is how a
 * dataset ends up quietly wrong. A dimension mapped to the wrong column does
 * not error: it returns numbers, in the right shape, describing something else.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../lib/api';
import { Empty, Skeletons } from './ui';
import type {
  DimensionGuess,
  DiscoveryResult,
  DominanceCandidate,
  EntityWithSources,
  RunProgress,
} from '../../shared/types';

type Toaster = { ok: (m: string) => void; err: (m: string) => void };
type OnError = (e: unknown) => void;

const CERTAINTY_LABEL: Record<string, string> = {
  certain: 'Read from the metadata',
  likely: 'Inferred',
  uncertain: 'Needs a decision',
};

export function CountryOnboarding({ t, onError }: { t: Toaster; onError: OnError }) {
  const [countries, setCountries] = useState<EntityWithSources[] | null>(null);
  const [slug, setSlug] = useState<string>('');

  useEffect(() => {
    api.admin
      .list({ kind: 'country' })
      .then((r) => {
        setCountries(r.entities);
        if (r.entities.length && !slug) setSlug(r.entities[0].slug);
      })
      .catch(onError);
    // Loaded once. Re-fetching on every slug change would reset the list under
    // the admin's cursor.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!countries) return <Skeletons n={3} />;
  if (!countries.length) {
    return <Empty title="No countries registered" hint="Add one in the registry first." />;
  }

  return (
    <>
      <div className="card">
        <p className="card-title">Country</p>
        <select value={slug} onChange={(e) => setSlug(e.target.value)}>
          {countries.map((c) => (
            <option key={c.slug} value={c.slug}>
              {c.name}
              {c.is_active ? '' : ' (not activated)'}
            </option>
          ))}
        </select>
      </div>

      {slug && <ConfigPanel slug={slug} t={t} onError={onError} />}
      {slug && <RunPanel slug={slug} country={countries.find((c) => c.slug === slug)} t={t} onError={onError} />}
      {slug && <ExclusionPanel slug={slug} t={t} onError={onError} />}
    </>
  );
}

// --- discover and confirm ----------------------------------------------------

function ConfigPanel({ slug, t, onError }: { slug: string; t: Toaster; onError: OnError }) {
  const [endpoint, setEndpoint] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DiscoveryResult | null>(null);
  const [saved, setSaved] = useState<{ endpoint?: string; confirmed_at?: string } | null>(null);
  /** Admin corrections, keyed by PXWeb variable code. */
  const [roles, setRoles] = useState<Record<string, string>>({});

  useEffect(() => {
    setResult(null);
    setRoles({});
    api.admin
      .getConfig(slug)
      .then((r) => {
        setSaved(r.config ? { endpoint: r.endpoint, confirmed_at: r.confirmed_at } : null);
        if (r.endpoint) setEndpoint(r.endpoint);
      })
      .catch(onError);
  }, [slug, onError]);

  async function discover() {
    setBusy(true);
    try {
      const r = await api.admin.discover(endpoint.trim());
      setResult(r);
      setRoles(Object.fromEntries(r.dimensions.map((d) => [d.code, d.role])));
      t.ok(`Read ${r.dimensions.length} dimensions.`);
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  async function confirm() {
    if (!result) return;
    setBusy(true);
    try {
      // Built from what is on screen, not from what discovery proposed, so a
      // correction the admin made is what gets saved.
      const dims: Record<string, string> = {};
      for (const [code, role] of Object.entries(roles)) {
        if (role !== 'unknown') dims[role] = code;
      }
      const pickFor = (role: string, key: string) =>
        result.dimensions.find((d) => roles[d.code] === role)?.picked.find((p) => p.key === key)
          ?.value ?? '';

      await api.admin.saveConfig(slug, {
        endpoint: result.endpoint,
        provider_type: 'pxweb',
        config: {
          code: slug.slice(0, 2).toUpperCase(),
          name: slug,
          provider: {
            type: 'pxweb',
            endpoint: result.endpoint,
            dimensions: dims,
            values: {
              value_usd: pickFor('valuation', 'value_usd'),
              weight_kg: pickFor('valuation', 'weight_kg'),
              flow_import: pickFor('flow', 'flow_import'),
              flow_export: pickFor('flow', 'flow_export'),
              all_months: pickFor('month', 'all_months'),
              all_products: pickFor('product', 'all_products'),
              all_partners: pickFor('partner', 'all_partners'),
              months: [],
            },
          },
          classification: { system: 'HS', level: result.classification_level },
          years: result.years,
          partners: result.partners.map((p) => ({
            app_name: p.app_name,
            source_name: p.source_name,
            iso3: p.iso3,
          })),
          filters: { excluded: [] },
        },
        discovery: result,
      });
      setSaved({ endpoint: result.endpoint, confirmed_at: new Date().toISOString() });
      t.ok('Config confirmed and saved.');
    } catch (e) {
      onError(e);
    } finally {
      setBusy(false);
    }
  }

  const blocking = result?.warnings.filter((w) => w.severity === 'blocking') ?? [];
  const checks = result?.warnings.filter((w) => w.severity === 'check') ?? [];

  return (
    <div className="card">
      <p className="card-title">Source configuration</p>
      <p className="tiny dim" style={{ margin: '0 0 10px' }}>
        Paste a PXWeb endpoint. Its metadata is read and every dimension proposed with the reason
        for the guess. Nothing is saved until you confirm: a dimension mapped to the wrong column
        does not error, it returns numbers describing something else.
      </p>

      {saved && (
        <p className="tiny dim" style={{ margin: '0 0 10px' }}>
          Confirmed {saved.confirmed_at ? new Date(saved.confirmed_at).toLocaleString() : ''} against{' '}
          <code>{saved.endpoint}</code>.
        </p>
      )}

      <div className="field">
        <label htmlFor="ep">Endpoint</label>
        <input
          id="ep"
          value={endpoint}
          onChange={(e) => setEndpoint(e.target.value)}
          placeholder="https://statsbank.example.gov/api/v1/en/Trade/trade.px"
        />
      </div>
      <button className="btn primary" onClick={discover} disabled={busy || !endpoint.trim()}>
        {busy ? 'Reading\u2026' : 'Read the metadata'}
      </button>

      {result && (
        <>
          <p className="overline" style={{ margin: '16px 0 6px' }}>
            {result.title || 'Dataset'}
          </p>

          {blocking.length > 0 && (
            <div className="callout warn">
              <strong>This endpoint cannot be used as it stands.</strong>
              <ul className="tiny" style={{ margin: '6px 0 0', paddingLeft: 18 }}>
                {blocking.map((w, i) => (
                  <li key={i}>{w.message}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="table-wrap" style={{ marginTop: 10 }}>
            <table className="data-table">
              <thead>
                <tr>
                  <th>Source dimension</th>
                  <th>What it looks like</th>
                  <th>Role</th>
                </tr>
              </thead>
              <tbody>
                {result.dimensions.map((d) => (
                  <DimensionRow
                    key={d.code}
                    d={d}
                    role={roles[d.code] ?? d.role}
                    onRole={(r) => setRoles((prev) => ({ ...prev, [d.code]: r }))}
                  />
                ))}
              </tbody>
            </table>
          </div>

          <p className="tiny dim" style={{ marginTop: 8 }}>
            {result.classification_reason}
          </p>
          <p className="tiny dim">
            {result.partners.length} partner
            {result.partners.length === 1 ? '' : 's'} matched to the country list
            {result.unmatched_partners.length > 0 && (
              <>
                {' '}
                &middot; {result.unmatched_partners.length} unmatched:{' '}
                {result.unmatched_partners.slice(0, 6).join(', ')}
                {result.unmatched_partners.length > 6 && ' and more'}. Their trade is excluded until
                they are mapped.
              </>
            )}
          </p>

          {checks.length > 0 && (
            <ul className="tiny dim" style={{ margin: '8px 0 0', paddingLeft: 18 }}>
              {checks.map((w, i) => (
                <li key={i}>{w.message}</li>
              ))}
            </ul>
          )}

          <button
            className="btn primary"
            style={{ marginTop: 12 }}
            onClick={confirm}
            disabled={busy || blocking.length > 0}
          >
            {busy ? 'Saving\u2026' : 'Confirm and save'}
          </button>
        </>
      )}
    </div>
  );
}

const ROLES = ['valuation', 'flow', 'year', 'month', 'product', 'partner', 'unknown'];

function DimensionRow({
  d,
  role,
  onRole,
}: {
  d: DimensionGuess;
  role: string;
  onRole: (r: string) => void;
}) {
  return (
    <tr>
      <td>
        <div style={{ fontWeight: 600 }}>{d.text}</div>
        <div className="tiny dim">
          {d.value_count} value{d.value_count === 1 ? '' : 's'}
        </div>
      </td>
      <td>
        {/* The raw values sit next to the guess on purpose: confirming a guess
            without seeing what it was made from is not confirmation. */}
        <div className="tiny">{d.sample_values.join(' \u00b7 ')}</div>
        <div className="tiny dim" style={{ marginTop: 2 }}>
          <span className={`badge ${d.certainty === 'certain' ? 'on' : d.certainty === 'likely' ? 'watch' : 'off'}`}>
            {CERTAINTY_LABEL[d.certainty] ?? d.certainty}
          </span>{' '}
          {d.reason}
        </div>
        {d.picked.length > 0 && (
          <ul className="tiny dim" style={{ margin: '4px 0 0', paddingLeft: 16 }}>
            {d.picked.map((p) => (
              <li key={p.key}>
                <strong>{p.value ?? 'nothing found'}</strong> &mdash; {p.reason}
              </li>
            ))}
          </ul>
        )}
      </td>
      <td>
        <select value={role} onChange={(e) => onRole(e.target.value)}>
          {ROLES.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </td>
    </tr>
  );
}

// --- run ---------------------------------------------------------------------

function RunPanel({
  slug,
  country,
  t,
  onError,
}: {
  slug: string;
  country: EntityWithSources | undefined;
  t: Toaster;
  onError: OnError;
}) {
  const [runs, setRuns] = useState<RunProgress[] | null>(null);
  const [watching, setWatching] = useState<RunProgress | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const code = country?.iso2 ?? 'GH';

  const load = useCallback(() => {
    api.admin
      .countryRuns(code)
      .then((r) => {
        setRuns(r.runs);
        // Pick up a run already going, so opening the page mid-run shows
        // progress rather than an idle button.
        const live = r.runs.find((x) => x.status === 'running');
        setWatching(live ?? null);
      })
      .catch(onError);
  }, [code, onError]);

  useEffect(() => {
    load();
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [load]);

  useEffect(() => {
    if (!watching || watching.is_finished) return;
    timer.current = setTimeout(async () => {
      try {
        const next = await api.admin.runProgress(watching.id);
        setWatching(next);
        if (next.is_finished) {
          t.ok(next.status === 'ok' ? 'Run finished.' : `Run ${next.status}.`);
          load();
        }
      } catch (e) {
        onError(e);
      }
    }, 2000);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [watching, load, t, onError]);

  const last = runs?.[0];

  return (
    <div className="card">
      <p className="card-title">Run analysis</p>
      <p className="tiny dim" style={{ margin: '0 0 10px' }}>
        Fetches whatever sources are configured for {country?.name ?? slug}, analyses them, and
        publishes the result. Ingestion runs on the operator's machine rather than in the Worker,
        because one full country is ninety-six sequential calls to somebody else's API.
      </p>

      {watching && !watching.is_finished ? (
        <ProgressBar run={watching} />
      ) : (
        <p className="tiny dim">
          Start a run from the command line with <code>npm run ghana</code>. Progress appears here
          while it goes.
        </p>
      )}

      {last && last.is_finished && <RunSummary run={last} />}

      {runs && runs.length === 0 && (
        <Empty title="No runs yet" hint="Nothing has been fetched for this country." />
      )}
    </div>
  );
}

function ProgressBar({ run }: { run: RunProgress }) {
  const pct = run.percent;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 4 }}>
        <span className="tiny">{run.current_step ?? 'Working'}</span>
        <span className="tiny dim">
          {/* Null percent means the source has no chapters to count, such as a
              single PDF. Shown as an absence rather than as a bar at zero,
              which would read as stalled. */}
          {pct != null
            ? `${run.chapters_done} of ${run.chapters_total} (${pct}%)`
            : 'in progress'}
        </span>
      </div>
      <div className="progress-track">
        <div
          className={`progress-fill${pct == null ? ' indeterminate' : ''}`}
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </div>
      {run.records_processed != null && run.records_processed > 0 && (
        <p className="tiny dim" style={{ marginTop: 6 }}>
          {run.records_processed.toLocaleString()} records so far.
        </p>
      )}
    </div>
  );
}

/**
 * What a finished run produced.
 *
 * Three numbers the table already tracks. Received, kept and rejected are one
 * sentence about a run, and showing only the first two is how a run that threw
 * away half its input looks like a success.
 */
function RunSummary({ run }: { run: RunProgress }) {
  const received = run.records_received ?? 0;
  const processed = run.records_processed ?? 0;
  const rejected = run.records_rejected ?? 0;

  return (
    <div style={{ marginTop: 12 }}>
      <p className="overline" style={{ margin: '0 0 8px' }}>
        Last run &middot; {new Date(run.started_at).toLocaleString()}
      </p>
      <div className="kpi-row">
        <Kpi n={received} label="Rows received" tone="neutral" />
        <Kpi n={processed} label="Stored" tone="good" />
        <Kpi n={rejected} label="Rejected" tone={rejected > 0 ? 'bad' : 'neutral'} />
      </div>
      {run.status !== 'ok' && (
        <div className="callout warn" style={{ marginTop: 10 }}>
          <strong>This run {run.status}.</strong>{' '}
          {run.error_message ?? 'No reason was recorded.'}
        </div>
      )}
      {rejected > 0 && run.status === 'ok' && (
        <p className="tiny dim" style={{ marginTop: 8 }}>
          Rejected rows were read but could not be trusted, usually a header, a total line, or a
          partner the source names differently. They are counted rather than hidden so a run that
          read a fifth of its input is visibly different from one that read all of it.
        </p>
      )}
    </div>
  );
}

function Kpi({ n, label, tone }: { n: number; label: string; tone: 'good' | 'bad' | 'warn' | 'neutral' }) {
  return (
    <div className={`kpi kpi-${tone}`}>
      <div className="kpi-number">{n.toLocaleString()}</div>
      <div className="kpi-label">{label}</div>
    </div>
  );
}

// --- exclusion checklist -----------------------------------------------------

function ExclusionPanel({ slug, t, onError }: { slug: string; t: Toaster; onError: OnError }) {
  const [threshold, setThreshold] = useState(12);
  const [data, setData] = useState<{ candidates: DominanceCandidate[]; products_considered: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Record<string, string>>({});

  const load = useCallback(
    (th: number) => {
      setBusy(true);
      api.admin
        .dominance(slug, th)
        .then((r) => setData(r))
        .catch(onError)
        .finally(() => setBusy(false));
    },
    [slug, onError],
  );

  useEffect(() => {
    setData(null);
    setPicked({});
  }, [slug]);

  return (
    <div className="card">
      <p className="card-title">Traditional trade</p>
      <p className="tiny dim" style={{ margin: '0 0 10px' }}>
        Nothing in trade data says "traditional export". What it can say is that one chapter is a
        large share of everything the country trades, which is the shape Ghana's cocoa, gold and oil
        all have. These are candidates, not decisions: excluding a country's largest trade
        automatically would remove the thing a reader most expects to see.
      </p>

      <div className="row" style={{ gap: 8, alignItems: 'flex-end' }}>
        <div className="field" style={{ flex: '0 0 140px', marginBottom: 0 }}>
          <label htmlFor="th">Threshold %</label>
          <input
            id="th"
            type="number"
            min={1}
            max={99}
            value={threshold}
            onChange={(e) => setThreshold(Number(e.target.value))}
          />
        </div>
        <button className="btn" onClick={() => load(threshold)} disabled={busy}>
          {busy ? 'Working\u2026' : 'Find candidates'}
        </button>
      </div>

      {data && data.candidates.length === 0 && (
        <p className="tiny dim" style={{ marginTop: 10 }}>
          No chapter reaches {threshold}% of {data.products_considered} products' total value. That
          is a finding: this country's trade is not dominated by one commodity at this threshold.
        </p>
      )}

      {data && data.candidates.length > 0 && (
        <div style={{ marginTop: 10, display: 'grid', gap: 6 }}>
          {data.candidates.map((c) => (
            <label key={c.product_code} className={`pick-row${picked[c.product_code] != null ? ' picked' : ''}`}>
              <input
                type="checkbox"
                checked={picked[c.product_code] != null}
                onChange={(e) =>
                  setPicked((prev) => {
                    const next = { ...prev };
                    if (e.target.checked) next[c.product_code] = '';
                    else delete next[c.product_code];
                    return next;
                  })
                }
              />
              <span style={{ flex: 1 }}>
                <span style={{ fontWeight: 600 }}>
                  HS {c.product_code} &middot; {c.share_pct.toFixed(1)}%
                </span>
                <span className="tiny dim" style={{ display: 'block' }}>
                  {c.product_description ?? 'No description'}
                </span>
                <span className="tiny dim" style={{ display: 'block', marginTop: 2 }}>
                  {c.already_excluded ? 'Already excluded. ' : ''}
                  {c.reason}
                </span>
                {picked[c.product_code] != null && (
                  // A reason is required rather than optional. An exclusion
                  // nobody can inspect is an exclusion nobody can correct, and
                  // this is the field that makes it inspectable.
                  <input
                    style={{ marginTop: 6 }}
                    placeholder="Why is this excluded? Shown wherever the exclusion appears."
                    value={picked[c.product_code]}
                    onChange={(e) =>
                      setPicked((prev) => ({ ...prev, [c.product_code]: e.target.value }))
                    }
                  />
                )}
              </span>
            </label>
          ))}

          <button
            className="btn primary"
            disabled={
              Object.keys(picked).length === 0 ||
              Object.values(picked).some((r) => !r.trim())
            }
            onClick={() => t.ok('Exclusions are saved with the config. Confirm the config above.')}
          >
            {Object.keys(picked).length === 0
              ? 'Tick the chapters to exclude'
              : Object.values(picked).some((r) => !r.trim())
                ? 'Every exclusion needs a reason'
                : `Exclude ${Object.keys(picked).length} chapter${Object.keys(picked).length === 1 ? '' : 's'}`}
          </button>
        </div>
      )}
    </div>
  );
}
