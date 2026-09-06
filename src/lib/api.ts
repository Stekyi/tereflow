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
  FeedbackInput,
  FeedbackKind,
  FeedItem,
  MarketHsCode,
  MarketProducts,
  Message,
  Plan,
  ProductBreakdown,
  ProductCard,
  ProductDetail,
  ProductInsight,
  ProductSummary,
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
  // The admin bearer is attached for the admin API surface. The feedback inbox
  // (GET and PATCH /api/feedback) is also admin gated on the worker but does not
  // sit under /api/admin, so it is included here. The public POST to submit
  // feedback carries the header only when the owner happens to have a token
  // stored, which the worker ignores, so nothing changes for normal senders.
  if (path.startsWith('/api/admin') || path.startsWith('/api/feedback')) {
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

// Portal read-side shapes. These mirror worker/routes/portal.ts one to one.
// Kept here so the sections stay typed without re-deriving them each time.
export interface PortalCounts {
  countries: number;
  countries_active: number;
  orgs: number;
  regional: number;
  sources: number;
  facts: number;
  signals: number;
  users: number;
  premium_users: number;
  cards: number;
  messages: number;
  ratings: number;
  subscriptions: number;
  playbooks: number;
  feedback_new: number;
}

export interface PortalRun {
  id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  entities_total?: number;
  entities_ok: number;
  entities_failed: number;
  entities_skipped: number;
  facts_written: number | null;
}

export interface PortalOverview {
  counts: PortalCounts;
  last_run: PortalRun | null;
  attention: {
    active_never_run: number;
    stale_over_14_days: number;
    countries_with_errors: { slug: string; name: string; last_error: string }[];
    dead_links: number;
    feedback_new: number;
  };
  link_health: { ok: number; gated: number; dead: number; unknown: number };
}

export interface PortalCountryRow {
  slug: string;
  name: string;
  iso3: string | null;
  continent: string | null;
  is_active: number;
  coverage_score: number | null;
  last_ingest_at: string | null;
  last_checked_at: string | null;
  last_error: string | null;
  signals: number;
  facts: number;
}

export interface PortalUser {
  id: string;
  email: string;
  full_name: string | null;
  country_iso3: string | null;
  role: string;
  tier: string;
  tier_expires_at: string | null;
  email_verified: number;
  created_at: string;
  last_seen_at: string | null;
  cards: number;
  follows: number;
}

export interface PortalCard {
  id: string;
  display_name: string;
  company: string | null;
  headline: string | null;
  country_iso3: string | null;
  is_published: number;
  is_verified: number;
  rating_avg: number | null;
  rating_count: number;
  created_at: string;
  owner_email: string | null;
  owner_name: string | null;
}

export interface PortalRating {
  id: string;
  score: number;
  comment: string | null;
  dealt_in: string | null;
  created_at: string;
  rated_headline: string | null;
  rated_name: string | null;
  rater_name: string | null;
}

export interface PortalBillingEvent {
  id: string;
  kind: string;
  provider: string | null;
  plan: string | null;
  amount_minor: number | null;
  currency: string | null;
  period_end: string | null;
  created_at: string;
  user_email: string | null;
}

export interface PortalSource {
  id: string;
  url: string;
  label: string | null;
  category: string;
  slot: number;
  fmt: string;
  last_status: number | null;
  last_checked_at: string | null;
  tls_warning: number;
  slug: string;
  entity_name: string;
  kind: string;
  is_active: number;
}

export interface PortalPlaybook {
  slug: string;
  title: string;
  sector: string | null;
  country_iso3: string | null;
  hs_code: string | null;
  premium_only: number;
  reading_minutes: number | null;
  published_at: string | null;
  updated_at: string | null;
  body_chars: number | null;
}

export interface PortalSetup {
  config: { key: string; set: boolean; why: string; required: boolean }[];
  db: { facts?: number; results?: number; migrations?: number };
  notes: string[];
}

export interface PortalSetting {
  code: string;
  name: string;
  description: string | null;
  value: string;
  default_value: string;
  kind: string;
  category: string;
  updated_at: string | null;
  /** True when somebody has moved this off what the code shipped with. */
  changed: boolean;
}

export interface PortalConfig {
  settings: PortalSetting[];
  categories: string[];
  note: string;
}

export type SourceHealth = 'ok' | 'gated' | 'dead' | 'unknown';

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
      /** Counts within_budget across every match, not just the page shown. */
      budget?: number;
    } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set('q', params.q);
    if (params.flow) qs.set('flow', params.flow);
    if (params.continent) qs.set('continent', params.continent);
    if (params.country) qs.set('country', params.country);
    if (params.all) qs.set('all', '1');
    if (params.limit) qs.set('limit', String(params.limit));
    if (params.budget) qs.set('budget', String(params.budget));
    const s = qs.toString();
    return req<{ products: ProductCard[]; count: number; summary: ProductSummary }>(
      `/api/products${s ? `?${s}` : ''}`,
    );
  },

  /** One product, everywhere it is traded. Backs the product modal. */
  product: (hs: string) => req<ProductDetail>(`/api/products/${encodeURIComponent(hs)}`),

  /**
   * The precomputed read of one product: prices, ranked buyers and sellers,
   * where demand is growing, and who else is following it.
   *
   * `country` scopes the headline figures to one market without changing the
   * lists, which is what lets the same modal serve a global tap and a tap from
   * inside a country page.
   */
  insight: (hs: string, country?: string, flow?: 'export' | 'import') => {
    const qs = new URLSearchParams();
    if (country) qs.set('country', country);
    if (flow) qs.set('flow', flow);
    const s = qs.toString();
    return req<ProductInsight>(`/api/insight/${encodeURIComponent(hs)}${s ? `?${s}` : ''}`);
  },

  /** Countries index: summary figures only, no product lists. */
  countries: (params: { continent?: string; q?: string } = {}) => {
    const qs = new URLSearchParams();
    if (params.continent) qs.set('continent', params.continent);
    if (params.q) qs.set('q', params.q);
    const s = qs.toString();
    return req<{ countries: CountrySummary[]; count: number }>(`/api/countries${s ? `?${s}` : ''}`);
  },

  /** Open to signed-out visitors on purpose. See worker/routes/feedback.ts. */
  sendFeedback: (input: FeedbackInput) =>
    req<{ received: true }>('/api/feedback', {
      method: 'POST',
      body: JSON.stringify(input),
    }),

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
    rebuildFeeds: () =>
      req<{
        run_id: string;
        status: string;
        feed: { subscribers: number; subscriptions: number; items_written: number };
        feedError: string | null;
        note: string;
      }>('/api/admin/runs', { method: 'POST' }),

    feedback: (status?: string) =>
      req<{
        feedback: {
          id: string;
          kind: FeedbackKind;
          message: string;
          path: string | null;
          contact: string | null;
          status: string;
          created_at: string;
          user_name: string | null;
          user_email: string | null;
        }[];
        count: number;
      }>(`/api/feedback${status ? `?status=${status}` : ''}`),

    setFeedbackStatus: (id: string, status: 'new' | 'read' | 'done') =>
      req<{ updated: true }>(`/api/feedback/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
    }),
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

  // Read-only aggregates for the owner portal. Every path sits under
  // /api/admin so req() attaches the admin bearer automatically.
  portal: {
    overview: () => req<PortalOverview>('/api/admin/portal/overview'),
    pipeline: () =>
      req<{ runs: PortalRun[]; countries: PortalCountryRow[] }>('/api/admin/portal/pipeline'),
    users: (q?: string) =>
      req<{
        users: PortalUser[];
        by_tier: { tier: string; n: number }[];
        signups_by_day: { day: string; n: number }[];
      }>(`/api/admin/portal/users${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    network: () =>
      req<{
        cards: PortalCard[];
        activity: { conversations: number; messages: number; messages_7d: number; ratings: number };
        recent_ratings: PortalRating[];
      }>('/api/admin/portal/network'),
    premium: () =>
      req<{
        by_kind: { kind: string; n: number }[];
        top_followed: { kind: string; value: string; label: string | null; followers: number }[];
        feed: { items: number; unread: number; premium_items: number };
        billing: PortalBillingEvent[];
      }>('/api/admin/portal/premium'),
    sources: (health?: SourceHealth) =>
      req<{ sources: PortalSource[]; count: number }>(
        `/api/admin/portal/sources${health ? `?health=${health}` : ''}`,
      ),
    content: () => req<{ playbooks: PortalPlaybook[] }>('/api/admin/portal/content'),
    setup: () => req<PortalSetup>('/api/admin/portal/setup'),
    config: () => req<PortalConfig>('/api/admin/portal/config'),
    setConfig: (code: string, value: string) =>
      req<{ code: string; value: string; reverted: boolean }>(
        `/api/admin/portal/config/${encodeURIComponent(code)}`,
        { method: 'PUT', body: JSON.stringify({ value }) },
      ),
    resetConfig: (code: string) =>
      req<{ code: string; value: string }>(
        `/api/admin/portal/config/${encodeURIComponent(code)}/reset`,
        { method: 'POST' },
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
    /** Close the account and remove the data. Needs the current password. */
    close: (password: string) =>
      req<{ closed: true }>('/api/auth/close', {
        method: 'POST',
        body: JSON.stringify({ password }),
      }),
  },

  network: {
    myCard: () => req<{ card: BusinessCard | null }>('/api/network/cards/me'),
    saveCard: (input: BusinessCardInput) =>
      req<{ card: BusinessCard }>('/api/network/cards/me', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    /** Remove your own card. Unpublishing hides it; this removes the row. */
    deleteCard: () =>
      req<{ deleted: true }>('/api/network/cards/me', { method: 'DELETE' }),
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
