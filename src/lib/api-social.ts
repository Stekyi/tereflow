async function call<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { accept: 'application/json', ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error((data as { error?: string }).error ?? `Request failed (${res.status})`), { status: res.status, data });
  return data as T;
}

export type ListingKind = 'for_sale' | 'wanted' | 'supplier_request' | 'buyer_request' | 'export_opportunity' | 'partnership' | 'service';

export const LISTING_KINDS: { value: ListingKind; label: string }[] = [
  { value: 'for_sale', label: 'For sale' },
  { value: 'wanted', label: 'Wanted' },
  { value: 'supplier_request', label: 'Supplier request' },
  { value: 'buyer_request', label: 'Buyer request' },
  { value: 'export_opportunity', label: 'Export opportunity' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'service', label: 'Business service' },
];

export interface Listing {
  id: string; owner_id: string | null; is_owner: boolean; i_am_winning: boolean; kind: ListingKind; title: string; description: string;
  hs_code: string; country_iso3: string; price_usd: number | null; mode: 'fixed' | 'auction'; status: 'open' | 'closed' | 'ended';
  start_price: number | null; min_increment: number | null; ends_at: string | null; current_bid: number | null; bid_count: number;
  created_at: string; owner_name: string | null; owner_company: string | null;
}

export interface Notice { id: string; kind: string; ref_id: string; body: string; read_at: string | null; created_at: string }
export interface SavedOpportunity {
  id: string; country_slug: string; partner_iso3: string; hs_code: string; flow: string; title: string; status: string;
  notes: string | null; research_links: string[]; updated_at: string;
}
export interface Post { id: string; author_id: string; body: string; hs_code: string | null; created_at: string; display_name?: string; company?: string | null }

export const SAVED_STATUSES = ['new', 'researching', 'contacted', 'negotiating', 'won', 'dropped'] as const;

const qs = (o: Record<string, string | number | undefined>) =>
  Object.entries(o).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&');

export const market = {
  list: (f: { q?: string; kind?: string; hs?: string; country?: string; mode?: string; status?: string; page?: number }) =>
    call<{ listings: Listing[]; total: number; page: number; limit: number }>(`/api/market/listings?${qs(f)}`),
  mine: () => call<{ listings: Listing[] }>('/api/market/listings/mine'),
  get: (id: string) => call<{ listing: Listing }>(`/api/market/listings/${id}`),
  create: (b: Record<string, unknown>) => call<{ id: string }>('/api/market/listings', 'POST', b),
  close: (id: string) => call<{ updated: true }>(`/api/market/listings/${id}`, 'PATCH', { status: 'closed' }),
  remove: (id: string) => call<{ deleted: true }>(`/api/market/listings/${id}`, 'DELETE'),
  enquire: (id: string, body: string) => call<{ conversation_id: string }>(`/api/market/listings/${id}/enquiries`, 'POST', { body }),
  enquiries: (id: string) => call<{ enquiries: { id: string; body: string; created_at: string; conversation_id: string; from_name: string }[] }>(`/api/market/listings/${id}/enquiries`),
  bid: (id: string, amount: number) => call<{ ok: true; current_bid: number }>(`/api/market/listings/${id}/bids`, 'POST', { amount }),
  bids: (id: string) => call<{ bids: { amount: number; created_at: string; mine: boolean }[] }>(`/api/market/listings/${id}/bids`),
};

export const social = {
  follow: (userId: string) => call<{ following: true }>(`/api/social/follow/${userId}`, 'POST'),
  unfollow: (userId: string) => call<{ following: false }>(`/api/social/follow/${userId}`, 'DELETE'),
  stats: (userId: string) => call<{ followers: number; following: number; posts: number; am_following: boolean }>(`/api/social/profile/${userId}/stats`),
  feed: (before?: string) => call<{ posts: Post[]; next_before: string | null }>(`/api/social/feed${before ? `?before=${encodeURIComponent(before)}` : ''}`),
  post: (body: string, hs_code?: string) => call<{ id: string }>('/api/social/posts', 'POST', { body, hs_code }),
  deletePost: (id: string) => call<{ deleted: true }>(`/api/social/posts/${id}`, 'DELETE'),
  saved: () => call<{ saved: SavedOpportunity[] }>('/api/social/saved'),
  save: (b: { country_slug: string; partner_iso3?: string; hs_code?: string; flow?: string; title: string }) => call<{ id: string }>('/api/social/saved', 'POST', b),
  update: (id: string, b: { status?: string; notes?: string; research_links?: string[] }) => call<{ updated: true }>(`/api/social/saved/${id}`, 'PATCH', b),
  unsave: (id: string) => call<{ deleted: true }>(`/api/social/saved/${id}`, 'DELETE'),
};

export const notices = {
  list: () => call<{ notifications: Notice[]; unread: number }>('/api/notifications'),
  count: () => call<{ notifications: number; messages: number }>('/api/notifications/count'),
  read: (ids?: string[]) => call<{ ok: true }>('/api/notifications/read', 'POST', ids ? { ids } : {}),
};
