import type { Env } from '../lib/db';
import { linkHealth } from '../../shared/types';
import type { SourceFmt } from '../../shared/types';

/**
 * Weekly health check of every registered official link.
 *
 * National statistical portals move, expire their TLS certificates, or quietly
 * die. Surfacing that in the admin table is the difference between a registry
 * that stays true and one that rots.
 */
export async function checkAllLinks(env: Env, limit = 200) {
  const { results } = await env.DB.prepare(
    `SELECT id, url, fmt FROM entity_sources
      ORDER BY COALESCE(last_checked_at, '1970-01-01') ASC
      LIMIT ?`,
  )
    .bind(limit)
    .all<{ id: string; url: string; fmt: SourceFmt }>();

  const sources = results ?? [];
  let ok = 0;
  let gated = 0;
  let broken = 0;
  const updates: D1PreparedStatement[] = [];

  // Small concurrency pool — Workers cap simultaneous subrequests.
  const pool = 8;
  for (let i = 0; i < sources.length; i += pool) {
    const batch = sources.slice(i, i + pool);
    const checked = await Promise.all(batch.map((s) => probe(s.url)));
    checked.forEach((result, idx) => {
      const src = batch[idx];
      const health = linkHealth(result.status, src.fmt);
      if (health === 'ok') ok++;
      else if (health === 'gated') gated++;
      else broken++;
      updates.push(
        env.DB.prepare(
          `UPDATE entity_sources
              SET last_status = ?, last_checked_at = datetime('now'), tls_warning = ?
            WHERE id = ?`,
        ).bind(result.status, result.tls ? 1 : 0, src.id),
      );
    });
  }

  if (updates.length) await env.DB.batch(updates);
  return { checked: sources.length, ok, gated, broken };
}

async function probe(url: string): Promise<{ status: number; tls: boolean }> {
  // HEAD first — cheap. Many statistical portals reject it, so fall back to a
  // ranged GET rather than pulling whole PDFs.
  for (const method of ['HEAD', 'GET'] as const) {
    try {
      const res = await fetch(url, {
        method,
        redirect: 'follow',
        headers: {
          'user-agent': 'Tereflow-LinkCheck/1.0 (+https://tereflow.app)',
          ...(method === 'GET' ? { range: 'bytes=0-2048' } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status !== 405 && res.status !== 501) {
        return { status: res.status, tls: false };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message.toLowerCase() : '';
      const tls = msg.includes('certificate') || msg.includes('ssl') || msg.includes('tls');
      if (method === 'GET') return { status: 0, tls };
    }
  }
  return { status: 0, tls: false };
}
