/** Invariants for company-discovery matching.   npm run test:discovery */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-discovery.mjs';
await build({ entryPoints: ['shared/discovery.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { codeCovers, cleanCode } = await import(`../${OUT}`);
rmSync(OUT);

// same code, more specific, and broader all match
assert.equal(codeCovers('1801', '180100'), true);        // member lists the heading
assert.equal(codeCovers('18010010', '180100'), true);    // member lists a finer line
assert.equal(codeCovers('180100', '180100'), true);
assert.equal(codeCovers('18', '180100'), true);          // chapter

// different product never matches, even with a shared first digit
assert.equal(codeCovers('1802', '180100'), false);
assert.equal(codeCovers('2204', '180100'), false);

// words are never treated as codes
assert.equal(codeCovers('moringa', '121190'), false);
assert.equal(codeCovers('', '121190'), false);
assert.equal(codeCovers('1211', 'abc'), false);

// typed formats are cleaned, and junk is refused
assert.equal(cleanCode('1801.00'), '180100');
assert.equal(cleanCode(' 18 01 '), '1801');
assert.equal(cleanCode('18a'), null);
assert.equal(cleanCode('1'), null);
assert.equal(cleanCode(null), null);
assert.equal(codeCovers('1801.00', '180100'), true);

console.log('discovery: all checks passed');
