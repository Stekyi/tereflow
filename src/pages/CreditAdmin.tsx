import { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../lib/api';
import { Skeletons } from '../components/ui';
import type { CreditAdminOverview, CreditSectorMap, CreditSeriesMeta } from '../lib/credit-types';

interface Props { t: { ok: (m: string) => void; err: (m: string) => void }; onError: (e: unknown) => void }
type MapRow = CreditAdminOverview['sector_map'][number];

const when = (s: string | null) => (s ? s.slice(0, 16).replace('T', ' ') : 'never');

export function CreditAdmin({ t, onError }: Props) {
  const [ov, setOv] = useState<CreditAdminOverview | null>(null);
  const [filter, setFilter] = useState('');
  const [add, setAdd] = useState({ country_iso3: 'GHA', mnemonic: '', sector_key: '', sector_name: '', series_role: 'sector' });
  const [newCountry, setNewCountry] = useState({ country_iso3: '', preferred_source: 'auto' });
  const load = useCallback(() => { api.creditAdmin.overview().then(setOv).catch(onError); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  const series = useMemo(() => (ov?.series ?? []).filter((s) => !filter || s.country_iso3 === filter.toUpperCase()), [ov, filter]);
  if (!ov) return <Skeletons n={4} />;

  async function run(backfill: boolean) {
    try { const r = await api.creditAdmin.requestRun({ backfill }); t.ok(r.note ?? 'Requested'); load(); } catch (e) { onError(e); }
  }
  async function saveSeries(body: Record<string, unknown>) {
    try { const r = await api.creditAdmin.saveSeries(body); t.ok(r.note ?? 'Saved'); load(); } catch (e) { onError(e); }
  }
  async function saveCountry(body: { country_iso3: string; preferred_source?: string; is_active?: boolean }) {
    try { const r = await api.creditAdmin.saveCountry(body); t.ok(r.note ?? 'Saved'); load(); } catch (e) { onError(e); }
  }

  return (
    <>
      <p className="small dim" style={{ marginTop: 0 }}>
        Sectoral credit: where bank credit is outstanding by sector. The Bank of Ghana provides sector detail for Ghana; the IMF provides broad borrower sectors for other countries. Series, sources and the sector-to-trade map are managed here. Nothing is estimated and no AI is used.
      </p>

      <div className="card">
        <p className="card-title">Run the update</p>
        <p className="small dim" style={{ marginTop: 0 }}>
          Fetching and calculating cannot run inside the website (free plan limit), so a request is picked up by the pipeline: the daily schedule, or <code>pipeline.cmd credit</code> from the Pipeline kit on any PC that has the Oracle wallet.
          A normal update stores only what changed and records any revised values. A backfill also keeps a fresh raw copy of every response. Running again is always safe.
        </p>
        <div className="row" style={{ gap: 8 }}>
          <button className="btn" onClick={() => void run(false)}>Request update</button>
          <button className="btn ghost" onClick={() => void run(true)}>Request full backfill</button>
        </div>
        <div className="table-wrap" style={{ marginTop: 10 }}>
          <table className="data-table">
            <thead><tr><th>Requested</th><th>How</th><th>Status</th><th>Finished</th><th className="align-right">Series ok</th><th className="align-right">Failed</th><th className="align-right">New</th><th className="align-right">Revised</th><th>Detail</th></tr></thead>
            <tbody>
              {ov.runs.length === 0 && <tr><td colSpan={9} className="dim">No runs yet.</td></tr>}
              {ov.runs.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.requested_at ?? r.started_at)}</td><td>{r.trigger}{r.backfill ? ', backfill' : ''}</td>
                  <td><span className={`badge ${r.status === 'success' ? 'on' : r.status === 'requested' || r.status === 'running' ? 'notice' : r.status === 'partial' ? 'warning' : 'error'}`}>{r.status}</span></td>
                  <td>{when(r.finished_at)}</td><td className="align-right">{r.series_ok}</td><td className="align-right">{r.series_failed}</td><td className="align-right">{r.obs_new}</td><td className="align-right">{r.obs_revised}</td>
                  <td className="tiny">{r.detail ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Countries and which source is used</p>
        <p className="small dim" style={{ marginTop: 0 }}>
          A country with national sector data uses it for the industry view. Otherwise the IMF borrower sectors are used. If neither exists the country is marked unavailable. The two are never merged into one series.
        </p>
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Country</th><th>Status</th><th>In use</th><th>Prefer</th><th>On</th><th>Why</th></tr></thead>
            <tbody>
              {ov.countries.map((c) => (
                <tr key={c.country_iso3}>
                  <td><strong>{c.country_iso3}</strong></td>
                  <td>{c.status ?? 'not run yet'}</td><td>{c.in_use ?? 'none'}</td>
                  <td>
                    <select value={c.preferred_source} onChange={(e) => void saveCountry({ country_iso3: c.country_iso3, preferred_source: e.target.value, is_active: c.is_active === 1 })} aria-label={`Preferred source for ${c.country_iso3}`}>
                      <option value="auto">auto</option><option value="both">both</option><option value="national">national only</option><option value="imf">IMF only</option>
                    </select>
                  </td>
                  <td><input type="checkbox" checked={c.is_active === 1} onChange={(e) => void saveCountry({ country_iso3: c.country_iso3, preferred_source: c.preferred_source, is_active: e.target.checked })} aria-label={`${c.country_iso3} active`} /></td>
                  <td className="tiny">{c.status_note ?? ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="row" style={{ gap: 8, marginTop: 8, flexWrap: 'wrap' }}>
          <input placeholder="ISO3, e.g. UGA" value={newCountry.country_iso3} onChange={(e) => setNewCountry({ ...newCountry, country_iso3: e.target.value })} style={{ maxWidth: 140 }} />
          <select value={newCountry.preferred_source} onChange={(e) => setNewCountry({ ...newCountry, preferred_source: e.target.value })}><option value="auto">auto</option><option value="both">both</option><option value="national">national only</option><option value="imf">IMF only</option></select>
          <button className="btn" onClick={() => { void saveCountry(newCountry).then(() => setNewCountry({ country_iso3: '', preferred_source: 'auto' })); }}>Add country</button>
        </div>
      </div>

      <div className="card">
        <p className="card-title">Series</p>
        <p className="small dim" style={{ marginTop: 0 }}>
          IMF series are discovered by the pipeline from the IMF's own structure; they are never typed in. Bank of Ghana series are registered below by mnemonic. Setting the kind confirms it from the source's documentation and overrides the inferred value.
        </p>
        <input placeholder="Filter by country, e.g. GHA" value={filter} onChange={(e) => setFilter(e.target.value)} style={{ maxWidth: 220, marginBottom: 8 }} />
        <div className="table-wrap">
          <table className="data-table">
            <thead><tr><th>Country</th><th>Source</th><th>Sector</th><th>Mnemonic</th><th>Kind</th><th>On</th><th className="align-right">Obs</th><th>Latest</th><th>Fetched</th></tr></thead>
            <tbody>
              {series.map((s: CreditSeriesMeta) => (
                <tr key={s.id}>
                  <td>{s.country_iso3}</td><td>{s.source_key}</td><td>{s.sector_name}</td><td className="tiny"><code>{s.mnemonic}</code></td>
                  <td>
                    <select value={s.measure_kind} onChange={(e) => void saveSeries({ id: s.id, measure_kind: e.target.value })} aria-label={`Kind of ${s.sector_name}`}>
                      <option value="stock">stock</option><option value="flow">flow</option><option value="unverified">unverified</option>
                    </select>
                    <div className="tiny dim">{s.kind_basis === 'admin' ? 'confirmed' : s.kind_basis === 'source_definition' ? 'per source' : s.kind_basis ?? ''}</div>
                  </td>
                  <td><input type="checkbox" checked={s.is_active === 1} onChange={(e) => void saveSeries({ id: s.id, is_active: e.target.checked })} aria-label={`${s.sector_name} active`} /></td>
                  <td className="align-right">{s.obs_count}</td><td>{s.latest_obs ?? 'n/a'}</td>
                  <td className="tiny">{when(s.last_fetch_at)} {s.fetch_status && s.fetch_status !== 'ok' ? <span className="badge error" title={s.fetch_error ?? ''}>{s.fetch_status}</span> : null}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small" style={{ marginBottom: 4, marginTop: 12 }}><strong>Add a Bank of Ghana mnemonic</strong></p>
        <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
          <input placeholder="Country" value={add.country_iso3} onChange={(e) => setAdd({ ...add, country_iso3: e.target.value })} style={{ maxWidth: 90 }} />
          <input placeholder="Mnemonic, e.g. GHA_SAC_13" value={add.mnemonic} onChange={(e) => setAdd({ ...add, mnemonic: e.target.value })} style={{ maxWidth: 210 }} />
          <input placeholder="sector_key (lowercase)" value={add.sector_key} onChange={(e) => setAdd({ ...add, sector_key: e.target.value })} style={{ maxWidth: 190 }} />
          <input placeholder="Sector name" value={add.sector_name} onChange={(e) => setAdd({ ...add, sector_name: e.target.value })} style={{ maxWidth: 220 }} />
          <select value={add.series_role} onChange={(e) => setAdd({ ...add, series_role: e.target.value })}><option value="sector">sector</option><option value="total">total</option></select>
          <button className="btn" onClick={() => void saveSeries(add)}>Register</button>
        </div>
        <p className="tiny dim">After registering, request a full backfill. The unit and frequency are read from the source's response.</p>
      </div>

      <SpreadsheetCountry t={t} onError={onError} reload={load} />

      <SectorMap rows={ov.sector_map} onSave={async (b) => { try { await api.creditAdmin.saveMap(b); t.ok('Saved'); load(); } catch (e) { onError(e); } }} />
    </>
  );
}

function SectorMap({ rows, onSave }: { rows: MapRow[]; onSave: (b: Record<string, unknown>) => Promise<void> }) {
  const [draft, setDraft] = useState<Record<string, Partial<CreditSectorMap>>>({});
  const val = <K extends keyof CreditSectorMap>(r: MapRow, k: K): CreditSectorMap[K] => ((draft[r.sector_key]?.[k] ?? r[k]) as CreditSectorMap[K]);
  const set = (r: MapRow, patch: Partial<CreditSectorMap>) => setDraft((d) => ({ ...d, [r.sector_key]: { ...d[r.sector_key], ...patch } }));
  return (
    <div className="card">
      <p className="card-title">Sector to trade map</p>
      <p className="small dim" style={{ marginTop: 0 }}>
        Links a credit sector to the product groups in Tereflow's trade data, by HS code prefix (2 to 6 digits, comma separated). Only link what is defensible: names that look alike are not the same category. A sector with no link shows credit alone. "Direct" means the product group is the sector's own output; "indicative" means it is a related group.
      </p>
      <div className="table-wrap">
        <table className="data-table">
          <thead><tr><th>Sector</th><th>Scope</th><th>HS prefixes</th><th>Flow</th><th>Link</th><th>Note</th><th /></tr></thead>
          <tbody>
            {rows.map((r) => {
              const dirty = Boolean(draft[r.sector_key]);
              return (
                <tr key={r.sector_key}>
                  <td className="tiny"><code>{r.sector_key}</code></td>
                  <td><select value={val(r, 'trade_scope')} onChange={(e) => set(r, { trade_scope: e.target.value as CreditSectorMap['trade_scope'] })}><option value="hs">HS codes</option><option value="exports">all exports</option><option value="imports">all imports</option><option value="none">none</option></select></td>
                  <td><input value={val(r, 'hs_prefixes') ?? ''} onChange={(e) => set(r, { hs_prefixes: e.target.value })} disabled={val(r, 'trade_scope') !== 'hs'} style={{ minWidth: 160 }} /></td>
                  <td><select value={val(r, 'trade_flow')} onChange={(e) => set(r, { trade_flow: e.target.value as CreditSectorMap['trade_flow'] })}><option value="both">both</option><option value="X">exports</option><option value="M">imports</option></select></td>
                  <td><select value={val(r, 'confidence')} onChange={(e) => set(r, { confidence: e.target.value as CreditSectorMap['confidence'] })}><option value="direct">direct</option><option value="indicative">indicative</option><option value="none">none</option></select></td>
                  <td><input value={val(r, 'note') ?? ''} onChange={(e) => set(r, { note: e.target.value })} style={{ minWidth: 220 }} /></td>
                  <td><button className="btn sm" disabled={!dirty} onClick={() => { void onSave({ sector_key: r.sector_key, trade_scope: val(r, 'trade_scope'), hs_prefixes: val(r, 'hs_prefixes'), trade_flow: val(r, 'trade_flow'), confidence: val(r, 'confidence'), note: val(r, 'note') }).then(() => setDraft((d) => { const n = { ...d }; delete n[r.sector_key]; return n; })); }}>Save</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function SpreadsheetCountry({ t, onError, reload }: { t: Props['t']; onError: Props['onError']; reload: () => void }) {
  type Q = Awaited<ReturnType<typeof api.creditAdmin.queue>>;
  const [q, setQ] = useState<Q | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => { api.creditAdmin.queue().then(setQ).catch(onError); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  async function download() {
    try {
      const { blob, filename } = await api.creditAdmin.templateBlob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = filename || 'tereflow-credit-template.xlsx';
      document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
    } catch (e) { onError(e); }
  }
  async function send(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    let ok = 0;
    for (const f of Array.from(files)) { try { await api.creditAdmin.queueUpload(f); ok++; } catch (e) { onError(e); } }
    setBusy(false);
    if (ok) t.ok(`${ok} workbook${ok === 1 ? '' : 's'} queued`);
    load(); reload();
  }
  const kb = (n: number) => `${Math.max(1, Math.round(n / 1024))} KB`;
  return (
    <div className="card">
      <p className="card-title">Add a country from a spreadsheet</p>
      <p className="small dim" style={{ marginTop: 0 }}>
        For a country whose central bank publishes sector credit but has no feed we can call. Copy its published table into the workbook in the same shape as the Bank of Ghana series (one column per sector, one row per period),
        then upload it here or pass it to the pipeline: <code>pipeline.cmd credit --file kenya.xlsx</code>. Check a file first with <code>pipeline.cmd credit-check kenya.xlsx</code>, or <code>--dry-run</code>.
        Every cell is checked by the same rules as a live feed. If anything is wrong the whole file is refused with the row and reason, and nothing is half loaded. The country then shows these figures as their own source and they are never merged with the IMF data.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn" onClick={() => void download()}>Download the workbook template (.xlsx)</button>
        <input type="file" accept=".xlsx" multiple disabled={busy} onChange={(e) => { void send(e.target.files); e.target.value = ''; }} aria-label="Upload a filled workbook" />
      </div>
      {q && (
        <>
          <p className="small" style={{ marginBottom: 4, marginTop: 12 }}><strong>Waiting for the pipeline ({q.pending.length})</strong></p>
          {q.pending.length === 0 ? <p className="small dim" style={{ margin: 0 }}>Nothing waiting.</p> : (
            <ul className="small">{q.pending.map((f) => <li key={f.name}>{f.name} ({kb(f.bytes)}) <button className="btn sm" onClick={() => void api.creditAdmin.queueRemove(f.name).then(load).catch(onError)}>Remove</button></li>)}</ul>
          )}
          {q.rejected.length > 0 && (
            <>
              <p className="small" style={{ marginBottom: 4 }}><strong>Refused (nothing was loaded)</strong></p>
              {q.rejected.map((f) => (
                <div className="callout bad" key={f.name + f.uploaded} style={{ marginBottom: 6 }}>
                  <span className="callout-title">{f.name}</span> <span className="tiny">{f.uploaded.slice(0, 16).replace('T', ' ')}</span>
                  <pre style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap', fontSize: 12 }}>{f.reason ?? 'No reason was recorded.'}</pre>
                </div>
              ))}
            </>
          )}
          {q.done.length > 0 && <p className="tiny dim">Loaded recently: {q.done.slice(0, 6).map((f) => `${f.name} (${f.uploaded.slice(0, 10)})`).join(', ')}</p>}
        </>
      )}
    </div>
  );
}
