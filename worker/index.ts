import { Hono } from 'hono';
import type { Env } from './lib/db';
import { admin } from './routes/admin';
import { pub } from './routes/public';
import { auth } from './routes/auth';
import { network } from './routes/network';
import { premium } from './routes/premium';
import { feedback } from './routes/feedback';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({ ok: true, app: c.env.APP_NAME ?? 'Tereflow', ts: new Date().toISOString() }),
);

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
