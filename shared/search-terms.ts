/**
 * Finding a product when you do not know the tariff's word for it.
 *
 * The tariff is written by customs, not by traders. Somebody looking to export
 * shea butter types "shea butter"; the tariff calls it "Vegetable fats and
 * oils and their fractions; fixed, n.e.c." Somebody looking for solar panels
 * types "solar panel"; the tariff says "photosensitive semiconductor devices,
 * including photovoltaic cells". A search that only matches the tariff's own
 * words fails exactly the people this product is for.
 *
 * THREE DIFFERENT FAILURES, WHICH NEED THREE DIFFERENT ANSWERS
 *
 * 1. Word order and punctuation. "cocoa powder" found nothing because the
 *    tariff writes "Cocoa; powder, not containing added sugar" and a
 *    LIKE '%cocoa powder%' cannot cross the semicolon. Forty-six lines were
 *    sitting there. This is arithmetic, not language: match the words
 *    separately and require all of them.
 *
 * 2. A different word for the same thing. "motorbike" finds nothing;
 *    "Motorcycles" is right there. "solar panel" finds nothing; twenty-four
 *    lines say "photovoltaic". These are dictionary entries, and they are
 *    listed below.
 *
 * 3. A word the tariff does not contain at all. Moringa appears in zero
 *    descriptions. Shea appears in zero, once you discard "sheath
 *    contraceptives", which is what a substring match returns for "shea" and
 *    is a good illustration of why substring matching is not search.
 *
 * The third case is worth being clear about, because it is the one that decides
 * whether a language model helps here. Nothing can find what is not written.
 * Shea butter is filed under a heading whose text is "not elsewhere
 * classified": there is no sentence about shea to be similar to. Retrieval over
 * these descriptions cannot recover it, at any model size, because the
 * information is absent from the corpus rather than hard to reach within it.
 * Only somebody who knows the trade can say that shea butter is 1515.90, and
 * once they have said it the mapping is a line in a table.
 *
 * So these entries are written down, each with the code it points at, rather
 * than inferred. They can be read, corrected, and argued with, which is not
 * true of a number in a weight matrix.
 */

/**
 * What traders call things, and where the tariff files them.
 *
 * Every entry here is a claim about classification that somebody could be wrong
 * about, so each carries the reason it was added. Where a term maps to a code
 * the code is given; where it is only a wording difference, the tariff's own
 * word is given and the ordinary search takes it from there.
 */
export interface SearchTerm {
  /** What somebody types. Lowercase, matched whole-word. */
  query: string;
  /** The tariff's word for it, searched instead. */
  synonyms?: string[];
  /** HS codes this maps to directly, when no wording gets there. */
  codes?: string[];
  /** Why this entry exists. Shown to the reader, so the jump is not silent. */
  note: string;
}

export const SEARCH_TERMS: SearchTerm[] = [
  // --- Things the tariff describes, under another name ---
  {
    query: 'motorbike',
    synonyms: ['motorcycle'],
    note: 'The tariff says motorcycles.',
  },
  { query: 'motorcycle', synonyms: ['motorcycle'], note: 'The tariff says motorcycles.' },
  {
    query: 'solar panel',
    synonyms: ['photovoltaic', 'photosensitive'],
    note: 'Solar panels are filed as photovoltaic cells, under electrical apparatus.',
  },
  {
    query: 'solar',
    synonyms: ['photovoltaic', 'photosensitive'],
    note: 'Solar generation equipment is filed as photovoltaic cells.',
  },
  {
    query: 'mobile phone',
    synonyms: ['telephone', 'cellular'],
    note: 'Filed under telephones for cellular networks.',
  },
  {
    query: 'laptop',
    synonyms: ['automatic data processing', 'portable'],
    note: 'Filed as automatic data processing machines.',
  },
  {
    query: 'computer',
    synonyms: ['automatic data processing'],
    note: 'The tariff says automatic data processing machines.',
  },
  {
    query: 'fridge',
    synonyms: ['refrigerat'],
    note: 'The tariff says refrigerators.',
  },
  {
    query: 'lorry',
    synonyms: ['goods transport', 'motor vehicles for the transport of goods'],
    note: 'Filed as motor vehicles for the transport of goods.',
  },
  {
    query: 'truck',
    synonyms: ['goods transport', 'motor vehicles for the transport of goods', 'dumper'],
    note: 'Filed as motor vehicles for the transport of goods.',
  },
  {
    query: 'petrol',
    synonyms: ['light oils', 'petroleum oils'],
    note: 'Filed as petroleum oils, light oils and preparations.',
  },
  {
    query: 'diesel',
    synonyms: ['petroleum oils', 'gas oils'],
    note: 'Filed under petroleum oils rather than by fuel name.',
  },

  // --- Things the tariff does not name at all, so a code is the only route ---
  {
    query: 'shea butter',
    codes: ['151590'],
    note: 'Shea appears nowhere in the tariff text. It is filed under vegetable fats and oils, not elsewhere classified.',
  },
  { query: 'shea', codes: ['151590'], note: 'Filed under vegetable fats and oils, not elsewhere classified.' },
  {
    query: 'moringa',
    codes: ['121190', '140490'],
    note: 'Moringa appears nowhere in the tariff text. Leaves and seeds are filed under plants used in pharmacy or perfumery; other parts under vegetable products not elsewhere specified.',
  },
  {
    query: 'baobab',
    codes: ['121190', '081340'],
    note: 'Not named in the tariff. Filed under plants used in pharmacy, or under dried fruit.',
  },
  {
    query: 'hibiscus',
    codes: ['121190'],
    note: 'Not named in the tariff. Filed under plants used in pharmacy or perfumery.',
  },
  {
    query: 'tiger nut',
    codes: ['121299'],
    note: 'Not named. Filed under vegetable products used in food preparation, not elsewhere specified.',
  },
  {
    query: 'plantain chips',
    codes: ['200899', '190590'],
    note: 'Not named. Prepared plantain is filed under prepared fruit, or under bakers wares if fried and packaged.',
  },
  {
    query: 'gari',
    codes: ['110620', '190300'],
    note: 'Not named. Cassava flour and tapioca products carry these headings.',
  },
  {
    query: 'cassava',
    synonyms: ['manioc'],
    codes: ['071410'],
    note: 'The tariff says manioc, which is the same root.',
  },
  {
    query: 'groundnut',
    synonyms: ['ground-nut', 'peanut'],
    note: 'The tariff writes ground-nuts with a hyphen.',
  },
  {
    query: 'palm oil',
    synonyms: ['palm oil'],
    codes: ['151110', '151190'],
    note: 'Crude and refined palm oil carry separate headings.',
  },
];

/**
 * Whole-word match, allowing only ordinary English inflection.
 *
 * Plain whole-word matching is too strict: somebody types "vehicle" and the
 * tariff writes "Vehicles". Plain prefix matching is too loose: "shea" is a
 * prefix of "sheath", so a search for shea butter returned sheath
 * contraceptives, above the real answer.
 *
 * So a word matches itself, or itself plus a suffix that is actually a
 * grammatical ending. "vehicles" and "vehicle" are the same word; "sheath" and
 * "shea" are not, because "th" does not inflect anything.
 */
function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}(s|es|ed|ing)?([^a-z]|$)`, 'i').test(haystack);
}

export interface ExpandedQuery {
  /** Words that must all appear, in any order. */
  tokens: string[];
  /** HS codes to include regardless of the text, from the term table. */
  codes: string[];
  /** Shown to the reader when the search went somewhere they did not type. */
  note: string | null;
}

/** Words too common to narrow anything, dropped so they cannot exclude a match. */
const STOP = new Set(['and', 'or', 'the', 'of', 'for', 'with', 'in', 'a', 'an', 'to', 'other']);

/**
 * The words from a query that must be present in a result.
 *
 * Exported so the route and the expansion cannot disagree about it. They did:
 * the expansion dropped "of" while the route kept it, so "oil of palm" required
 * the word "of" to appear in a tariff description and found nothing. One
 * function, one answer.
 */
export function typedWords(raw: string): string[] {
  return raw
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/**
 * Turns what somebody typed into what to search for.
 *
 * Always returns the original words as well as any substitution, so a mapping
 * being wrong makes the search wider rather than empty. An expansion that
 * replaced the query outright would mean one bad table entry hides a product
 * that plain matching would have found.
 */
export function expandQuery(raw: string): ExpandedQuery {
  const query = raw.trim().toLowerCase();
  if (!query) return { tokens: [], codes: [], note: null };

  const notes: string[] = [];
  const codes: string[] = [];
  const synonyms: string[] = [];

  for (const term of SEARCH_TERMS) {
    // Longer entries are phrases: "shea butter" should match before "shea".
    const hit = term.query.includes(' ')
      ? query.includes(term.query)
      : containsWord(query, term.query);
    if (!hit) continue;
    if (term.codes) codes.push(...term.codes);
    if (term.synonyms) synonyms.push(...term.synonyms);
    notes.push(term.note);
  }

  const typed = typedWords(query);

  return {
    // Synonyms are alternatives to the typed words, not extra requirements, so
    // they are kept separate by the caller. Here they are appended and the
    // caller ORs the set.
    tokens: [...new Set([...typed, ...synonyms.map((s) => s.toLowerCase())])],
    codes: [...new Set(codes)],
    // One note, not four. A reader needs to know the search moved, not to read
    // the table.
    note: notes.length ? notes[0] : null,
  };
}

/**
 * How well a description answers the query. Higher is better, 0 is no match.
 *
 * Matching and ranking are the same decision here, because the interesting
 * cases are not match-or-not but which-comes-first.
 *
 * Somebody typing into a search box has not finished typing. "Vehic" should
 * find Vehicles, or the box is useless until the last keystroke. So prefixes
 * match. But a prefix match is also how a search for shea butter returned
 * sheath contraceptives, and that result appeared above the real answer.
 *
 * Excluding prefixes breaks the typeahead. Allowing them unranked puts the
 * wrong answer first. Ranking them below whole words does neither: "shea" still
 * reaches "sheath" if nothing better exists, and never above something that
 * actually contains the word.
 */
export function scoreMatch(description: string, typed: string[], synonyms: string[]): number {
  const text = description.toLowerCase();
  if (typed.length === 0) return 1;

  if (typed.every((t) => containsWord(text, t))) return 3;
  if (synonyms.some((s) => containsPrefix(text, s.toLowerCase()))) return 2;
  // Every typed word begins a word in the description. A partly typed query
  // lands here, and so does an unlucky collision like shea against sheath.
  if (typed.every((t) => containsPrefix(text, t))) return 1;
  return 0;
}

/** Whether a description answers the query at all. */
export function matchesQuery(description: string, typed: string[], synonyms: string[]): boolean {
  return scoreMatch(description, typed, synonyms) > 0;
}

/** A whole word, or a word starting with this stem. */
function containsPrefix(haystack: string, stem: string): boolean {
  const escaped = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z])${escaped}`, 'i').test(haystack);
}
