/**
 * classify(): the most specific rule wins, at any prefix length from the exact code down to the chapter.
 *   node scripts/test-classify.mjs
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-classify-test.mjs';
await build({
  stdin: { contents: "export { classify, longestRule } from './worker/lib/classify';", resolveDir: '.', loader: 'ts' },
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node20',
});
const { classify, longestRule } = await import(`./../${OUT}`);

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label} ${detail}`); }
};
const rules = (pairs) => new Map(pairs.map(([code, category]) => [code, { category, entity_id: '*' }]));
const none = new Set();

const r = rules([['27', 'traditional'], ['8411', 'traditional'], ['1801', 'traditional'], ['2523', 'traditional'], ['71', 'traditional'], ['710813', 'non_traditional']]);

check('a chapter rule covers an HS6 line beneath it', classify('270900', r, none) === 'traditional');
check('a heading rule covers an HS6 line beneath it (turbo-jets 841112)', classify('841112', r, none) === 'traditional');
check('a heading rule covers an HS8 line beneath it', classify('84111210', r, none) === 'traditional');
check('a heading rule does not leak to a sibling heading (1803 cocoa paste)', classify('180310', r, none) === 'non_traditional');
check('a heading rule hits its own HS6 (1801 cocoa beans 180100)', classify('180100', r, none) === 'traditional');
check('an exact rule beats its chapter (710813 opened inside traditional 71)', classify('710813', r, none) === 'non_traditional');
check('the rest of the chapter stays traditional', classify('710812', r, none) === 'traditional');
check('no rule means non-traditional', classify('090121', r, none) === 'non_traditional');
check('the dominant-commodity heuristic still applies when no rule exists', classify('090121', r, new Set(['09'])) === 'traditional');
check('a rule beats the heuristic', classify('270900', rules([['2709', 'non_traditional']]), new Set(['27'])) === 'non_traditional');
check('a missing code is non-traditional', classify(null, r, none) === 'non_traditional');
check('longestRule finds the longest prefix', longestRule('84111210', rules([['84', 'a'], ['8411', 'b']]))?.category === 'b');
check('longestRule returns nothing when there is no prefix', longestRule('090121', r) === undefined);

rmSync(OUT);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
