import { useEffect, useState } from 'react';
import type { DatasetCode } from '../../shared/csv/schema';
import type { Severity, ValidationReport } from '../../shared/csv/validate';
import {
  api,
  type ManualAnalysisPayload,
  type ManualConfirmResult,
  type ManualImportMode,
  type ManualIssueRow,
  type ManualMetric,
  type ManualStatusRow,
  type ManualUploadRow,
} from '../lib/api';
import { Empty, Skeletons, useToast } from './ui';
import { Markdown } from './Markdown';

// A dataset is stale once its newest year lags the reference year by three or
// more. This is a visual state, not a figure we display: the age itself is
// never shown, only the real latest_year the backend sent.
const STALE_AFTER_YEARS = 3;
const REFERENCE_YEAR = new Date().getFullYear();

// Every issue the UI renders, whether it came from a live validation report or
// from a stored upload, is flattened to this one shape so the table has a
// single contract. row and column stay prominent because that is how someone
// finds the cell in their spreadsheet.
interface NormIssue {
  severity: Severity;
  row: number | null;
  column: string | null;
  code: string;
  message: string;
  value: string | null;
}

const SEVERITY_RANK: Record<Severity, number> = { error: 0, warning: 1, notice: 2 };

function sortIssues(issues: NormIssue[]): NormIssue[] {
  return [...issues].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    return (a.row ?? Number.MAX_SAFE_INTEGER) - (b.row ?? Number.MAX_SAFE_INTEGER);
  });
}

function issuesFromReport(raw: { severity: Severity; row: number | null; column: string | null; code: string; message: string; value?: string | null }[]): NormIssue[] {
  return raw.map((i) => ({
    severity: i.severity,
    row: i.row,
    column: i.column,
    code: i.code,
    message: i.message,
    value: i.value ?? null,
  }));
}

function issuesFromStored(rows: ManualIssueRow[]): NormIssue[] {
  return rows.map((i) => ({
    severity: i.severity,
    row: i.row_number,
    column: i.column_name,
    code: i.code,
    message: i.message,
    value: i.raw_value,
  }));
}

function fmtWhen(value: string | null): string {
  if (!value) return 'never';
  const d = new Date(value.replace(' ', 'T') + 'Z');
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function severityBadge(severity: Severity) {
  return <span className={`badge ${severity}`}>{severity}</span>;
}

function IssueTable({ issues }: { issues: NormIssue[] }) {
  if (issues.length === 0) {
    return <p className="small dim">No issues found.</p>;
  }
  const sorted = sortIssues(issues);
  return (
    <div className="table-wrap">
      <table className="data-table">
        <thead>
          <tr>
            <th>Severity</th>
            <th className="align-right">Row</th>
            <th>Column</th>
            <th>Message</th>
            <th>Value</th>
            <th>Code</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((it, idx) => (
            <tr key={idx}>
              <td>{severityBadge(it.severity)}</td>
              <td className="align-right">
                <strong>{it.row ?? '-'}</strong>
              </td>
              <td>
                <strong>{it.column ?? '-'}</strong>
              </td>
              <td>{it.message}</td>
              <td className="dim">{it.value ?? '-'}</td>
              <td className="tiny dim">{it.code}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function metricRow(label: string, m: ManualMetric) {
  return (
    <tr>
      <td>{label}</td>
      <td className="align-right">{m.value ?? 'n/a'}</td>
      <td className="dim">{m.unit ?? '-'}</td>
      <td className="align-right">{m.year ?? '-'}</td>
      <td>
        <span className="badge">{m.confidence}</span>
      </td>
    </tr>
  );
}

export function ManualData({ slug }: { slug: string }) {
  const { ok, err, node } = useToast();

  const [statusRows, setStatusRows] = useState<ManualStatusRow[] | null>(null);
  const [statusErr, setStatusErr] = useState('');
  const [uploads, setUploads] = useState<ManualUploadRow[] | null>(null);

  // Upload form.
  const [dataset, setDataset] = useState<DatasetCode | ''>('');
  const [content, setContent] = useState('');
  const [filename, setFilename] = useState('');
  const [period, setPeriod] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [importMode, setImportMode] = useState<ManualImportMode | ''>('');

  // Validation report is content only, so it survives an import-mode change but
  // is cleared the moment the dataset or the file behind it changes.
  const [report, setReport] = useState<ValidationReport | null>(null);
  const [validating, setValidating] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [confirmResult, setConfirmResult] = useState<ManualConfirmResult | null>(null);

  // Readme viewer.
  const [readme, setReadme] = useState<{ name: string; text: string } | null>(null);

  // History "view issues" viewer.
  const [issuesView, setIssuesView] = useState<{ upload: ManualUploadRow; issues: ManualIssueRow[] } | null>(null);

  // Analysis.
  const [analysis, setAnalysis] = useState<ManualAnalysisPayload | null>(null);
  const [analysing, setAnalysing] = useState(false);

  async function loadStatus() {
    setStatusErr('');
    try {
      const res = await api.admin.manual.status(slug);
      setStatusRows(res.status);
    } catch (e) {
      setStatusErr(e instanceof Error ? e.message : 'Failed to load status');
      setStatusRows([]);
    }
  }

  async function loadUploads() {
    try {
      const res = await api.admin.manual.uploads(slug);
      setUploads(res.uploads);
    } catch (e) {
      err(e instanceof Error ? e.message : 'Failed to load history');
      setUploads([]);
    }
  }

  useEffect(() => {
    void loadStatus();
    void loadUploads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [slug]);

  function resetReport() {
    setReport(null);
    setConfirmResult(null);
  }

  async function onFile(file: File) {
    const text = await file.text();
    setContent(text);
    setFilename(file.name);
    resetReport();
  }

  async function downloadTemplate(code: DatasetCode) {
    try {
      const { blob, filename: fn } = await api.admin.manual.templateBlob(code);
      saveBlob(blob, fn);
    } catch (e) {
      err(e instanceof Error ? e.message : 'Template download failed');
    }
  }

  async function openReadme(code: DatasetCode, name: string) {
    try {
      const text = await api.admin.manual.readme(code);
      setReadme({ name, text });
    } catch (e) {
      err(e instanceof Error ? e.message : 'Readme failed to load');
    }
  }

  async function runValidate() {
    if (!dataset) return;
    setValidating(true);
    setConfirmResult(null);
    try {
      const res = await api.admin.manual.validate({ slug, dataset, content });
      setReport(res.report);
    } catch (e) {
      err(e instanceof Error ? e.message : 'Validation failed');
    } finally {
      setValidating(false);
    }
  }

  async function runConfirm() {
    if (!dataset || !importMode || !report || !report.ok) return;
    setConfirming(true);
    try {
      // Stage first so the worker re-validates exactly what will be written.
      // Nothing is committed until the staged report is clean and confirm runs.
      const staged = await api.admin.manual.stage({
        slug,
        dataset,
        filename: filename || undefined,
        content,
        period: period || undefined,
        source_name: sourceName || undefined,
        source_url: sourceUrl || undefined,
        import_mode: importMode,
      });
      if (!staged.report.ok) {
        setReport(staged.report);
        err('The file no longer validates. Nothing was imported.');
        return;
      }
      const result = await api.admin.manual.confirm(staged.id);
      setConfirmResult(result);
      ok('Import complete.');
      await loadStatus();
      await loadUploads();
    } catch (e) {
      err(e instanceof Error ? e.message : 'Import failed');
    } finally {
      setConfirming(false);
    }
  }

  async function downloadOriginal(row: ManualUploadRow) {
    try {
      const { blob, filename: fn } = await api.admin.manual.fileBlob(row.id);
      saveBlob(blob, fn || row.filename);
    } catch (e) {
      err(e instanceof Error ? e.message : 'Download failed');
    }
  }

  async function viewIssues(row: ManualUploadRow) {
    try {
      const detail = await api.admin.manual.upload(row.id);
      setIssuesView({ upload: detail.upload, issues: detail.issues });
    } catch (e) {
      err(e instanceof Error ? e.message : 'Could not load issues');
    }
  }

  async function revert(row: ManualUploadRow) {
    // State the number of rows the revert will remove before doing it. There is
    // no silent destructive action here.
    const proceed = window.confirm(
      `Revert ${row.filename}? This will remove ${row.rows_written} imported row(s) from ${row.dataset_code}.`,
    );
    if (!proceed) return;
    try {
      const res = await api.admin.manual.revert(row.id);
      ok(`Reverted. ${res.rows_removed} row(s) removed.`);
      await loadStatus();
      await loadUploads();
    } catch (e) {
      err(e instanceof Error ? e.message : 'Revert failed');
    }
  }

  async function runAnalyse() {
    setAnalysing(true);
    try {
      const res = await api.admin.manual.analyse(slug);
      setAnalysis(res.manual);
      ok(`Analysis complete. Wrote ${res.kinds_written.length} kind(s).`);
    } catch (e) {
      err(e instanceof Error ? e.message : 'Analysis failed');
    } finally {
      setAnalysing(false);
    }
  }

  const datasetOptions = statusRows ?? [];
  const reportIssues = report ? issuesFromReport(report.issues) : [];

  const confirmLabel = (() => {
    if (!importMode) return 'Choose an import mode above';
    if (importMode === 'replace_period') {
      const n = report?.years.length ?? 0;
      return `Confirm and replace ${n} year(s)`;
    }
    return 'Confirm and import (append)';
  })();

  return (
    <>
      {node}

      {/* 1. Dataset status grid */}
      <div className="card">
        <p className="card-title">Manual data status</p>
        {statusErr && <p className="callout bad">{statusErr}</p>}
        {statusRows === null ? (
          <Skeletons n={4} />
        ) : statusRows.length === 0 ? (
          <Empty title="No datasets" hint="The manual datasets could not be loaded for this country." />
        ) : (
          <div className="grid two-md">
            {datasetOptions.map((r) => {
              const stale =
                r.loaded && r.latest_year != null && REFERENCE_YEAR - r.latest_year >= STALE_AFTER_YEARS;
              const state = !r.loaded ? 'missing' : stale ? 'stale' : 'current';
              const badge =
                state === 'missing' ? (
                  <span className="badge error">Not loaded</span>
                ) : state === 'stale' ? (
                  <span className="badge watch">Stale</span>
                ) : (
                  <span className="badge on">Loaded</span>
                );
              return (
                <div className={`card ds-card ${state}`} key={r.dataset}>
                  <div className="row between wrap" style={{ gap: 8 }}>
                    <strong>{r.name}</strong>
                    {badge}
                  </div>
                  <p className="small dim" style={{ marginTop: 4 }}>
                    {r.target}
                  </p>
                  {r.loaded ? (
                    <p style={{ marginTop: 8 }}>
                      {r.row_count} rows
                      {r.latest_year != null && (
                        <span className="dim"> · latest year {r.latest_year}</span>
                      )}
                    </p>
                  ) : (
                    <p style={{ marginTop: 8 }}>
                      <strong style={{ color: 'var(--down)' }}>No data loaded</strong>
                    </p>
                  )}
                  {r.last_upload ? (
                    <p className="tiny dim" style={{ marginTop: 6 }}>
                      Last upload {r.last_upload.filename} on {fmtWhen(r.last_upload.uploaded_at)}
                    </p>
                  ) : (
                    <p className="tiny dim" style={{ marginTop: 6 }}>
                      Never uploaded
                    </p>
                  )}
                  {r.refresh_hint && (
                    <p className="tiny dim" style={{ marginTop: 4 }}>
                      {r.refresh_hint}
                    </p>
                  )}
                  <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void downloadTemplate(r.dataset)}
                    >
                      Template
                    </button>
                    <button
                      type="button"
                      className="btn ghost sm"
                      onClick={() => void openReadme(r.dataset, r.name)}
                    >
                      README
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* README viewer */}
      {readme && (
        <div className="card">
          <div className="row between wrap" style={{ gap: 8 }}>
            <p className="card-title" style={{ margin: 0 }}>
              {readme.name} template guide
            </p>
            <button type="button" className="btn ghost sm" onClick={() => setReadme(null)}>
              Close
            </button>
          </div>
          <div className="md" style={{ marginTop: 10 }}>
            <Markdown source={readme.text} />
          </div>
        </div>
      )}

      {/* 3. Upload flow */}
      <div className="card">
        <p className="card-title">Upload a file</p>

        <div className="field">
          <label>Dataset</label>
          <select
            value={dataset}
            onChange={(e) => {
              setDataset(e.target.value as DatasetCode | '');
              resetReport();
            }}
          >
            <option value="">Pick a dataset</option>
            {datasetOptions.map((r) => (
              <option key={r.dataset} value={r.dataset}>
                {r.name}
              </option>
            ))}
          </select>
        </div>

        <div className="field">
          <label>CSV file</label>
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void onFile(f);
            }}
          />
          {filename && <p className="tiny dim">Loaded {filename}</p>}
        </div>

        <div className="field">
          <label>Or paste CSV text</label>
          <textarea
            value={content}
            onChange={(e) => {
              setContent(e.target.value);
              resetReport();
            }}
            placeholder="country_iso3,year,..."
          />
        </div>

        <div className="grid two-md">
          <div className="field">
            <label>Period label</label>
            <input
              type="text"
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
              placeholder="2024 annual"
            />
          </div>
          <div className="field">
            <label>Source name</label>
            <input
              type="text"
              value={sourceName}
              onChange={(e) => setSourceName(e.target.value)}
              placeholder="National statistics office"
            />
          </div>
        </div>
        <div className="field">
          <label>Source URL</label>
          <input
            type="url"
            value={sourceUrl}
            onChange={(e) => setSourceUrl(e.target.value)}
            placeholder="https://"
          />
        </div>

        <div className="field">
          <label>Import mode</label>
          <div className="row wrap" style={{ gap: 16 }}>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="import-mode"
                checked={importMode === 'append_period'}
                onChange={() => setImportMode('append_period')}
              />
              <span>Append period</span>
            </label>
            <label className="row" style={{ gap: 6, cursor: 'pointer' }}>
              <input
                type="radio"
                name="import-mode"
                checked={importMode === 'replace_period'}
                onChange={() => setImportMode('replace_period')}
              />
              <span>Replace period</span>
            </label>
          </div>
          <p className="help">Neither is preselected. Choose how this file should be applied.</p>
          {importMode === 'replace_period' && report && (
            <p className="callout warn" style={{ marginTop: 8 }}>
              {report.years.length > 0
                ? `Replace will delete these year(s) before importing: ${report.years.join(', ')}.`
                : 'The file has no complete years, so replace will delete nothing.'}
            </p>
          )}
        </div>

        <div className="row wrap" style={{ gap: 8, marginTop: 4 }}>
          <button
            type="button"
            className="btn primary"
            disabled={!dataset || !content.trim() || validating}
            onClick={() => void runValidate()}
          >
            {validating ? 'Validating...' : 'Validate'}
          </button>
        </div>

        {/* Validation report */}
        {report && (
          <div style={{ marginTop: 14 }}>
            <div className="row wrap" style={{ gap: 8, alignItems: 'center' }}>
              <span
                className={`badge ${report.ok ? 'on' : 'error'}`}
              >
                {report.status}
              </span>
              <span className="small dim">
                {report.validRows} of {report.totalRows} rows valid
              </span>
            </div>

            {report.summary.length > 0 && (
              <div className="callout" style={{ marginTop: 10 }}>
                {report.summary.map((line, i) => (
                  <div key={i}>{line}</div>
                ))}
              </div>
            )}

            <div style={{ marginTop: 10 }}>
              <IssueTable issues={reportIssues} />
            </div>

            {!report.ok && (
              <p className="callout bad" style={{ marginTop: 10 }}>
                This file has errors and cannot be imported. Fix the rows above and validate again.
              </p>
            )}

            <div className="row wrap" style={{ gap: 8, marginTop: 12 }}>
              <button
                type="button"
                className="btn gold"
                disabled={!report.ok || !importMode || confirming}
                onClick={() => void runConfirm()}
              >
                {confirming ? 'Importing...' : confirmLabel}
              </button>
            </div>
          </div>
        )}

        {/* Confirm result. Held-back rows sit at the same weight as the win. */}
        {confirmResult && (
          <div style={{ marginTop: 14 }}>
            <p className="callout ok">
              <span className="callout-title">Imported.</span> {confirmResult.rows_written} row(s)
              written{confirmResult.rows_replaced > 0 && `, ${confirmResult.rows_replaced} replaced`}.
            </p>
            {confirmResult.held_back_no_usd > 0 && (
              <p className="callout warn">
                <span className="callout-title">Held back:</span> {confirmResult.held_back_no_usd}{' '}
                row(s) had no USD value and were not written.
              </p>
            )}
          </div>
        )}
      </div>

      {/* 4. Upload history */}
      <div className="card">
        <p className="card-title">Upload history</p>
        {uploads === null ? (
          <Skeletons n={3} />
        ) : uploads.length === 0 ? (
          <Empty title="No uploads yet" hint="Files you upload for this country will appear here." />
        ) : (
          <div className="table-wrap">
            <table className="data-table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Dataset</th>
                  <th>When</th>
                  <th>Status</th>
                  <th className="align-right">Rows written</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {uploads.map((u) => {
                  const imported = u.import_status === 'imported';
                  // The database words are for the database. "not_imported"
                  // and "failed" mean different things to whoever is reading
                  // this, so say which one it was in words they can act on.
                  const statusBadge =
                    u.import_status === 'imported' ? (
                      <span className="badge on">imported</span>
                    ) : u.import_status === 'reverted' ? (
                      <span className="badge off">reverted</span>
                    ) : u.import_status === 'not_imported' ? (
                      <span className="badge watch">not imported</span>
                    ) : u.import_status === 'failed' ? (
                      <span className="badge watch">failed</span>
                    ) : (
                      <span className="badge watch">{u.import_status.replace(/_/g, ' ')}</span>
                    );
                  return (
                    <tr key={u.id}>
                      <td>{u.filename}</td>
                      <td>{u.dataset_code}</td>
                      <td>{fmtWhen(u.uploaded_at)}</td>
                      <td>{statusBadge}</td>
                      <td className="align-right">{imported ? u.rows_written : '-'}</td>
                      <td>
                        <div className="row wrap" style={{ gap: 6 }}>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => void downloadOriginal(u)}
                          >
                            Download
                          </button>
                          <button
                            type="button"
                            className="btn ghost sm"
                            onClick={() => void viewIssues(u)}
                          >
                            Issues
                          </button>
                          {imported && (
                            <button
                              type="button"
                              className="btn danger sm"
                              onClick={() => void revert(u)}
                            >
                              Revert
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* History issue viewer */}
      {issuesView && (
        <div className="card">
          <div className="row between wrap" style={{ gap: 8 }}>
            <p className="card-title" style={{ margin: 0 }}>
              Issues for {issuesView.upload.filename}
            </p>
            <button type="button" className="btn ghost sm" onClick={() => setIssuesView(null)}>
              Close
            </button>
          </div>
          <div style={{ marginTop: 10 }}>
            <IssueTable issues={issuesFromStored(issuesView.issues)} />
          </div>
        </div>
      )}

      {/* 5. Re-run analysis */}
      <div className="card">
        <div className="row between wrap" style={{ gap: 8 }}>
          <p className="card-title" style={{ margin: 0 }}>
            Analysis
          </p>
          <button
            type="button"
            className="btn primary sm"
            disabled={analysing}
            onClick={() => void runAnalyse()}
          >
            {analysing ? 'Running...' : 'Re-run analysis'}
          </button>
        </div>

        {analysis && (
          <div style={{ marginTop: 12 }}>
            <p className="small dim">
              Generated {fmtWhen(analysis.generated_at)} · reference year {analysis.freshness.reference_year}
            </p>
            {analysis.freshness.note && (
              <p className="callout" style={{ marginTop: 8 }}>
                {analysis.freshness.note}
              </p>
            )}

            <div className="table-wrap" style={{ marginTop: 10 }}>
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    <th className="align-right">Value</th>
                    <th>Unit</th>
                    <th className="align-right">Year</th>
                    <th>Confidence</th>
                  </tr>
                </thead>
                <tbody>
                  {metricRow('Consumer market', analysis.consumer_market)}
                  {metricRow('Income opportunity', analysis.income_opportunity)}
                  {metricRow('Labour availability', analysis.labour_availability)}
                  {metricRow('Infrastructure readiness', analysis.infrastructure_readiness)}
                  {metricRow('Macro stability', analysis.macro_stability)}
                  {metricRow('Investment risk', analysis.investment_risk)}
                  {metricRow('Data confidence', analysis.data_confidence)}
                </tbody>
              </table>
            </div>

            {analysis.sector_opportunities.length > 0 && (
              <div className="table-wrap" style={{ marginTop: 12 }}>
                <table className="data-table">
                  <thead>
                    <tr>
                      <th>Sector</th>
                      <th className="align-right">Year</th>
                      <th className="align-right">Score</th>
                      <th>Band</th>
                    </tr>
                  </thead>
                  <tbody>
                    {analysis.sector_opportunities.map((s) => (
                      <tr key={s.sector_code}>
                        <td>{s.sector_name ?? s.sector_code}</td>
                        <td className="align-right">{s.year}</td>
                        <td className="align-right">{s.score ?? 'n/a'}</td>
                        <td>
                          <span className="badge">{s.band}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {analysis.missing_data_warnings.length > 0 && (
              <div className="callout warn" style={{ marginTop: 12 }}>
                <div className="callout-title">Missing data</div>
                {analysis.missing_data_warnings.map((w, i) => (
                  <div key={i}>{w}</div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </>
  );
}
