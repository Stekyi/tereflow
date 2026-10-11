import type { Context, Next } from 'hono';
import type { Env } from './db';

/**
 * Ready-made answers for the pages everyone opens first.
 *
 * Building these (the dashboard, the product list, the opportunities feed) takes more CPU than the free Workers plan
 * allows once the isolate is cold, so they are built on the operator's machine by `npm run snapshots`, where there is
 * no such limit, and stored in KV. The Worker only reads them back.
 *
 * Only anonymous readers get a snapshot. A signed-in reader's response depends on their tier (premium signals, blue
 * oceans), so they go through the live route as before. A request with no stored snapshot also goes live, so an
 * empty KV changes nothing about behaviour.
 */
const SESSION = /(?:^|;\s*)tf_session=/;

/** The exact URLs that have snapshots. Anything with other query parameters is a different answer and goes live. */
export function snapshotKey(url: URL): string | null {
  const { pathname: p, searchParams: q } = url;
  const noParams = [...q.keys()].length === 0;
  if (p === '/api/countries' && noParams) return 'snap:/api/countries';
  if (p === '/api/opportunities' && noParams) return 'snap:/api/opportunities';
  if (p === '/api/products' && q.toString() === 'limit=40') return 'snap:/api/products?limit=40';
  const dash = /^\/api\/dashboard\/([a-z0-9-]+)$/.exec(p);
  if (dash && noParams) return `snap:/api/dashboard/${dash[1]}`;
  return null;
}

export async function serveSnapshot(c: Context<{ Bindings: Env }>, next: Next): Promise<Response | void> {
  if (c.req.method !== 'GET' || SESSION.test(c.req.header('cookie') ?? '')) return next();
  const key = snapshotKey(new URL(c.req.url));
  if (!key) return next();
  try {
    const body = await c.env.CACHE.get(key);
    if (body) {
      return new Response(body, {
        headers: {
          'content-type': 'application/json',
          'cache-control': 'public, max-age=300',
          vary: 'Cookie',
          'x-snapshot': 'hit',
        },
      });
    }
  } catch {
    // KV unreachable: the live route is the fallback.
  }
  return next();
}
