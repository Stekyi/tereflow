import type {
  BusinessCard,
  BusinessCardInput,
  ConversationSummary,
  CountryDashboard,
  CountrySummary,
  Entity,
  EntityInput,
  EntityWithSources,
  ExploreOpportunity,
  ExportCategory,
  FeedItem,
  MarketHsCode,
  MarketProducts,
  Message,
  Plan,
  ProductBreakdown,
  ProductCard,
  ProductDetail,
  Playbook,
  PlaybookSummary,
  Rating,
  ResolvedClassification,
  SessionUser,
  Subscription,
  SubscriptionKind,
} from '../../shared/types';

const ADMIN_TOKEN_KEY = 'tf_admin_token';

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? '';
}
export function setAdminToken(token: string) {
  if (token) localStorage.setItem(ADMIN_TOKEN_KEY, token);
  else localStorage.removeItem(ADMIN_TOKEN_KEY);
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  if (init.body) headers.set('content-type', 'application/json');
  if (path.startsWith('/api/admin')) {
    const token = getAdminToken();
    if (token) headers.set('authorization', `Bearer ${token}`);
  }

  const res = await fetch(path, { ...init, headers, credentials: 'same-origin' });
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

  productBreakdown: (slug: string, flow: 'export' | 'import', hsCode: string) =>
    req<ProductBreakdown>(
      `/api/dashboard/${encodeURIComponent(slug)}/products/${flow}/${encodeURIComponent(hsCode)}`,
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

  opportunities: () =>
    req<{ opportunities: ExploreOpportunity[]; count: number }>('/api/opportunities'),

  /** Specific product lines across every activated country. The app's front door. */
  products: (
    params: {
      q?: string;
      flow?: 'export' | 'import';
      continent?: string;
      country?: string;
      all?: boolean;
      limit?: number;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.flow) qs.set('flow', params.flow);
    if (params.continent) qs.set('continent', params.continent);
    if (params.country) qs.set('country', params.country);
    if (params.all) qs.set('all', '1');
    if (params.limit) qs.set('limit', String(params.limit));
    const s = qs.toString();
    return req<{ products: ProductCard[]; count: number }>(`/api/products${s ? `?${s}` : ''}`);
  },

  /** One product, everywhere it is traded. Backs the product modal. */
  product: (hs: string) => req<ProductDetail>(`/api/products/${encodeURIComponent(hs)}`),

  /** Countries index: summary figures only, no product lists. */
  countries: (params: { continent?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.continent) qs.set('continent', params.continent);
    if (params.q) qs.set('q', params.q);
    const s = qs.toString();
    return req<{ countries: CountrySummary[]; count: number }>(`/api/countries${s ? `?${s}` : ''}`);
  },

  market: {
    hsCodes: (q?: string, includeTraditional?: boolean) => {
      const qs = new URLSearchParams();
      if (q) qs.set('q', q);
      if (includeTraditional) qs.set('all', '1');
      const s = qs.toString();
      return req<{ codes: MarketHsCode[] }>(`/api/market/hs-codes${s ? `?${s}` : ''}`);
    },
    products: (hs: string) =>
      req<MarketProducts>(`/api/market/products?hs=${encodeURIComponent(hs)}`),
  },

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
    /** Rebuilds subscriber feeds from stored signals. Does not refetch source
     *  data: that runs on the operator's machine via `npm run pipeline`. */
    runNow: () =>
      req<{
        run_id: string;
        status: string;
        feed: { subscribers: number; subscriptions: number; items_written: number };
        feedError: string | null;
        note: string;
      }>('/api/admin/runs', { method: 'POST' }),
    runs: () =>
      req<{ runs: Record<string, unknown>[] }>('/api/admin/runs'),
    checkLinks: () =>
      req<{ checked: number; ok: number; gated: number; broken: number }>(
        '/api/admin/sources/check',
        { method: 'POST' },
      ),
    classifications: (entity = '*') =>
      req<{ entity_id: string; rows: ResolvedClassification[] }>(
        `/api/admin/classifications?entity=${encodeURIComponent(entity)}`,
      ),
    setClassification: (input: {
      entity?: string;
      hs_code: string;
      category: ExportCategory;
      note?: string | null;
      source_url?: string | null;
      source_label?: string | null;
    }) =>
      req<{ ok: true }>('/api/admin/classifications', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    clearClassification: (entity: string, hsCode: string) =>
      req<{ ok: true }>(
        `/api/admin/classifications?entity=${encodeURIComponent(entity)}&hs_code=${encodeURIComponent(hsCode)}`,
        { method: 'DELETE' },
      ),
  },

  auth: {
    me: () =>
      req<{
        user: SessionUser | null;
        entitled?: boolean;
        has_card?: boolean;
        card_published?: boolean;
        unread?: number;
        feed_unread?: number;
        subscriptions?: number;
      }>('/api/auth/me'),
    register: (input: {
      email: string;
      password: string;
      full_name: string;
      country_iso3?: string;
    }) =>
      req<{ user: SessionUser }>('/api/auth/register', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    login: (input: { email: string; password: string }) =>
      req<{ user: SessionUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    logout: () => req<{ ok: true }>('/api/auth/logout', { method: 'POST' }),
    setTier: (tier: 'free' | 'premium') =>
      req<{ tier: string }>('/api/auth/tier', { method: 'POST', body: JSON.stringify({ tier }) }),
  },

  network: {
    myCard: () => req<{ card: BusinessCard | null }>('/api/network/cards/me'),
    saveCard: (input: BusinessCardInput) =>
      req<{ card: BusinessCard }>('/api/network/cards/me', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    discover: (params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
      const s = qs.toString();
      return req<{ cards: BusinessCard[]; count: number }>(
        `/api/network/cards${s ? `?${s}` : ''}`,
      );
    },
    card: (id: string) =>
      req<{ card: BusinessCard; ratings: Rating[] }>(`/api/network/cards/${id}`),
    startConversation: (input: { to_user_id: string; subject?: string; body?: string }) =>
      req<{ conversation_id: string }>('/api/network/conversations', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    conversations: () =>
      req<{ conversations: ConversationSummary[] }>('/api/network/conversations'),
    messages: (id: string) =>
      req<{ messages: Message[]; other: { id: string; name: string; company: string | null } }>(
        `/api/network/conversations/${id}/messages`,
      ),
    send: (id: string, body: string) =>
      req<{ message: Message }>(`/api/network/conversations/${id}/messages`, {
        method: 'POST',
        body: JSON.stringify({ body }),
      }),
    rate: (input: { subject_id: string; score: number; dealt_in?: string; comment?: string }) =>
      req<{ ok: true }>('/api/network/ratings', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
  },

  premium: {
    subscriptions: () => req<{ subscriptions: Subscription[] }>('/api/premium/subscriptions'),
    follow: (input: { kind: SubscriptionKind; value: string; label?: string }) =>
      req<{ ok: true }>('/api/premium/subscriptions', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    unfollow: (id: string) =>
      req<{ deleted: true }>(`/api/premium/subscriptions/${id}`, { method: 'DELETE' }),

    feed: () =>
      req<{ items: FeedItem[]; unread: number; entitled: boolean; locked_count: number }>(
        '/api/premium/feed',
      ),
    markRead: (id?: string) =>
      req<{ ok: true }>('/api/premium/feed/read', {
        method: 'POST',
        body: JSON.stringify(id ? { id } : {}),
      }),

    playbooks: (params: Record<string, string | undefined> = {}) => {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(params)) if (v) qs.set(k, v);
      const s = qs.toString();
      return req<{ playbooks: PlaybookSummary[]; entitled: boolean }>(
        `/api/premium/playbooks${s ? `?${s}` : ''}`,
      );
    },
    playbook: (slug: string) =>
      req<{ playbook: Playbook; entitled: boolean }>(`/api/premium/playbooks/${slug}`),

    plans: () => req<{ plans: Plan[]; provider: string }>('/api/premium/billing/plans'),
    checkout: (plan: string) =>
      req<{
        provider: string;
        checkout_url?: string;
        activated?: boolean;
        period_end?: string;
        note?: string;
      }>('/api/premium/billing/checkout', { method: 'POST', body: JSON.stringify({ plan }) }),
    cancel: () => req<{ tier: string }>('/api/premium/billing/cancel', { method: 'POST' }),
    history: () =>
      req<{
        events: Record<string, unknown>[];
        tier: string;
        tier_expires_at: string | null;
        entitled: boolean;
      }>('/api/premium/billing/history'),
  },
};
