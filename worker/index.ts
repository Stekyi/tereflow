import { Hono } from 'hono';
import type { Env } from './lib/db';
import { admin } from './routes/admin';
import { pub } from './routes/public';
import { auth } from './routes/auth';
import { network } from './routes/network';
import { premium } from './routes/premium';
import { feedback } from './routes/feedback';
import { portal } from './routes/portal';

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

app.get('/api/health', (c) =>
  c.json({ ok: true, app: c.env.APP_NAME ?? 'Tereflow', ts: new Date().toISOString() }),
);

// Mounted before /api/admin so the more specific prefix is matched first and
// route resolution does not depend on the admin router having no catch-all.
app.route('/api/admin/portal', portal);
app.route('/api/admin', admin);
app.route('/api/auth', auth);
app.route('/api/network', network);
app.route('/api/premium', premium);
app.route('/api/feedback', feedback);
app.route('/api', pub);

app.all('/api/*', (c) => c.json({ error: 'Not found' }, 404));

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
  fetch: app.fetch,
} satisfies ExportedHandler<Env>;

/**
 * There is deliberately no scheduled() handler.
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
