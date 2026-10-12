export interface DiscoveryMember {
  card_id: string;
  display_name: string;
  company: string | null;
  country_iso3: string;
  intents: string[];
  /** How it matched: the member lists this HS code or one beneath it, or names the product's sector. */
  matched_on: 'hs_code' | 'sector';
}

export interface DiscoveryListing {
  id: string;
  title: string;
  kind: string;
  country_iso3: string;
  mode: string;
  price_usd: number | null;
}

export interface DiscoveryResult {
  hs: string;
  members: DiscoveryMember[];
  listings: DiscoveryListing[];
  scope: string;
  limitations: string[];
}

const HS = /^\d{2,10}$/;

/** Normalises a code a person typed ("1801.00", " 18 01 ") to digits, or null when it is not one. */
export function cleanCode(raw: unknown): string | null {
  const d = String(raw ?? '').replace(/[\s.]/g, '');
  return HS.test(d) ? d : null;
}

/**
 * True when a member's listed code covers the product: the same code, or a more specific one beneath it,
 * or a broader heading above it. Words ("moringa") never match a code; that would be a guess.
 */
export function codeCovers(listed: string, hs: string): boolean {
  const a = cleanCode(listed);
  const b = cleanCode(hs);
  if (!a || !b) return false;
  return a.startsWith(b) || b.startsWith(a);
}

export const DISCOVERY_SCOPE = 'Members of Tereflow and open Market Square listings only. This is not a register of every company that trades this product.';
export const DISCOVERY_LIMITATIONS = [
  'A member appears only if they published a business card and listed this product code or a heading that contains it.',
  'Tereflow does not verify what members say they trade unless a card is marked verified.',
];
