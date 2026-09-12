import type { D1Database } from '@cloudflare/workers-types';
import { disambiguateProductNames, shortProductName } from '../../shared/product-name';
import { hs2Sector } from '../agent/codes';

/**
 * Product families: the same trade, split by the tariff into bands.
 *
 * HS6 divides one product into lines that differ by a detail. Ghana's motor car
 * imports are fourteen separate codes under 8703, separated by engine size and
 * fuel. A chart of the top twelve lines spends four of its slots on vehicles
 * and still shows less than two thirds of what the country actually buys in
 * that family.
 *
 * THIS IS COMPUTED FROM THE WHOLE DATASET, NOT FROM THE TOP TWELVE
 *
 * The obvious shortcut is to group the ranked list the page already has. That
 * is wrong in a way that looks right: summing the four vehicle lines that made
 * the top twelve gives roughly $1,079m and labels it as the family, when the
 * fourteen lines together are $1,652m. A third of the trade would go missing
 * behind a number presented as a total. So the grouping runs over every line,
 * and the count of members is stated so a reader can see how much was folded in.
 *
 * Families are not merged with each other and their members are not discarded.
 * A market for engines under 1000cc is a different business from one over
 * 3000cc; the grouping is a way to see the shape first and the detail second,
 * not a claim that the detail does not matter.
 */

export interface FamilyMember {
  code: string;
  name: string;
  value_usd: number;
  /** Share of this family, not of the country's trade. */
  share_of_family_pct: number;
}

export interface ProductFamily {
  /** The HS4 heading these lines share. */
  code: string;
  /** Derived from what the members' descriptions share, not from a lookup. */
  name: string;
  sector: string;
  value_usd: number;
  share_pct: number;
  /** How many HS6 lines were folded in. 1 means nothing was grouped. */
  line_count: number;
  members: FamilyMember[];
}

export interface FamilyBreakdown {
  families: ProductFamily[];
  year: number;
  /**
   * Total across the HS6 lines only. NOT the country's import or export total.
   * See `coverage_note`.
   */
  total_usd: number;
  /** The country's whole trade for this flow and year, from the chapter rows. */
  country_total_usd: number | null;
  /**
   * Stated because the two totals differ. A country files most of its trade at
   * chapter level and only part of it broken down to HS6, so shares here are of
   * the detailed portion rather than of everything.
   */
  coverage_note: string | null;
}

interface Row {
  hs_code: string;
  product_name: string | null;
  value_usd: number;
}

/** Words that cannot end a heading: they only mean something attached to what follows. */
const DANGLING =
  /[\s,;(]+(not|only|both|over|under|above|below|exceeding|of|to|and|or|with|for|containing|by|the|a|an|in|on|at|from|other|than)\s*$/i;

/**
 * The family name, taken from what its members already say.
 *
 * There is no HS4 description table here, and inventing one would mean writing
 * product names this codebase made up and presenting them as classifications.
 * The members' shared opening words are the heading, in the tariff's own
 * language.
 *
 * The shared run is only usable when it is a phrase. Two vehicle headings share
 * "Vehicles; with only" and stop there, which is a fragment, not a name: it
 * reads as though somebody's sentence was cut off. Where the shared run does
 * not survive cleanup as something a person would say, the largest member's own
 * description stands in. It is narrower than the family it labels, but it is
 * specific and it is still the tariff's wording rather than this codebase's.
 */
function familyName(members: Row[]): string {
  const fallback = () => shortProductName(members[0]?.product_name);
  if (members.length === 1) return fallback();

  const texts = members.map((m) => (m.product_name ?? '').trim()).filter(Boolean);
  if (texts.length < 2) return shortProductName(texts[0] ?? null);

  let n = 0;
  const first = texts[0];
  while (n < first.length && texts.every((t) => t[n] === first[n])) n += 1;
  // Never cut inside a word: "cylinder capacity over 150" is a different
  // number from 1500 and would read as a real one.
  while (n > 0 && !/[\s,;(]/.test(first[n - 1])) n -= 1;

  let shared = first.slice(0, n).trim();
  // Strip repeatedly: "with only" needs two passes, and one pass would leave
  // "Vehicles; with".
  for (let guard = 0; guard < 6; guard += 1) {
    const stripped = shared.replace(DANGLING, '').replace(/[,;:(\s]+$/, '');
    if (stripped === shared) break;
    shared = stripped;
  }

  // A heading has to be a phrase, not a category word. "Vehicles" is shared by
  // motor cars and by dumper trucks, and labelling either of them with it
  // says nothing that distinguishes the two.
  const words = shared.split(/\s+/).filter(Boolean);
  if (words.length < 3 || shared.length < 14) return fallback();

  return shortProductName(shared);
}

export async function loadProductFamilies(
  db: D1Database,
  entityId: string,
  flow: 'import' | 'export',
  limit = 12,
): Promise<FamilyBreakdown | null> {
  const latest = await db
    .prepare(
      `SELECT MAX(year) AS year FROM trade_facts
        WHERE entity_id = ?1 AND flow = ?2 AND stream = 'goods' AND partner_iso3 IS NULL`,
    )
    .bind(entityId, flow)
    .first<{ year: number | null }>();

  const year = latest?.year;
  if (!year) return null;

  const { results } = await db
    .prepare(
      `SELECT hs_code, product_name, value_usd
         FROM trade_facts
        WHERE entity_id = ?1 AND flow = ?2 AND stream = 'goods'
          AND partner_iso3 IS NULL AND year = ?3
          AND value_usd > 0
          AND LENGTH(hs_code) = 6`,
    )
    .bind(entityId, flow, year)
    .all<Row>();

  const rows = results ?? [];
  if (rows.length === 0) return null;

  // The same trade sits in this table at three levels: a single country total,
  // ninety-odd chapter rows, and the HS6 lines. Summing across them triple
  // counts, which is how a $20bn trade first came out as $54bn here. Only the
  // HS6 rows are read above; the chapter rows are read separately, as the
  // denominator they actually are.
  const chapterTotal = await db
    .prepare(
      `SELECT SUM(value_usd) AS total FROM trade_facts
        WHERE entity_id = ?1 AND flow = ?2 AND stream = 'goods'
          AND partner_iso3 IS NULL AND year = ?3 AND LENGTH(hs_code) = 2`,
    )
    .bind(entityId, flow, year)
    .first<{ total: number | null }>();

  const groups = new Map<string, Row[]>();
  let total = 0;

  for (const r of rows) {
    total += r.value_usd;
    const hs4 = r.hs_code.slice(0, 4);
    const list = groups.get(hs4);
    if (list) list.push(r);
    else groups.set(hs4, [r]);
  }

  const families: ProductFamily[] = [];
  for (const [code, members] of groups) {
    const value = members.reduce((a, m) => a + m.value_usd, 0);
    const sorted = [...members].sort((a, b) => b.value_usd - a.value_usd);
    // Members of one family are, by construction, the lines most likely to
    // shorten to the same text: they share a heading and differ only in the
    // tail. Listing four rows all reading "Vehicles with only spark-ignition..."
    // would recreate inside the family exactly the collision the grouping was
    // built to remove.
    const labels = disambiguateProductNames(
      sorted.map((m) => ({ code: m.hs_code, description: m.product_name })),
    );
    families.push({
      code,
      name: familyName(sorted),
      sector: hs2Sector(code.slice(0, 2)),
      value_usd: value,
      share_pct: total > 0 ? (value / total) * 100 : 0,
      line_count: members.length,
      members: sorted.map((m) => ({
        code: m.hs_code,
        name: labels.get(m.hs_code) ?? shortProductName(m.product_name),
        value_usd: m.value_usd,
        share_of_family_pct: value > 0 ? (m.value_usd / value) * 100 : 0,
      })),
    });
  }

  families.sort((a, b) => b.value_usd - a.value_usd);

  // Two families can share a heading. HS 8703 and 8704 both begin "Vehicles;"
  // and everything distinguishing them sits after the semicolon, so both came
  // out as "Vehicles" and the grouping recreated the collision it was built to
  // remove. Where that happens the largest member's own description stands in,
  // since it is at least specific and is still the tariff's wording.
  const seen = new Map<string, ProductFamily[]>();
  for (const f of families) {
    const list = seen.get(f.name);
    if (list) list.push(f);
    else seen.set(f.name, [f]);
  }
  for (const [, clash] of seen) {
    if (clash.length < 2) continue;
    for (const f of clash) {
      const biggest = f.members[0];
      f.name = biggest && biggest.name !== f.name ? biggest.name : `${f.name} (HS ${f.code})`;
    }
  }

  const countryTotal = chapterTotal?.total ?? null;
  // Only worth saying when the two genuinely differ. Where a country files
  // everything at HS6 the note would be noise.
  const shortfall = countryTotal != null ? countryTotal - total : 0;
  const coverageNote =
    countryTotal != null && shortfall > countryTotal * 0.02
      ? `These families cover ${fmtBn(total)} of the ${fmtBn(countryTotal)} filed for ${year}. ` +
        `The rest is reported only at chapter level and is not broken down into product lines, so ` +
        `shares here are of the detailed portion.`
      : null;

  return {
    families: families.slice(0, limit),
    year,
    total_usd: total,
    country_total_usd: countryTotal,
    coverage_note: coverageNote,
  };
}

function fmtBn(n: number): string {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}bn`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(0)}m`;
  return `$${Math.round(n).toLocaleString()}`;
}
