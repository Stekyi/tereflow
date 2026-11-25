import { useCallback, useEffect, useState } from 'react';
import { api } from '../lib/api';
import type { IntelAdminIcio } from '../lib/intel-types';

interface Props { t: { ok: (m: string) => void; err: (m: string) => void }; onError: (e: unknown) => void }

const mb = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

export function IntelAdmin({ t, onError }: Props) {
  const [q, setQ] = useState<IntelAdminIcio | null>(null);
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const load = useCallback(() => { api.intelAdmin.icio().then(setQ).catch(onError); // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { load(); }, [load]);

  async function send(files: FileList | null) {
    if (!files || !files.length) return;
    setBusy(true);
    for (const f of Array.from(files)) {
      try { setPct(0); await api.intelAdmin.icioUpload(f, setPct); t.ok(`${f.name} queued`); } catch (e) { onError(e); }
    }
    setBusy(false);
    load();
  }

  return (
    <div className="card">
      <p className="card-title">Input-output tables: OECD ICIO</p>
      <p className="small dim" style={{ marginTop: 0 }}>
        The production network on each product page uses the Eurostat FIGARO table. To add the OECD Inter-Country Input-Output (ICIO) table, download one year from OECD
        (<a href="https://www.oecd.org/en/data/datasets/inter-country-input-output-tables.html" target="_blank" rel="noreferrer">OECD ICIO page</a>) and upload that year's file here, zipped, under {q ? mb(q.max_bytes) : '95 MB'}.
        The file name must contain the year. The website only stores it. The pipeline opens it at its next run (nightly, or <code>pipeline.cmd intel-io --icio</code>), checks that the table balances
        (input columns add up to output, rows add up to total use, rows and columns list the same country-industries), and loads it only if every check passes. A file that fails any check is refused whole, with the reasons shown below, and nothing is half loaded.
      </p>
      <div className="callout" style={{ marginBottom: 8 }}>
        <span className="callout-title">What to expect. </span>
        This loader follows OECD's published layout but has not yet been run on a real OECD file, so the first upload is its first real test. OECD terms of use apply to the file and you are responsible for having the right to use it.
        OECD industry codes differ from the FIGARO ones, so ICIO results are shown by country and industry code and are not yet linked to the product-to-industry mapping.
      </div>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="file" accept=".zip,.csv" disabled={busy} onChange={(e) => { void send(e.target.files); e.target.value = ''; }} aria-label="Upload an OECD ICIO file" />
        {busy && <span className="small">Uploading {pct}%</span>}
      </div>
      {q && (
        <>
          <p className="small" style={{ marginBottom: 4, marginTop: 12 }}><strong>Waiting for the pipeline ({q.pending.length})</strong></p>
          {q.pending.length === 0 ? <p className="small dim" style={{ margin: 0 }}>Nothing waiting.</p> : (
            <ul className="small">{q.pending.map((f) => <li key={f.name}>{f.name} ({mb(f.bytes)}) <button className="btn sm" onClick={() => void api.intelAdmin.icioRemove(f.name).then(load).catch(onError)}>Remove</button></li>)}</ul>
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
          {q.loaded.length > 0 && (
            <>
              <p className="small" style={{ marginBottom: 4 }}><strong>Loaded</strong></p>
              <ul className="small">{q.loaded.map((l) => <li key={l.key}>Year {l.year ?? 'n/a'}: {l.file ?? l.key}, {l.countries} countries or regions, loaded {l.updated_at}{l.balance ? `; worst column balance gap ${l.balance.column_balance_max_rel ?? 'n/a'}` : ''}</li>)}</ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
