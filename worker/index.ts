import { Hono } from 'hono';
import type { Env } from './lib/db';
import { admin } from './routes/admin';
import { pub } from './routes/public';
import { auth } from './routes/auth';
import { network } from './routes/network';
import { premium } from './routes/premium';

const app = new Hono<{ Bindings: Env }>();

app.get('/api/health', (c) =>
  c.json({ ok: true, app: c.env.APP_NAME ?? 'Tereflow', ts: new Date().toISOString() }),
);

app.route('/api/admin', admin);
app.route('/api/auth', auth);
app.route('/api/network', network);
app.route('/api/premium', premium);
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

  /**
   * Friday 21:00 UTC. Re-reads the sources for every activated country,
   * rebuilds the analysis the dashboards sit on, and health-checks the
   * registered official links.
   */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(
      (async () => {
        const { runAnalysis } = await import('./agent/run');
        const { checkAllLinks } = await import('./agent/linkcheck');
        const result = await runAnalysis(env, 'cron');
        console.log('[cron] analysis', JSON.stringify(result));
        const links = await checkAllLinks(env, 120);
        console.log('[cron] linkcheck', JSON.stringify(links));
      })(),
    );
  },
} satisfies ExportedHandler<Env>;
