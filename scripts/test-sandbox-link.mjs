/** Invariants for the Sandbox deep link builder.   npm run test:sandbox-link */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-sandbox-link.mjs';
await build({ entryPoints: ['shared/sandbox-link.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { buildSandboxPath, signInThenPath } = await import(`../${OUT}`);
rmSync(OUT);

const q = (path) => Object.fromEntries(new URL(path, 'https://x').searchParams);

// country mapping: every field lands in the right parameter
assert.deepEqual(q(buildSandboxPath({ primarySlug: 'ghana', partnerIso3: 'nld', hs: '1801.00', flow: 'Export' })),
  { primary: 'ghana', partner: 'NLD', hs: '180100', flow: 'export' });
assert.deepEqual(q(buildSandboxPath({ primarySlug: 'united-kingdom', partnerIso3: 'USA', flow: 'import' })),
  { primary: 'united-kingdom', partner: 'USA', flow: 'import' });

// invalid inputs: no primary, or a malformed one, is refused; bad optional values are dropped
assert.equal(buildSandboxPath({}), null);
assert.equal(buildSandboxPath({ primarySlug: '../admin' }), null);
assert.equal(buildSandboxPath({ primarySlug: 'ghana&x=1' }), null);
assert.deepEqual(q(buildSandboxPath({ primarySlug: 'ghana', partnerIso3: 'NLDX', hs: 'abc', flow: 'sideways' })), { primary: 'ghana' });
assert.deepEqual(q(buildSandboxPath({ primarySlug: 'ghana', partnerIso3: '<script>' })), { primary: 'ghana' });

// signed-out: the link is wrapped in the join page and survives as one encoded value
const target = buildSandboxPath({ primarySlug: 'ghana', partnerIso3: 'NLD', hs: '180100', flow: 'export' });
const wrapped = signInThenPath(target);
assert.ok(wrapped.startsWith('/join?next='));
assert.equal(new URL(wrapped, 'https://x').searchParams.get('next'), target);

console.log('sandbox-link: all checks passed');
