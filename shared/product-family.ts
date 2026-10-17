import { disambiguateProductNames, shortProductName } from './product-name';

/**
 * One product, many tariff lines. HS6 splits a single product into bands that differ only in a detail (engine size,
 * fuel, fresh or frozen). Listed as they are, they crowd a product list with near-identical rows. These helpers fold
 * the lines that share an HS4 heading into one family that carries a base name, and keep every line as a member so
 * nothing is hidden: the family opens to show its make-up.
 */

/** Heads that name a whole shelf rather than a product. A family under one of these needs more than the head. */
const SHELF_HEADS = new Set([
  'vehicles', 'fish', 'fruit', 'meat', 'metals', 'minerals', 'nuts', 'oils', 'plants', 'products', 'residues', 'seeds',
  'vegetables', 'animals', 'goods', 'machinery', 'articles', 'apparatus', 'preparations', 'food preparations', 'wood',
  'cereals', 'textiles', 'chemical products', 'waste and scrap',
]);

const DANGLING =
  /[\s,;(]+(not|only|both|over|under|above|below|exceeding|of|to|and|or|with|for|containing|by|the|a|an|in|on|at|from|other|than|including|whether)\s*$/i;

const headOf = (d: string) => {
  const i = d.indexOf(';');
  return (i === -1 ? d : d.slice(0, i)).trim();
};

const dropBrackets = (s: string) => s.replace(/\s*\([^)]*\)/g, '').replace(/\s{2,}/g, ' ').trim();

function sharedPrefix(texts: string[]): string {
  let n = 0;
  const first = texts[0];
  while (n < first.length && texts.every((t) => t[n] === first[n])) n += 1;
  while (n > 0 && !/[\s,;(]/.test(first[n - 1])) n -= 1;
  let shared = first.slice(0, n).trim();
  for (let guard = 0; guard < 8; guard += 1) {
    const stripped = shared.replace(DANGLING, '').replace(/[,;:(\s]+$/, '');
    if (stripped === shared) break;
    shared = stripped;
  }
  return shared;
}

/**
 * The base name for a set of lines under one heading, in the tariff's own wording. Never invents a name: where the
 * lines share nothing that reads as a phrase, the largest line's name stands in with "and variants" after it.
 * `descriptions` must be ordered largest first.
 */
export function familyBaseName(descriptions: (string | null | undefined)[], hs4?: string): string {
  const texts = descriptions.map((d) => (d ?? '').trim()).filter(Boolean);
  if (texts.length === 0) return 'Unclassified';
  if (texts.length === 1) return shortProductName(texts[0]);

  const heads = texts.map(headOf);
  const head = heads[0];
  const cleanHead = dropBrackets(head);
  if (heads.every((h) => h === head) && !SHELF_HEADS.has(cleanHead.toLowerCase()) && cleanHead.length >= 4 && cleanHead.length <= 60) {
    return cleanHead;
  }

  const shared = sharedPrefix(texts);
  if (shared.split(/\s+/).filter(Boolean).length >= 3 && shared.length >= 14) return shortProductName(shared);

  // The lines share only a shelf word ("Vehicles"), so naming the family by one line would misdescribe the rest.
  if (hs4 && heads.every((h) => h === head) && SHELF_HEADS.has(cleanHead.toLowerCase())) return `${cleanHead} (HS ${hs4})`;

  const lead = shortProductName(texts[0]);
  return lead.endsWith('...') ? lead : `${lead}, and variants`;
}

export interface FamilyLine { code: string; description: string | null | undefined; value: number }

export interface FamilyLabelled { hs4: string; name: string; lines: { code: string; name: string; value: number }[] }

/**
 * Names for the families in `groups` (HS4 -> its lines). Two families that come out with the same name get their HS4
 * appended, so two different products are never given one label.
 */
export function nameFamilies(groups: Map<string, FamilyLine[]>): Map<string, FamilyLabelled> {
  const out = new Map<string, FamilyLabelled>();
  for (const [key, lines] of groups) {
    const sorted = [...lines].sort((a, b) => b.value - a.value);
    const hs4 = sorted[0].code.slice(0, 4);
    const labels = disambiguateProductNames(sorted.map((l) => ({ code: l.code, description: l.description })), true);
    out.set(key, {
      hs4,
      name: familyBaseName(sorted.map((l) => l.description), hs4),
      lines: sorted.map((l) => ({ code: l.code, name: labels.get(l.code) || shortProductName(l.description), value: l.value })),
    });
  }
  // Only families listed together can be confused, so a clash is looked for within one scope (a key minus its HS4).
  const byName = new Map<string, FamilyLabelled[]>();
  for (const [key, f] of out) {
    const scope = key.includes('|') ? key.slice(0, key.lastIndexOf('|')) : '';
    const k = `${scope}\u0000${f.name}`;
    byName.set(k, [...(byName.get(k) ?? []), f]);
  }
  for (const clash of byName.values()) {
    if (clash.length > 1) for (const f of clash) if (!f.name.includes('(HS ')) f.name = `${f.name} (HS ${f.hs4})`;
  }
  return out;
}
