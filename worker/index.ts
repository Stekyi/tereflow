import { Hono } from 'hono';
import type { Env } from './lib/db';
import { admin } from './routes/admin';
import { pub } from './routes/public';
import { auth } from './routes/auth';
import { network } from './routes/network';
import { social } from './routes/social';
import { market } from './routes/market';
import { discovery } from './routes/discovery';
import { production } from './routes/production';
import { byproducts } from './routes/byproducts';
import { prospect } from './routes/prospect';
import { guide } from './routes/guide';
import { resolve } from './routes/resolve';
import { tariffs } from './routes/tariffs';
import { notifications } from './routes/notifications';
import { premium } from './routes/premium';
import { forecast } from './routes/forecast';
import { media, mediaAdmin } from './routes/media';
import { finance, financeAdmin } from './routes/finance';
import { canvas } from './routes/canvas';
import { national, nationalAdmin } from './routes/national';
import { feedback } from './routes/feedback';
import { portal } from './routes/portal';
import { ghana } from './routes/ghana';
import { serveSnapshot } from './lib/snapshot';
import { oracleConfig } from './lib/oracle';
import { withAppDb } from './lib/oracle-db';
import { bustCache } from './lib/ttl-cache';
import {
  closeOracleBreaker, pingOracle, readHealth, recordHealth,
} from './lib/oracle-health';

const app = new Hono<{ Bindings: Env }>();

/**
 * Baseline response headers.
 *
 * The XSS surface here is already small: React escapes everything and the one
 * markdown renderer builds nodes rather than HTML. These are the cheap
 * defences that matter anyway, in particular framing, which the admin portal
 * needs, and nosniff, which stops a stored string being reinterpreted as a
 * script by content sniffing.
 *
 * The CSP is deliberately not `unsafe-inline` for scripts. It allows inline
 * styles because the UI sets them on elements, and allows data: images for the
 * inline SVG marks.
 */
app.use('*', async (c, next) => {
  await next();
  // Responses fetched from the assets binding (the SPA fallback for a deep link such as /countries)
  // have read-only headers, and setting one throws. Copying the response makes them writable.
  c.res = new Response(c.res.body, c.res);
  const h = c.res.headers;
  h.set('x-content-type-options', 'nosniff');
  h.set('referrer-policy', 'strict-origin-when-cross-origin');
  h.set('x-frame-options', 'DENY');
  h.set('permissions-policy', 'geolocation=(), microphone=(), camera=(), payment=()');
  if (!h.has('content-security-policy')) {
    h.set(
      'content-security-policy',
      [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: https:",
        "connect-src 'self'",
        "font-src 'self' data:",
        "frame-ancestors 'none'",
        "base-uri 'self'",
        "form-action 'self'",
      ].join('; '),
    );
  }
});

app.get('/api/health', async (c) => {
  const oracle = oracleConfig(c.env) ? await readHealth(c.env) : null;
  return c.json({
    ok: true,
    app: c.env.APP_NAME ?? 'Tereflow',
    ts: new Date().toISOString(),
    // The last keep-alive result, read from KV rather than asking Oracle, so this stays cheap and cannot itself hang.
    oracle: oracle ? { ok: oracle.ok, checked_at: oracle.checked_at, ms: oracle.ms, failures: oracle.failures } : null,
  });
});

// Stored snapshots of the heaviest anonymous pages. Mounted ahead of every route so a hit never runs their code. They also
// survive an Oracle outage (they live in KV for two days).
app.use('/api/*', serveSnapshot);

// Mounted before /api/admin so the more specific prefix is matched first and
// route resolution does not depend on the admin router having no catch-all.
app.route('/api/ghana', ghana);
app.route('/api/admin/ghana', ghana);
app.route('/api/admin/portal', portal);
app.route('/api/admin/media', mediaAdmin);
app.route('/api/admin/finance', financeAdmin);
app.route('/api/finance', finance);
app.route('/api/canvas', canvas);
app.route('/api/admin/national', nationalAdmin);
app.route('/api/freshness', national);
app.route('/api/media', media);
app.route('/api/admin', admin);
app.route('/api/auth', auth);
app.route('/api/network', network);
app.route('/api/social', social);
app.route('/api/market', market);
app.route('/api/discovery', discovery);
app.route('/api/production', production);
app.route('/api/byproducts', byproducts);
app.route('/api/prospect', prospect);
app.route('/api/guide', guide);
app.route('/api/resolve', resolve);
app.route('/api/tariffs', tariffs);
app.route('/api/notifications', notifications);
app.route('/api/premium', premium);
app.route('/api/forecast', forecast);
app.route('/api/feedback', feedback);
app.route('/api', pub);

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

/**
 * A body that is not JSON is a bad request, not a server fault.
 *
 * Most handlers call `c.req.json()` without catching, so a non-JSON body threw
 * and came back as a bare 500 "Internal Server Error". That is the wrong status
 * and the wrong story: it reads as the server being broken when the request was
 * malformed, and it is the one error a caller can actually fix. Handled once
 * here so it holds for routes nobody has written yet.
 *
 * Anything else is still a 500, and still says nothing about internals.
 */
app.onError((err, c) => {
  const message = err instanceof Error ? err.message : String(err);
  const isBadJson =
    err instanceof SyntaxError ||
    /JSON|Unexpected token|Unexpected end of/i.test(message);
  if (isBadJson && c.req.path.startsWith('/api/')) {
    return c.json({ error: 'Expected a JSON body.' }, 400);
  }
  console.error('Unhandled error', c.req.method, c.req.path, message);
  // Development only: say what failed, so a broken query is found in one step.
  if (c.env.ALLOW_DEV_TIER_SWITCH === 'true') return c.json({ error: 'Internal Server Error', detail: message.slice(0, 400) }, 500);
  return c.json({ error: 'Internal Server Error' }, 500);
});

/**
 * Hashed build assets must 404 when they are missing.
 *
 * The SPA fallback otherwise returns index.html for any unknown path, so a tab
 * left open across a deploy asks for its old chunk, receives HTML, and dies
 * with "Expected a JavaScript module". A real 404 lets the client detect the
 * stale build and reload instead.
 */
app.get('/assets/*', async (c) => {
  const res = await c.env.ASSETS.fetch(c.req.raw);
  const type = res.headers.get('content-type') ?? '';
  if (type.includes('text/html')) {
    return c.text('Not found', 404);
  }
  return res;
});

// Everything else is the React SPA.
app.get('*', (c) => c.env.ASSETS.fetch(c.req.raw));

export default {
  fetch: async (req, env, ctx) => {
    const res = await app.fetch(req, withAppDb(env), ctx);
    // A write may have changed a setting or classification the memo is holding.
    if (req.method !== 'GET' && req.method !== 'HEAD') bustCache();
    return res;
  },
  /**
   * Keep-alive only. Every few minutes it makes one light ORDS read, so Autonomous Database does not stop from idleness and
   * the first real request is not the one that wakes it, and records whether Oracle answered (read by /api/health).
   * Fetching and analysing still runs on a machine you control; see below.
   */
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const h = await pingOracle(env);
        await recordHealth(env, h);
        if (h.ok) closeOracleBreaker();
      })(),
    );
  },
} satisfies ExportedHandler<Env>;

/**
 * The only scheduled() work is the keep-alive above.
 *
 * Fetching and analysing runs on a machine you control, not on Workers. It
 * pushes finished analysis to /api/admin/ingest/*. See local/pipeline.ts.
 *
 * Two reasons. Workers cap subrequests per invocation, which limited a cloud
 * run to two countries and forced it to rotate; locally the whole registry
 * finishes in one pass. And the heavy work costs nothing on hardware you
 * already own, so the Worker stays on the free tier doing what it is good at,
 * which is serving readers.
 */
