/**
 * Tereflow manual data CLI.
 *
 * The owner is loading trade and indicator data by hand now rather than
 * scraping it. These commands are the local half of that: they generate the
 * blank templates an administrator fills in, and they carry a filled file
 * through validate, upload and confirm against the Worker. The Worker is the
 * only thing that writes to the database; this script never touches D1
 * directly. It moves files between data/incoming, data/processed and
 * data/rejected so the folder itself records what has been dealt with.
 *
 * Usage:
 *   node local/dist/manual-data.mjs templates
 *   node local/dist/manual-data.mjs validate --country ghana --type exports --file ./data/incoming/x.csv
 *   node local/dist/manual-data.mjs import   --country ghana --type exports --file ./data/incoming/x.csv [--mode replace_period]
 *   node local/dist/manual-data.mjs analyse  --country ghana
 *   node local/dist/manual-data.mjs report   --country ghana
 *
 * Configuration comes from local/.env or the environment, exactly as the
 * pipeline reads it:
 *   TEREFLOW_API_URL     https://tereflow.example.com   (default localhost:8787)
 *   TEREFLOW_ADMIN_TOKEN the ADMIN_TOKEN secret
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DATASET_CODES, type DatasetCode } from '../shared/csv/schema';
import { buildReadme, buildTemplate } from '../shared/csv/template';
import type { ValidationReport } from '../shared/csv/validate';

interface Config {
  apiUrl: string;
  adminToken: string;
}

interface Args {
  command: string;
  country?: string;
  type?: string;
  file?: string;
  mode?: string;
  source_name?: string;
  source_url?: string;
  period?: string;
}

/** Read the subcommand and its flags in the same shape the pipeline uses. */
function readArgs(): Args {
  const argv = process.argv.slice(2);
  const command = argv[0] ?? '';
  const flag = (name: string): string | undefined => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  return {
    command,
    country: flag('country'),
    type: flag('type'),
    file: flag('file'),
    mode: flag('mode'),
    source_name: flag('source-name'),
    source_url: flag('source-url'),
    period: flag('period'),
  };
}

function readConfig(): Config {
  const apiUrl = (process.env.TEREFLOW_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const adminToken = process.env.TEREFLOW_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    console.error(
      'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.\n' +
        'It must match the ADMIN_TOKEN secret on the Worker.',
    );
    process.exit(1);
  }
  return { apiUrl, adminToken };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Same authenticated, retrying client the pipeline uses, trimmed to what the
 *  manual commands need. Errors carry the HTTP body so a rejection reads as a
 *  message, not a stack. */
class Api {
  constructor(private cfg: Config) {}

  async call<T>(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${this.cfg.adminToken}`);
    if (init.body) headers.set('content-type', 'application/json');
    // No keep-alive. A pooled socket left open outlives the work, and exiting
    // while libuv is still closing it aborts the process on Windows with
    // 0xC0000409 after a perfectly good import. A scheduled run would then
    // read a success as a crash. This is a handful of requests, so the cost of
    // a fresh connection each time is nothing next to that.
    headers.set('connection', 'close');

    let lastError = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(800 * attempt);
      try {
        const res = await fetch(`${this.cfg.apiUrl}${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          // A 4xx is the Worker telling us the file or request is wrong. That is
          // a final answer, not a transient fault, so surface it rather than
          // retrying into the same rejection.
          if (res.status >= 500 || res.status === 429) {
            lastError = `HTTP ${res.status}`;
            continue;
          }
          let detail = text.slice(0, 400);
          try {
            const parsed = JSON.parse(text);
            if (parsed?.error) detail = String(parsed.error);
          } catch {
            // keep the raw text
          }
          throw new Error(detail);
        }
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 2) throw new Error(lastError);
        // A thrown 4xx above is final; do not spend the remaining attempts.
        if (lastError.startsWith('HTTP ')) continue;
        throw new Error(lastError);
      }
    }
    throw new Error(lastError);
  }
}

const DATASET_SET = new Set<string>(DATASET_CODES);

function assertType(type: string | undefined): DatasetCode {
  if (!type || !DATASET_SET.has(type)) {
    console.error(
      `--type must be one of: ${DATASET_CODES.join(', ')}.` + (type ? ` Got '${type}'.` : ''),
    );
    process.exit(1);
  }
  return type as DatasetCode;
}

function requireFlag(value: string | undefined, name: string): string {
  if (!value) {
    console.error(`--${name} is required.`);
    // Throwing rather than exiting here. process.exit does not narrow the type,
    // so the compiler still saw value as possibly undefined below, and the
    // caller catches this and prints it the same way as any other failure.
    throw new Error(`--${name} is required.`);
  }
  return value;
}

function stamp(): string {
  // A filename-safe timestamp: 2026-09-08T15-04-22.
  return new Date().toISOString().replace(/\..+$/, '').replace(/:/g, '-');
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

// --- templates --------------------------------------------------------------
// No network needed: the template and readme come from the same builders the
// validator is generated from, so a template can never drift from the rules it
// will be checked against.

function cmdTemplates(): void {
  const dir = join('data', 'templates');
  ensureDir(dir);
  for (const code of DATASET_CODES) {
    const csvPath = join(dir, `${code}-template.csv`);
    const readmePath = join(dir, `${code}-README.md`);
    writeFileSync(csvPath, buildTemplate(code), 'utf8');
    writeFileSync(readmePath, buildReadme(code), 'utf8');
    console.log(`  wrote ${csvPath} and ${readmePath}`);
  }
  console.log(`\n${DATASET_CODES.length} template pairs written to ${dir}/`);
}

// --- validate ---------------------------------------------------------------
// Reads the file and asks the Worker to judge it. Writes the full report to
// data/validation and prints a summary. Moves nothing: validate is safe to run
// as many times as you like.

function printReport(report: ValidationReport): void {
  console.log(`  status: ${report.status}`);
  console.log(
    `  ${report.totalRows} row(s), ${report.validRows} valid, ` +
      `${report.errorCount} error(s), ${report.warningCount} warning(s), ${report.noticeCount} notice(s)`,
  );
  if (report.years.length) console.log(`  years: ${report.years.join(', ')}`);
  const shown = report.issues.slice(0, 25);
  for (const issue of shown) {
    const where =
      issue.row != null ? `row ${issue.row}` : issue.column ? `column ${issue.column}` : 'file';
    const col = issue.column && issue.row != null ? ` [${issue.column}]` : '';
    console.log(`  ${issue.severity.toUpperCase()} ${where}${col}: ${issue.message}`);
  }
  if (report.issues.length > shown.length) {
    console.log(`  ... and ${report.issues.length - shown.length} more issue(s) in the report file`);
  }
  for (const line of report.summary) console.log(`  ${line}`);
}

async function cmdValidate(api: Api, args: Args): Promise<number> {
  const country = requireFlag(args.country, 'country');
  const type = assertType(args.type);
  const file = requireFlag(args.file, 'file');
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    return 1;
  }
  const content = readFileSync(file, 'utf8');
  const filename = basename(file);

  console.log(`Validating ${filename} as ${type} for ${country}...`);
  const { report } = await api.call<{ report: ValidationReport }>('/api/admin/manual/validate', {
    method: 'POST',
    body: JSON.stringify({ slug: country, dataset: type, filename, content }),
  });

  const dir = join('data', 'validation');
  ensureDir(dir);
  const out = join(dir, `${country}-${type}-${stamp()}.json`);
  writeFileSync(out, JSON.stringify(report, null, 2), 'utf8');
  printReport(report);
  console.log(`\n  full report: ${out}`);
  // Validation never moves a file, so it never fails the process on a bad file.
  // It reports and lets the administrator decide.
  return 0;
}

// --- import -----------------------------------------------------------------
// Upload records the file and its issues but writes no business data. Confirm
// is the single place rows land. On a clean import the source file moves to
// data/processed; on a rejection it moves to data/rejected. A file outside
// data/incoming is left where it is: only the incoming tray is swept.

function moveByTray(file: string, tray: 'processed' | 'rejected'): void {
  const normalised = file.replace(/\\/g, '/');
  if (!normalised.includes('/incoming/')) {
    console.log(`  file is not in data/incoming, leaving it at ${file}`);
    return;
  }
  const dir = join('data', tray);
  ensureDir(dir);
  const dest = join(dir, basename(file));
  renameSync(file, dest);
  console.log(`  moved to ${dest}`);
}

async function cmdImport(api: Api, args: Args): Promise<number> {
  const country = requireFlag(args.country, 'country');
  const type = assertType(args.type);
  const file = requireFlag(args.file, 'file');
  const mode = args.mode ?? 'append_period';
  if (mode !== 'append_period' && mode !== 'replace_period') {
    console.error("--mode must be 'append_period' or 'replace_period'.");
    return 1;
  }
  if (!existsSync(file)) {
    console.error(`File not found: ${file}`);
    return 1;
  }
  const content = readFileSync(file, 'utf8');
  const filename = basename(file);

  console.log(`Uploading ${filename} as ${type} for ${country} (${mode})...`);
  let uploadId: string;
  let report: ValidationReport;
  try {
    const res = await api.call<{ id: string; report: ValidationReport }>('/api/admin/manual/upload', {
      method: 'POST',
      body: JSON.stringify({
        slug: country,
        dataset: type,
        filename,
        content,
        period: args.period,
        source_name: args.source_name,
        source_url: args.source_url,
        import_mode: mode,
      }),
    });
    uploadId = res.id;
    report = res.report;
  } catch (err) {
    // A duplicate or an unknown country is rejected here before any upload row
    // is even kept for confirming, so the file goes to rejected.
    console.error(`  upload rejected: ${err instanceof Error ? err.message : err}`);
    moveByTray(file, 'rejected');
    return 1;
  }

  printReport(report);

  if (report.status === 'invalid' || report.errorCount > 0) {
    console.error(`\n  ${filename} has errors and will not be imported. Upload ${uploadId} kept for the record.`);
    moveByTray(file, 'rejected');
    return 1;
  }

  console.log(`\nConfirming upload ${uploadId}...`);
  try {
    const res = await api.call<{
      id: string;
      rows_written: number;
      rows_replaced: number;
      held_back_no_usd: number;
    }>(`/api/admin/manual/upload/${uploadId}/confirm`, { method: 'POST' });
    console.log(`  imported: ${res.rows_written} row(s) written, ${res.rows_replaced} replaced`);
    if (res.held_back_no_usd > 0) {
      console.log(
        `  ${res.held_back_no_usd} trade row(s) had no USD value and were held back rather than stored as zero`,
      );
    }
    moveByTray(file, 'processed');
    return 0;
  } catch (err) {
    console.error(`  confirm failed: ${err instanceof Error ? err.message : err}`);
    moveByTray(file, 'rejected');
    return 1;
  }
}

// --- analyse ----------------------------------------------------------------

interface Metric {
  value: number | null;
  unit: string | null;
  year: number | null;
  method: string;
  basedOn: string[];
  missing: string[];
  confidence: string;
  notes: string[];
}

interface SectorOpportunity {
  sector_code: string;
  sector_name: string | null;
  year: number;
  score: number | null;
  band: string;
  reasons: string[];
  basedOn: string[];
  missing: string[];
}

interface ManualAnalysis {
  entity: string;
  generated_at: string;
  consumer_market: Metric;
  income_opportunity: Metric;
  labour_availability: Metric;
  infrastructure_readiness: Metric;
  macro_stability: Metric;
  investment_risk: Metric;
  data_confidence: Metric;
  sector_opportunities: SectorOpportunity[];
  trade_summary: {
    present: boolean;
    top_export: string | null;
    top_import: string | null;
    latest_year: number | null;
  };
  missing_data_warnings: string[];
  freshness: {
    latest_indicator_year: number | null;
    latest_sector_year: number | null;
    reference_year: number;
    indicator_age_years: number | null;
    sector_age_years: number | null;
    note: string;
  };
}

interface AnalyseResponse {
  entity: { slug: string; name: string };
  run_id: string;
  kinds_written: string[];
  manual: ManualAnalysis;
}

async function runAnalyse(api: Api, country: string): Promise<AnalyseResponse> {
  return api.call<AnalyseResponse>('/api/admin/manual/analyse', {
    method: 'POST',
    body: JSON.stringify({ slug: country }),
  });
}

function metricLine(label: string, m: Metric): string {
  const value = m.value == null ? 'not available' : `${m.value}${m.unit ? ` ${m.unit}` : ''}`;
  return `  ${label}: ${value} (confidence ${m.confidence})`;
}

async function cmdAnalyse(api: Api, args: Args): Promise<number> {
  const country = requireFlag(args.country, 'country');
  console.log(`Analysing stored data for ${country}...`);
  const res = await runAnalyse(api, country);
  const m = res.manual;
  console.log(`  run ${res.run_id}, wrote: ${res.kinds_written.join(', ')}`);
  console.log(metricLine('consumer market', m.consumer_market));
  console.log(metricLine('income opportunity', m.income_opportunity));
  console.log(metricLine('labour availability', m.labour_availability));
  console.log(metricLine('infrastructure readiness', m.infrastructure_readiness));
  console.log(metricLine('macro stability', m.macro_stability));
  console.log(metricLine('investment risk', m.investment_risk));
  console.log(metricLine('data confidence', m.data_confidence));
  if (m.missing_data_warnings.length) {
    console.log('  missing data:');
    for (const w of m.missing_data_warnings) console.log(`    ${w}`);
  }
  return 0;
}

// --- report -----------------------------------------------------------------
// A markdown investment brief. It recomputes so the brief is never stale, then
// lays out every metric with what it was computed from and what was missing.
// The point of the whole phase is that a recommendation shows its evidence, so
// the report leads with confidence and missing data rather than hiding them.

function metricSection(title: string, m: Metric): string {
  const lines: string[] = [];
  lines.push(`### ${title}`);
  lines.push('');
  const value = m.value == null ? 'Not available' : `${m.value}${m.unit ? ` ${m.unit}` : ''}`;
  lines.push(`- Value: ${value}`);
  if (m.year != null) lines.push(`- Year: ${m.year}`);
  lines.push(`- Confidence: ${m.confidence}`);
  lines.push(`- Method: ${m.method}`);
  if (m.basedOn.length) lines.push(`- Based on: ${m.basedOn.join(', ')}`);
  if (m.missing.length) lines.push(`- Missing: ${m.missing.join(', ')}`);
  for (const note of m.notes) lines.push(`- Note: ${note}`);
  lines.push('');
  return lines.join('\n');
}

function buildMarkdown(m: ManualAnalysis): string {
  const out: string[] = [];
  out.push(`# Investment brief: ${m.entity}`);
  out.push('');
  out.push(`Generated ${m.generated_at}. Reference year ${m.freshness.reference_year}.`);
  out.push('');
  out.push(
    'This brief is computed only from data that was uploaded. A missing figure ' +
      'is left missing, never treated as zero. Read the confidence and missing ' +
      'lines under each metric before acting on it. Nothing here is absolute ' +
      'investment advice.',
  );
  out.push('');

  out.push('## Market and opportunity');
  out.push('');
  out.push(metricSection('Consumer market size', m.consumer_market));
  out.push(metricSection('Income-adjusted opportunity', m.income_opportunity));

  out.push('## Readiness and risk');
  out.push('');
  out.push(metricSection('Labour availability', m.labour_availability));
  out.push(metricSection('Infrastructure readiness', m.infrastructure_readiness));
  out.push(metricSection('Macro stability', m.macro_stability));
  out.push(metricSection('Investment risk', m.investment_risk));
  out.push(metricSection('Data confidence', m.data_confidence));

  out.push('## Sector opportunities');
  out.push('');
  if (!m.sector_opportunities.length) {
    out.push('No sector data was uploaded, so no sectors could be ranked.');
    out.push('');
  } else {
    for (const s of m.sector_opportunities) {
      const name = s.sector_name ?? s.sector_code;
      const score = s.score == null ? 'unscored' : `${s.score}`;
      out.push(`### ${name} (${s.band}, score ${score}, ${s.year})`);
      out.push('');
      for (const r of s.reasons) out.push(`- ${r}`);
      if (s.basedOn.length) out.push(`- Based on: ${s.basedOn.join(', ')}`);
      if (s.missing.length) out.push(`- Missing: ${s.missing.join(', ')}`);
      out.push('');
    }
  }

  out.push('## Trade');
  out.push('');
  if (m.trade_summary.present) {
    out.push(`- Top export: ${m.trade_summary.top_export ?? 'not available'}`);
    out.push(`- Top import: ${m.trade_summary.top_import ?? 'not available'}`);
    out.push(`- Latest trade year: ${m.trade_summary.latest_year ?? 'not available'}`);
  } else {
    out.push('No trade data was uploaded for this country.');
  }
  out.push('');

  out.push('## Data freshness');
  out.push('');
  out.push(`- Latest indicator year: ${m.freshness.latest_indicator_year ?? 'none'}`);
  out.push(`- Latest sector year: ${m.freshness.latest_sector_year ?? 'none'}`);
  if (m.freshness.indicator_age_years != null) {
    out.push(`- Indicator data age: ${m.freshness.indicator_age_years} year(s)`);
  }
  if (m.freshness.sector_age_years != null) {
    out.push(`- Sector data age: ${m.freshness.sector_age_years} year(s)`);
  }
  out.push(`- ${m.freshness.note}`);
  out.push('');

  out.push('## Missing data warnings');
  out.push('');
  if (!m.missing_data_warnings.length) {
    out.push('None recorded.');
  } else {
    for (const w of m.missing_data_warnings) out.push(`- ${w}`);
  }
  out.push('');

  return out.join('\n');
}

async function cmdReport(api: Api, args: Args): Promise<number> {
  const country = requireFlag(args.country, 'country');
  console.log(`Building investment report for ${country}...`);
  const res = await runAnalyse(api, country);
  const markdown = buildMarkdown(res.manual);
  const dir = join('data', 'reports');
  ensureDir(dir);
  const out = join(dir, `${country}-${stamp()}.md`);
  writeFileSync(out, markdown, 'utf8');
  console.log(`  wrote ${out}`);
  return 0;
}

async function main(): Promise<void> {
  const args = readArgs();
  if (args.command === 'templates') {
    cmdTemplates();
    return;
  }

  const api = new Api(readConfig());
  let code = 0;
  switch (args.command) {
    case 'validate':
      code = await cmdValidate(api, args);
      break;
    case 'import':
      code = await cmdImport(api, args);
      break;
    case 'analyse':
    case 'analyze':
      code = await cmdAnalyse(api, args);
      break;
    case 'report':
      code = await cmdReport(api, args);
      break;
    default:
      console.error(
        'Unknown command. Use one of: templates, validate, import, analyse, report.',
      );
      code = 1;
  }
  // Set the code and let the loop drain. process.exit() here tears down while
  // sockets are still closing, which on Windows aborts with 0xC0000409 and
  // loses the code entirely: a successful import reports as a crash.
  process.exitCode = code;
}

main().catch((err) => {
  console.error('\nCommand failed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
