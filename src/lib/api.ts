import type {
  CountryDashboard,
  Entity,
  EntityInput,
  EntityWithSources,
} from '../../shared/types';

const ADMIN_TOKEN_KEY = 'ta_admin_token';
const TIER_KEY = 'ta_tier';

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
}
export function setAdminToken(token: string) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

/** Phase 1 stand-in for real billing so the premium gate can be demonstrated. */
export function getTier(): 'free' | 'premium' {
  return localStorage.getItem(TIER_KEY) === 'premium' ? 'premium' : 'free';
}
export function setTier(tier: 'free' | 'premium') {
  localStorage.setItem(TIER_KEY, tier);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  headers.set('x-ta-tier', getTier());
  if (path.startsWith('/api/admin')) {
    const token = getAdminToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Server returned non-JSON (${res.status})`);
  }
  if (!res.ok) {
    const msg =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body as T;
}

export interface HomeStats {
  countries: number;
  countries_active: number;
  orgs: number;
  regional: number;
  sources: number;
  facts: number;
  last_run: string | null;
}

export const api = {
  stats: () => req<HomeStats>('/api/stats'),

  entities: (params: Record<string, string | undefined> = {}) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
    const s = qs.toString();
    return req<{ entities: Entity[]; count: number }>(`/api/entities${s ? `?${s}` : ''}`);
  },

  registry: () => req<{ entities: EntityWithSources[]; count: number }>('/api/registry'),

  dashboard: (slug: string) =>
    req<CountryDashboard & { inactive?: boolean; message?: string }>(`/api/dashboard/${slug}`),

  dashboardSources: (slug: string) =>
    req<{ official: EntityWithSources['sources']; harmonised: string[]; note: string }>(
      `/api/dashboard/${slug}/sources`,
    ),

  rankings: (metric: 'export' | 'import') =>
    req<{
      metric: string;
      rows: {
        rank: number;
        slug: string;
        name: string;
        iso3: string;
        continent: string;
        year: number | null;
        value_usd: number;
        balance_usd: number;
      }[];
    }>(`/api/rankings?metric=${metric}`),

  admin: {
    list: (params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
      const s = qs.toString();
      return req<{ entities: EntityWithSources[]; count: number }>(
        `/api/admin/entities${s ? `?${s}` : ''}`,
      );
    },
    get: (slug: string) => req<EntityWithSources>(`/api/admin/entities/${slug}`),
    create: (input: EntityInput) =>
      req<EntityWithSources>('/api/admin/entities', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    update: (slug: string, input: EntityInput) =>
      req<EntityWithSources>(`/api/admin/entities/${slug}`, {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    setActive: (slug: string, is_active: boolean) =>
      req<{ slug: string; is_active: boolean }>(`/api/admin/entities/${slug}/activation`, {
        method: 'PATCH',
        body: JSON.stringify({ is_active }),
      }),
    bulkActive: (slugs: string[], is_active: boolean) =>
      req<{ updated: number }>('/api/admin/entities/activation/bulk', {
        method: 'POST',
        body: JSON.stringify({ slugs, is_active }),
      }),
    remove: (slug: string) =>
      req<{ deleted: boolean }>(`/api/admin/entities/${slug}`, { method: 'DELETE' }),
    runNow: (slug?: string) =>
      req<{ run_id: string; status: string; entities_ok: number; entities_failed: number; errors: { slug: string; error: string }[] }>(
        `/api/admin/runs${slug ? `?slug=${encodeURIComponent(slug)}` : ''}`,
        { method: 'POST' },
      ),
    runs: () =>
      req<{ runs: Record<string, unknown>[] }>('/api/admin/runs'),
    checkLinks: () =>
      req<{ checked: number; ok: number; gated: number; broken: number }>(
        '/api/admin/sources/check',
        { method: 'POST' },
      ),
  },
};
