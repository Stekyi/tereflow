/**
 * Checks on product search.
 *   node scripts/test-search-terms.mjs
 *
 * The tariff is written by customs, not by traders. Before this, a search for
 * "cocoa powder" returned nothing while forty-six lines sat in the table, and a
 * search for "shea butter" returned nothing at all. Five of eleven ordinary
 * queries found nothing.
 *
 * The tests below separate three failures that look alike from the outside and
 * need completely different answers:
 *
 *   word order      "cocoa powder" against "Cocoa; powder, not containing..."
 *   different word  "motorbike" against "Motorcycles"
 *   no word at all  "moringa", which appears in zero tariff descriptions
 *
 * The third is why this is a table rather than a model. Nothing can retrieve
 * what is not written: shea butter is filed under a heading whose text reads
 * "not elsewhere classified", so there is no sentence about shea to be similar
 * to. Only somebody who knows the trade can say it is 1515.90, and once said it
 * is a line in a table that can be read and corrected.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-search-terms.mjs';
await build({
  entryPoints: ['shared/search-terms.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { expandQuery, matchesQuery, scoreMatch, typedWords, SEARCH_TERMS } = await import(`./../${OUT}`);

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Mirrors how the route splits a query, so the tests exercise the real path. */
function search(query, description) {
  const e = expandQuery(query);
  const typed = typedWords(query);
  const synonyms = e.tokens.filter((t) => !typed.includes(t));
  return matchesQuery(description, typed, synonyms);
}

console.log('\nWords in any order, across the tariff punctuation');
console.log('------------------------------------------------');
{
  // The original failure: a single LIKE '%cocoa powder%' cannot cross the
  // semicolon the tariff puts between the noun and its qualifier.
  const desc = 'Cocoa; powder, not containing added sugar or other sweetening matter';
  check('"cocoa powder" matches "Cocoa; powder"', search('cocoa powder', desc));
  check('and so does the reverse order', search('powder cocoa', desc));
  check('but an absent word still excludes', !search('cocoa vinegar', desc));
}

console.log('\nA different word for the same thing');
console.log('-----------------------------------');
{
  check(
    '"motorbike" reaches "Motorcycles"',
    search('motorbike', 'Motorcycles (including mopeds) and cycles; fitted with an auxiliary motor'),
  );
  check(
    '"solar panel" reaches "photovoltaic"',
    search('solar panel', 'Electrical apparatus; photosensitive, including photovoltaic cells'),
  );
  check(
    '"cassava" reaches "manioc"',
    search('cassava', 'Starch; manioc (cassava) starch'),
  );
  check(
    '"groundnut" reaches the hyphenated form',
    search('groundnut', 'Ground-nuts; other than seed, not roasted or otherwise cooked'),
  );
}

console.log('\nA word the tariff does not contain is mapped, not guessed');
console.log('--------------------------------------------------------');
{
  // These cannot be reached by any amount of text matching, because the text
  // does not mention them. The mapping is the whole answer.
  const shea = expandQuery('shea butter');
  check('shea butter maps to a code', shea.codes.includes('151590'), shea.codes.join(','));
  check('and says why it went there', /nowhere in the tariff/i.test(shea.note ?? ''), shea.note);

  const moringa = expandQuery('moringa');
  check('moringa maps to codes', moringa.codes.length > 0, moringa.codes.join(','));
  check('and explains the jump', (moringa.note ?? '').length > 30, moringa.note);
}

console.log('\nA short query does not outrank itself with a longer word');
console.log('-------------------------------------------------------');
{
  // "shea" is a prefix of "sheath", and a substring match put rubber sheath
  // contraceptives above the real answer. Excluding prefixes outright breaks
  // the typeahead, since "Vehic" has to reach "Vehicles" before somebody has
  // finished typing. So prefixes match, and rank below whole words.
  const real = scoreMatch('Shea nuts and their fractions', ['shea'], []);
  const collision = scoreMatch(
    'Rubber; vulcanised (other than hard rubber), sheath contraceptives',
    ['shea'],
    [],
  );
  check('a whole-word match still wins', real > collision, `${real} vs ${collision}`);
  check('and the collision is not treated as equal', collision < 3, String(collision));

  // The typeahead case that made the ranking necessary.
  check('an unfinished word still finds the product', scoreMatch('Vehicles; with only spark-ignition engine', ['vehic'], []) > 0);
  check('but ranks below the finished one', scoreMatch('Vehicles; with only spark-ignition engine', ['vehic'], []) < scoreMatch('Vehicles; with only spark-ignition engine', ['vehicle'], []));
}

console.log('\nOrdinary plurals still match');
console.log('----------------------------');
{
  // Strict whole-word matching was too tight the other way: the tariff writes
  // "Vehicles" and people type "vehicle".
  check('"vehicle" matches "Vehicles"', search('vehicle', 'Vehicles; with only spark-ignition engine'));
  check('"vehicles" matches "Vehicles"', search('vehicles', 'Vehicles; with only spark-ignition engine'));
  check('"nut" matches "Nuts"', search('nut', 'Nuts, edible; cashew nuts, fresh or dried'));
  check('"oil" matches "oils"', search('oil', 'Petroleum oils and oils from bituminous minerals'));

  // The inflections allowed are grammatical endings only. "th" is not one, or
  // the sheath problem comes straight back.
  check('and an arbitrary ending ranks below a real word', scoreMatch('Cathode ray tubes', ['cat'], []) < 3);
}

console.log('\nAn expansion widens the search, never narrows it');
console.log('-----------------------------------------------');
{
  // If a table entry is wrong, the search should get bigger and include some
  // noise, not smaller and hide the thing plain matching would have found.
  const e = expandQuery('cassava');
  check('the typed word survives expansion', e.tokens.includes('cassava'), e.tokens.join(','));
  check('alongside the tariff word', e.tokens.includes('manioc'), e.tokens.join(','));
  check(
    'and plain matching still works on the typed word',
    search('cassava', 'Cassava chips, dried'),
  );
}

console.log('\nThe reader is told when the search moved');
console.log('---------------------------------------');
{
  // Landing on "Vegetable fats and oils, n.e.c." for "shea butter" looks like a
  // wrong result unless something says why it is the right one.
  check('a mapped query carries a note', expandQuery('shea butter').note !== null);
  check('a synonym query carries a note', expandQuery('motorbike').note !== null);
  check('an ordinary query does not', expandQuery('cashew').note === null, String(expandQuery('cashew').note));
  check('and neither does an empty one', expandQuery('').note === null);
}

console.log('\nCommon words do not exclude a match');
console.log('-----------------------------------');
{
  // Requiring every typed word means a stop word can empty a result set.
  check(
    '"oil of palm" still finds palm oil',
    search('oil of palm', 'Palm oil and its fractions; crude'),
  );
  check(
    '"nuts and fruit" still matches',
    search('nuts and fruit', 'Fruit, edible; nuts, fresh or dried'),
  );
}

console.log('\nEvery table entry is answerable for itself');
console.log('-----------------------------------------');
{
  // These are classification claims somebody could be wrong about, so each has
  // to carry its reasoning and point somewhere real.
  check('every entry has a note', SEARCH_TERMS.every((t) => t.note && t.note.length > 10));
  check(
    'every entry does something',
    SEARCH_TERMS.every((t) => (t.synonyms?.length ?? 0) > 0 || (t.codes?.length ?? 0) > 0),
  );
  check(
    'every mapped code is a valid HS6',
    SEARCH_TERMS.flatMap((t) => t.codes ?? []).every((c) => /^\d{6}$/.test(c)),
    SEARCH_TERMS.flatMap((t) => t.codes ?? []).filter((c) => !/^\d{6}$/.test(c)).join(',') || 'all valid',
  );
  check('queries are lowercase, since matching is', SEARCH_TERMS.every((t) => t.query === t.query.toLowerCase()));
  const queries = SEARCH_TERMS.map((t) => t.query);
  check('and none is listed twice', new Set(queries).size === queries.length);
}

console.log('\nAn empty query is not a match-everything');
console.log('---------------------------------------');
{
  const e = expandQuery('   ');
  check('no tokens', e.tokens.length === 0);
  check('no codes', e.codes.length === 0);
  // matchesQuery with no typed words returns true by design: the route uses
  // that path for the unfiltered browse list, which is a different request.
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
