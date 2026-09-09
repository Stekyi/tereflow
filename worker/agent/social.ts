/**
 * Turn an opportunity signal into a social post.
 *
 * The posts go out on Ananse News's accounts, to strangers, under a name that
 * has to stay worth trusting. So the rule here is stricter than anywhere else
 * in the app: a sentence is only written when the stored data supports it
 * exactly. Where it does not, the sentence is left out rather than softened.
 *
 * No language model. Every phrase is assembled from a stated rule, so any claim
 * in a published post can be traced back to a row.
 *
 * The thing being published is the product's actual thesis: a product that is
 * climbing before it is obvious. "Gold is 63% of Ghana's exports" is true and
 * useless, because everybody selling into Ghana already knows it. "Shelled
 * pigeon peas went from rank 34 to rank 13 in three years" is the post somebody
 * can act on.
 */
import type { OpportunitySignal } from '../../shared/types';

export interface SocialPostInput {
  countryName: string;
  countrySlug: string;
  /** Signals for this country, already ordered however the caller likes. */
  signals: SignalWithMarket[];
  /** Where a reader lands. No trailing slash. */
  siteBase: string;
  /** Year the figures describe, for the "as reported" line. */
  year: number | null;
}

/** A stored signal plus the market columns the table carries beyond the shared type. */
export interface SignalWithMarket extends OpportunitySignal {
  value_usd: number | null;
  share: number | null;
  year: number | null;
  best_market: string | null;
  best_market_iso3: string | null;
  /**
   * True when best_market was computed for THIS product. False when it is the
   * country's largest partner across everything, which the keyless Comtrade
   * tier is often all that can be had.
   *
   * This flag is the difference between a true sentence and a false one. Saying
   * "Uganda buys Kenya's pigeon peas" when the data only says "Uganda is
   * Kenya's largest export partner overall" is a fabricated trade relationship,
   * and it would be published to strangers under somebody else's masthead.
   */
  best_market_product_specific: boolean;
}

export interface SocialPost {
  title: string;
  caption: string;
  link: string;
  /** What the post is built from, so a person can check it before it goes out. */
  evidence: string[];
  /** Claims deliberately left out, and why. Shown in the admin preview. */
  omitted: string[];
  signalId: string;
  /** Stable across retries of the same week, so a repeat cannot double-post. */
  dedupeKey: string;
  /**
   * The tariff description the readable label was made from.
   *
   * Shortening these is a heuristic and it will get some wrong. Carrying the
   * original means a reviewer can see at a glance that "Light, fire-floats"
   * came from "Vessels; light, fire-floats", rather than the mistake only
   * being visible once it is public.
   */
  productRaw: string;
  productLabel: string;
}

// A growth rate computed from a very small base is arithmetically true and
// practically meaningless: a product going from 40,000 to 400,000 dollars is
// up 900% and is still nothing. Below this the signal is not worth a post.
const MIN_VALUE_FOR_A_POST = 5_000_000;

// Below this the projection is too shaky to put in front of strangers.
const MIN_CONFIDENCE = 0.5;

// Above this a yearly growth figure reads as a data error to anybody numerate,
// whether or not it is real, and arguing the point is not what a post is for.
const MAX_BELIEVABLE_CAGR = 300;

/**
 * Is this a real product, or a place the statisticians put the leftovers?
 *
 * Tariff schedules end most chapters with a residual line: "not elsewhere
 * classified", "other", a bare item number. Those lines carry real money and
 * can grow fast, so they pass every numeric test in here, but nobody can act on
 * them. "Cameroon: N.e.c. in item no. 2106.10 exports up 194% a year" is a true
 * sentence and a useless post, and it makes the account look automated in the
 * worst way.
 */
export function isResidualCategory(name: string): boolean {
  const s = name.toLowerCase();
  if (/\bn\.?e\.?[cs]\b/.test(s)) return true;
  if (/not elsewhere (classified|specified|included)/.test(s)) return true;
  if (/\bitem no\.?\b|\bheading no\.?\b|\bsubheading\b/.test(s)) return true;
  // A name whose first word is "other" is the residual line of its chapter.
  if (/^other\b/.test(s.trim())) return true;
  return false;
}

/**
 * Pick the signal worth posting, or nothing.
 *
 * Returns null rather than reaching for a weaker story. A week with nothing
 * solid to say is a week that should stay quiet: an account that posts filler
 * to keep a schedule teaches people to scroll past it.
 */
export function buildSocialPost(input: SocialPostInput): SocialPost | null {
  const candidates = input.signals.filter((s) => {
    if (s.flow !== 'export') return false;
    if ((s.value_usd ?? 0) < MIN_VALUE_FOR_A_POST) return false;
    if ((s.confidence ?? 0) < MIN_CONFIDENCE) return false;
    const g = s.cagr_3y;
    if (g == null || g <= 0 || g > MAX_BELIEVABLE_CAGR) return false;
    if (!s.product_name) return false;
    // Checked against the tidied label as well as the original, because the
    // shortening can drop the word that made it recognisable as a residual.
    if (isResidualCategory(s.product_name)) return false;
    if (isResidualCategory(tidyProductName(s.product_name))) return false;
    return true;
  });
  if (!candidates.length) return null;

  // Strongest first: momentum already blends growth, share gained and how
  // steady the climb was, so it is a better pick than raw growth.
  const best = [...candidates].sort(
    (a, b) => b.momentum - a.momentum || (b.value_usd ?? 0) - (a.value_usd ?? 0),
  )[0];

  const evidence: string[] = [];
  const omitted: string[] = [];

  const product = tidyProductName(best.product_name);
  const growth = Math.round(best.cagr_3y ?? 0);
  const value = usd(best.value_usd);
  const year = best.year ?? input.year;

  const title = `${input.countryName}: ${product} exports up ${growth}% a year`;
  evidence.push(`cagr_3y = ${best.cagr_3y?.toFixed(1)}% on signal ${best.id}`);
  evidence.push(`value_usd = ${best.value_usd} (${value})`);

  const lines: string[] = [];
  lines.push(
    `${product} is one of the fastest climbing things ${input.countryName} sells.`,
  );
  lines.push('');
  lines.push(
    `Exports reached ${value}${year ? ` in ${year}` : ''}, growing about ${growth}% a year over three years.`,
  );

  // Rank movement, only when both ends are known. A projection with no starting
  // point is a number with nothing behind it.
  if (best.current_rank != null && best.projected_rank != null && best.projected_rank < best.current_rank) {
    lines.push(
      `It sits at number ${best.current_rank} among the country's exports today. On the current trend it reaches number ${best.projected_rank} within ${best.horizon_years} years.`,
    );
    evidence.push(`rank ${best.current_rank} projected to ${best.projected_rank} over ${best.horizon_years}y`);
  } else if (best.current_rank != null) {
    lines.push(`It sits at number ${best.current_rank} among the country's exports today.`);
    evidence.push(`current_rank = ${best.current_rank}, no projection stored`);
    omitted.push('No projected rank, so no forecast was claimed.');
  }

  // The buyer. Only named when the data is about this product.
  if (best.best_market && best.best_market_product_specific) {
    lines.push(`The largest buyer of it is ${best.best_market}.`);
    evidence.push(`best_market = ${best.best_market}, product specific`);
  } else if (best.best_market) {
    omitted.push(
      `Did not name a buyer. ${best.best_market} is ${input.countryName}'s largest export partner overall, not this product's, and the source does not break partner down by product.`,
    );
  } else {
    omitted.push('No partner data stored for this product, so no buyer was named.');
  }

  if ((best.confidence ?? 0) < 0.7) {
    lines.push('');
    lines.push('Growth is uneven year to year, so treat the direction as the finding rather than the exact number.');
    evidence.push(`confidence = ${best.confidence}`);
  }

  lines.push('');
  // The call to action has to promise what the page actually shows. Every post
  // so far omits the buyer, because the source does not break partner down by
  // product, so "who buys it" would send people to a page that cannot answer
  // the question the post just raised. Promise the buyer only when the data
  // behind it exists.
  lines.push(
    best.best_market && best.best_market_product_specific
      ? `Who buys it, what it fetches and what else is climbing: ${link(input)}`
      : `Trends, partners and what else is climbing in ${input.countryName}: ${link(input)}`,
  );
  lines.push('');
  lines.push(hashtags(input.countryName));

  return {
    title: title.slice(0, 200),
    caption: lines.join('\n'),
    link: link(input),
    evidence,
    omitted,
    signalId: best.id,
    productRaw: best.product_name,
    productLabel: product,
    dedupeKey: `tereflow-${input.countrySlug}-${isoWeek(new Date())}`,
  };
}

/**
 * Is this a link worth showing a stranger?
 *
 * A weekly job running against a misconfigured deployment would otherwise post
 * "http://127.0.0.1:8787/country/kenya" to a real audience, which cannot be
 * unposted. The site base is only right when somebody has set it deliberately.
 */
export function isPublishableLink(url: string): { ok: boolean; reason?: string } {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return { ok: false, reason: `"${url}" is not a valid address.` };
  }
  const host = u.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host === '::1' ||
    /^127\./.test(host) ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith('.local');
  // Checked before the scheme. A development URL fails both tests, and being
  // told to set PUBLIC_SITE_URL is the answer that fixes it; being told to use
  // https sends somebody off to find a certificate for localhost.
  if (isLocal) {
    return { ok: false, reason: `${host} is not reachable from outside this machine. Set PUBLIC_SITE_URL.` };
  }
  if (u.protocol !== 'https:') {
    return { ok: false, reason: 'A published link must be https.' };
  }
  return { ok: true };
}

function link(input: SocialPostInput): string {
  return `${input.siteBase.replace(/\/+$/, '')}/country/${input.countrySlug}`;
}

/**
 * HS descriptions are written for customs officers, not readers.
 *
 * "Vegetables, leguminous; pigeon peas (Cajanus cajan), shelled, whether or not
 * skinned or split, dried" is accurate and unreadable.
 *
 * The semicolon does two different jobs, which is the trap. In "Metals; gold,
 * semi-manufactured" the tail names the product and the head is its category,
 * so the tail is what to keep. In "Coffee; not roasted" the head names the
 * product and the tail only qualifies it, so taking the tail alone produced
 * "Not roasted", which is not a thing anybody exports. Deciding between the two
 * on whether the tail opens with a qualifying word keeps both readable and
 * neither wrong.
 */
export function tidyProductName(raw: string): string {
  let s = raw.trim();
  const semi = s.indexOf(';');
  if (semi > 0 && semi < s.length - 1) {
    const head = s.slice(0, semi).trim();
    const tail = s.slice(semi + 1).trim();
    s = tailNamesTheProduct(tail) ? tail : `${head}, ${tail}`;
  }
  s = s.replace(/\s*\([^)]*\)/g, '');
  s = s.replace(/,?\s*whether or not.*$/i, '');
  s = s.replace(/\s{2,}/g, ' ').replace(/\s*,\s*$/, '').trim();
  const cut = s.split(',').slice(0, 2).join(',').trim();
  const out = cut.length >= 8 ? cut : s;
  return out.charAt(0).toUpperCase() + out.slice(1);
}

/**
 * Does the text after the semicolon name a thing, or only describe one?
 *
 * Words like "not", "live" and "light" cannot begin the name of a product, so a
 * tail starting with one is a qualifier belonging to the head. "Vessels; light,
 * fire-floats" is lightships, and taking the tail alone produced "Light,
 * fire-floats", which names nothing.
 *
 * This is a heuristic and it will not catch every adjective in the tariff. That
 * is why the generated label is returned alongside the original description for
 * review: the fallback for a name this gets wrong is a person seeing both
 * before the post leaves, not a cleverer list.
 */
function tailNamesTheProduct(tail: string): boolean {
  const QUALIFIERS = new Set([
    // Negations and states
    'not', 'non', 'un', 'other', 'others', 'live', 'fresh', 'chilled', 'frozen',
    'dried', 'raw', 'crude', 'refined', 'whole', 'whether', 'containing',
    'prepared', 'preserved', 'unwrought', 'worked', 'unworked', 'used', 'new',
    // Prepositions, which never open a product name
    'in', 'of', 'with', 'without', 'for', 'including', 'excluding', 'than',
    // Plain adjectives that read as nouns to a word list but are not
    'light', 'heavy', 'small', 'large', 'fine', 'coarse', 'ground', 'cut',
    'rough', 'smooth', 'hot', 'cold', 'dry', 'wet', 'flat', 'long', 'short',
    'thick', 'thin', 'soft', 'hard', 'clean', 'plain', 'simple', 'special',
  ]);
  const first = tail.toLowerCase().replace(/^[^a-z]+/, '').split(/[\s,]+/)[0] ?? '';
  return first.length > 0 && !QUALIFIERS.has(first);
}

function usd(v: number | null): string {
  if (v == null || !isFinite(v)) return 'an unreported amount';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)} billion`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)} million`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)} thousand`;
  return `$${v.toFixed(0)}`;
}

/** Kept short and specific. A wall of tags reads as spam and suppresses reach. */
function hashtags(countryName: string): string {
  const country = countryName.replace(/[^A-Za-z]/g, '');
  return `#${country} #Trade #Exports #AfricanBusiness`;
}

/**
 * ISO week, used only to make the dedupe key stable.
 *
 * The weekly job may retry after a timeout, and a retry must not put the same
 * post out twice. Keying on the week rather than the timestamp means a second
 * attempt within the same week collides with the first on purpose.
 */
export function isoWeek(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  // Thursday decides the year an ISO week belongs to.
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((t.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${t.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
