/**
 * Short-lived memo for settings-like reads that change rarely but are read on nearly every request.
 * Each Oracle round trip from a Worker costs several hundred milliseconds, so collapsing repeat
 * reads is the cheapest speed-up there is.
 *
 * Two tiers: the isolate's own memory, then the data centre's shared edge cache, so a read one
 * visitor paid for is free for the next even when they land on a different isolate. Concurrent
 * callers share one read, and a failure is never remembered. Writers call bustCache() so the
 * data centre that took the write sees it at once; others catch up within the TTL.
 */
const store = new Map<string, { at: number; value: Promise<unknown> }>();
const edgeKeys = new Set<string>();
const TTL_MS = 30_000;

function edgeCache(): Cache | null {
  try {
    return (globalThis as unknown as { caches?: { default?: Cache } }).caches?.default ?? null;
  } catch {
    return null;
  }
}

const edgeRequest = (key: string) => new Request(`https://memo.invalid/${encodeURIComponent(key)}`);

/** `load` must return JSON-safe data: it is serialised into the edge cache. */
export function cached<T>(key: string, load: () => Promise<T>, ttlMs = TTL_MS): Promise<T> {
  const hit = store.get(key);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.value as Promise<T>;

  const value = (async () => {
    const edge = edgeCache();
    if (edge) {
      try {
        const res = await edge.match(edgeRequest(key));
        if (res) return ((await res.json()) as { v: T }).v;
      } catch {
        // Fall through to a real read.
      }
    }
    const fresh = await load();
    if (edge) {
      edgeKeys.add(key);
      edge
        .put(edgeRequest(key), new Response(JSON.stringify({ v: fresh }), { headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${Math.ceil(ttlMs / 1000)}` } }))
        .catch(() => undefined);
    }
    return fresh;
  })();

  store.set(key, { at: now, value });
  value.catch(() => {
    if (store.get(key)?.value === value) store.delete(key);
  });
  return value;
}

export function bustCache(prefix = ''): void {
  for (const k of store.keys()) if (k.startsWith(prefix)) store.delete(k);
  const edge = edgeCache();
  if (!edge) return;
  for (const k of edgeKeys) {
    if (k.startsWith(prefix)) {
      edge.delete(edgeRequest(k)).catch(() => undefined);
      edgeKeys.delete(k);
    }
  }
}
