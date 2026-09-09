/**
 * The weekly social post.
 *
 *   npm run social:weekly -- --dry-run
 *   npm run social:weekly -- --country ghana
 *   npm run social:weekly
 *
 * Meant for a scheduler. Friday evening was the intention, but nothing here
 * depends on the day: the dedupe key is the ISO week, so a run that fires
 * twice, or is retried after a timeout, cannot put the same country's post out
 * twice.
 *
 * One country per run by default, rotating. Posting eleven countries at once
 * would empty the whole week's material into one evening and read as a bot.
 */
import { loadEnv } from './build.mjs';

loadEnv();

const API = process.env.TEREFLOW_API_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TEREFLOW_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? '';

const args = process.argv.slice(2);
const flag = (name) => args.includes(`--${name}`);
const value = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = flag('dry-run');
const only = value('country');
const wanted = Number(value('count') ?? 1);

if (!TOKEN) {
  console.error(
    'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.\n' +
      'It must match the ADMIN_TOKEN secret on the Worker.',
  );
  process.exitCode = 1;
}

async function call(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  // No keep-alive: a pooled socket outliving the work aborts the process on
  // Windows after a run that actually succeeded.
  headers.set('connection', 'close');
  const res = await fetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(30_000) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  return { status: res.status, body };
}

/**
 * Countries worth trying, most recently analysed first.
 *
 * A country with no signals produces nothing, which is correct but wastes the
 * slot, so the list is filtered before anything is posted rather than after.
 */
async function candidates() {
  if (only) return [only];
  const { status, body } = await call('/api/countries');
  if (status !== 200) throw new Error(`Could not list countries: HTTP ${status}`);
  const rows = body?.countries ?? body?.items ?? body ?? [];
  return rows
    .filter((c) => c.is_active && c.opportunities != null && c.opportunities > 0)
    .map((c) => c.slug);
}

async function main() {
  if (!TOKEN) return;
  const slugs = await candidates();
  if (!slugs.length) {
    console.log('No country has opportunity signals yet. Nothing to post.');
    return;
  }

  console.log(`${slugs.length} candidate countr${slugs.length === 1 ? 'y' : 'ies'}.`);
  let sent = 0;
  const skipped = [];

  for (const slug of slugs) {
    if (sent >= wanted) break;

    const preview = await call(`/api/admin/social/preview?slug=${encodeURIComponent(slug)}`);
    if (preview.status !== 200 || !preview.body?.post) {
      skipped.push(`${slug}: ${preview.body?.reason ?? `HTTP ${preview.status}`}`);
      continue;
    }

    const post = preview.body.post;
    console.log(`\n${slug}`);
    console.log(`  ${post.title}`);
    console.log(`  from: ${post.productRaw.slice(0, 90)}${post.productRaw.length > 90 ? '...' : ''}`);
    for (const e of post.evidence) console.log(`  evidence: ${e}`);
    for (const o of post.omitted) console.log(`  left out: ${o}`);

    if (dryRun) {
      console.log('  dry run, nothing sent');
      sent += 1;
      continue;
    }

    const res = await call('/api/admin/social/publish', {
      method: 'POST',
      body: JSON.stringify({ slug }),
    });
    if (res.status === 200 && res.body?.ok) {
      const queued = res.body.response?.queued ?? [];
      const dup = res.body.response?.duplicate;
      console.log(
        dup
          ? `  already queued this week, nothing added`
          : `  queued on ${queued.length} platform(s): ${queued.map((q) => q.platform).join(', ')}`,
      );
      for (const s of res.body.response?.skipped ?? []) {
        console.log(`  not queued on ${s.platform}: ${s.reason}`);
      }
      sent += 1;
    } else {
      // A failure to publish is not a reason to stop: the next country may be
      // fine, and a run that gives up on the first problem posts nothing all
      // week for a reason nobody sees until Monday.
      skipped.push(`${slug}: ${res.body?.error ?? `HTTP ${res.status}`}`);
    }
  }

  if (skipped.length) {
    console.log('\nSkipped:');
    for (const s of skipped) console.log(`  ${s}`);
  }
  if (sent === 0) {
    console.log('\nNothing was posted.');
    // Not an error exit. A quiet week is a legitimate outcome and a scheduler
    // that alerts on it would train somebody to ignore the alert.
  }
}

main().catch((err) => {
  console.error('\nFailed:', err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
