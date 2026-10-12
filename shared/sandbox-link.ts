export type SandboxFlow = 'import' | 'export';

export interface SandboxLinkInput {
  primarySlug?: string | null;
  partnerIso3?: string | null;
  hs?: string | null;
  flow?: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO3 = /^[A-Z]{3}$/;
const HS = /^\d{2,10}$/;

/**
 * The one place a Sandbox link is built. Anything that does not validate is
 * dropped rather than passed along, so a bad value can never reach the page; a
 * link with no usable primary country is refused outright.
 */
export function buildSandboxPath(input: SandboxLinkInput): string | null {
  const primary = String(input.primarySlug ?? '').trim().toLowerCase();
  if (!SLUG.test(primary)) return null;
  const params = new URLSearchParams({ primary });
  const partner = String(input.partnerIso3 ?? '').trim().toUpperCase();
  if (ISO3.test(partner)) params.set('partner', partner);
  const hs = String(input.hs ?? '').replace(/[\s.]/g, '');
  if (HS.test(hs)) params.set('hs', hs);
  const flow = String(input.flow ?? '').trim().toLowerCase();
  if (flow === 'import' || flow === 'export') params.set('flow', flow);
  return `/sandbox?${params.toString()}`;
}

/** Where a signed-out reader is sent first; the join page returns them to `target`. */
export function signInThenPath(target: string): string {
  return `/join?next=${encodeURIComponent(target)}`;
}
