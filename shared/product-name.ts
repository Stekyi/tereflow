/**
 * HS6 descriptions are legal text, not product names. Comtrade returns things
 * like:
 *
 *   "Fruit, edible; guavas, mangoes and mangosteens, fresh or dried"
 *   "Metals; gold, non-monetary, unwrought (but not powder)"
 *   "Trailers and semi-trailers; n.e.c. in item no. 8716.3"
 *
 * An SME reading a list of openings needs "Mangoes, guavas & mangosteens", not
 * the tariff wording. This shortens for display only. The raw description is
 * always kept alongside and shown in the product detail, because the shortened
 * form is a heuristic and the original is the thing that is actually true.
 *
 * Applied at read time rather than at ingest, so changing these rules never
 * requires re-running the pipeline against the live APIs.
 */

/** Target length. Long enough to stay specific, short enough to scan a list. */
const MAX_LEN = 58;

/**
 * Heads that are pure shelving, not the product. When the head is one of
 * these the detail after the semicolon carries all the meaning, so the head is
 * dropped ("Metals; gold, unwrought" reads as "Gold, unwrought").
 */
const GENERIC_HEADS = new Set([
  'animals',
  'chemical products',
  'commodities',
  'fish',
  'food preparations',
  'fruit',
  'goods',
  'meat',
  'metals',
  'minerals',
  'nuts',
  'oils',
  'plants',
  'products',
  'residues',
  'seeds',
  'vegetables',
  'waste and scrap',
]);

/**
 * A detail clause opening with one of these is bookkeeping or a restriction,
 * not a product ("Footwear; n.e.c. in heading no. 6402, covering the ankle").
 * These are dropped clause by clause rather than discarding the whole detail,
 * so what survives still separates one line from its neighbours.
 */
const QUALIFIER_OPENERS = [
  'n.e.c',
  'nes',
  'other than',
  'not elsewhere',
  'as specified in',
  'in heading',
  'in item',
  'in subheading',
  'in chapter',
];

/** Clauses starting with a bare conjunction only make sense after the clause
 *  they were attached to, so they go once that clause has been dropped. */
const CONJUNCTION_OPENERS = ['but ', 'and ', 'or ', 'but,', 'including '];

/** Trailing noise that adds nothing once the name is already specific.
 *  Deliberately does not strip "knitted or crocheted": for textiles that is
 *  the difference between two genuinely different products, not decoration. */
const TRAILING_NOISE = [
  /,?\s*n\.e\.c\.?\s*$/i,
  /,?\s*not elsewhere specified\s*$/i,
  /,?\s*whether or not [^,]*$/i,
  /,?\s*\(but not [^)]*\)$/i,
  /,?\s*(n\.e\.c\.?\s*)?in (heading|item|chapter|subheadings?)\s*(no\.?\s*)?[\d.]*\s*$/i,
  /,?\s*as specified in subheading note[^,]*$/i,
];

/**
 * The same bookkeeping also appears mid-description ("Wood, tropical, n.e.c.
 * in item no. 4407.2, sawn or chipped...") where dropping only a trailing
 * match would take the real detail with it. Anchored to a comma or semicolon
 * so it never eats a following clause.
 */
const INLINE_NOISE = [
  /([,;])\s*n\.e\.c\.?\s+in\s+(item|heading|chapter|subheading)[^,;]*/gi,
  /([,;])\s*as specified in subheading note[^,;]*/gi,
  /([,;])\s*not elsewhere specified[^,;]*/gi,
];

function stripNoise(text: string): string {
  let out = text;
  // Keeps the delimiter it matched on so the clause structure survives.
  for (const re of INLINE_NOISE) out = out.replace(re, '$1');
  // Applied repeatedly: a description can carry several of these at once,
  // and removing one can expose the next.
  for (let pass = 0; pass < 3; pass++) {
    const before = out;
    for (const re of TRAILING_NOISE) out = out.replace(re, '');
    out = out.replace(/\s*\([^)]*\)\s*$/, '').trim();
    out = out.replace(/[;,.\s]+$/, '').trim();
    if (out === before) break;
  }
  return out;
}

function startsWithQualifier(text: string): boolean {
  const lower = text.trim().toLowerCase();
  return QUALIFIER_OPENERS.some((q) => lower.startsWith(q));
}

/**
 * Splits the detail into comma clauses and drops the leading ones that are
 * only bookkeeping, plus any conjunction clause left dangling behind them.
 * Stops at the first clause that stands on its own, so the distinguishing
 * detail is kept:
 *
 *   "n.e.c. in heading no. 6402, covering the ankle, ..." -> "covering the ankle, ..."
 *   "other than whole, but including butts, of bovine animals" -> "of bovine animals"
 *
 * Brackets are respected so "(e.g. cider, perry)" is never split mid-list.
 */
function dropLeadingQualifiers(detail: string): string {
  const clauses: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of detail) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    if (ch === ',' && depth === 0) {
      clauses.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  clauses.push(current);

  let i = 0;
  while (i < clauses.length) {
    const clause = clauses[i].trim();
    const lower = clause.toLowerCase();
    const isQualifier = startsWithQualifier(clause);
    // A conjunction clause is only dropped when something was dropped before
    // it, otherwise "Rum and other spirits" would lose its own second half.
    const isOrphanConjunction = i > 0 && CONJUNCTION_OPENERS.some((c) => lower.startsWith(c));
    if (!isQualifier && !(isOrphanConjunction && i > 0 && startsWithQualifier(clauses[0]))) break;
    i++;
  }

  return clauses.slice(i).join(',').trim().replace(/^[,;\s]+/, '');
}

/**
 * Heads written adjective-last ("Fruit, edible", "Cocoa, powdered") are
 * categories rather than products, same as GENERIC_HEADS.
 */
function isCategoryHead(head: string): boolean {
  const bare = head.trim().toLowerCase();
  if (GENERIC_HEADS.has(bare)) return true;
  const [noun, ...rest] = bare.split(',');
  return rest.length > 0 && GENERIC_HEADS.has(noun.trim());
}

/** Cut to the length budget at a clause or word boundary, never mid-word. */
function clip(text: string, max: number): string {
  if (text.length <= max) return balanceBrackets(text);

  // Prefer to end on a complete clause.
  const commaCut = text.lastIndexOf(', ', max);
  if (commaCut > max * 0.55) return balanceBrackets(text.slice(0, commaCut));

  const spaceCut = text.lastIndexOf(' ', max);
  const cut = balanceBrackets(text.slice(0, spaceCut > 0 ? spaceCut : max).replace(/[,;\s]+$/, ''));
  return `${cut}...`;
}

/** Clipping can leave an opening bracket with no partner ("handbags ("). */
function balanceBrackets(text: string): string {
  let out = text;
  while ((out.match(/\(/g)?.length ?? 0) > (out.match(/\)/g)?.length ?? 0)) {
    out = out.slice(0, out.lastIndexOf('(')).replace(/[,;\s]+$/, '');
  }
  return out.trim();
}

function upperFirst(text: string): string {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/**
 * Lowercases the joining word so "Cocoa" + "Butter" reads as "Cocoa butter",
 * but leaves acronyms alone: "DC, of an output..." must not become "dC".
 */
function lowerFirstWord(text: string): string {
  const firstWord = text.split(/[\s,;(]/, 1)[0];
  const isAcronym = firstWord.length > 1 && firstWord === firstWord.toUpperCase();
  return isAcronym ? text : text[0].toLowerCase() + text.slice(1);
}

/**
 * A short, scannable display name for one product.
 *
 * Never invents a name it cannot derive: if the description does not match any
 * known shape it is simply clipped, and the caller still holds the original.
 */
export function shortProductName(description: string | null | undefined): string {
  const raw = (description ?? '').trim();
  if (!raw) return 'Unclassified';

  const semi = raw.indexOf(';');
  if (semi === -1) return clip(stripNoise(raw) || raw, MAX_LEN);

  const head = raw.slice(0, semi).trim();
  // Qualifier clauses are dropped before noise-stripping: stripping first can
  // remove the "n.e.c. in heading 6403" marker that identifies the clause,
  // leaving the trailing patterns to swallow the detail that follows it.
  const detail = stripNoise(dropLeadingQualifiers(raw.slice(semi + 1).trim()));

  // Nothing left after the bookkeeping was removed: the head is the name.
  if (!detail) return clip(stripNoise(head) || head, MAX_LEN);

  const merged = isCategoryHead(head)
    ? upperFirst(detail)
    : // "Cocoa" + "butter, fat and oil" -> "Cocoa butter, fat and oil".
      `${head} ${lowerFirstWord(detail)}`;

  return clip(merged, MAX_LEN);
}

/**
 * True when shortening actually changed the text, so the UI knows whether
 * showing the original underneath tells the reader anything new.
 */
export function hasLongerDescription(description: string | null | undefined): boolean {
  const raw = (description ?? '').trim();
  return Boolean(raw) && shortProductName(raw) !== raw;
}
