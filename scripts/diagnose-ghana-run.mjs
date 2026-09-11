/**
 * Where does a full Ghana run actually stop?
 *
 * The full run exited with status 0 and no error after writing nothing, which
 * is the least useful failure there is. This walks the chapters one at a time
 * and prints progress, so the point of failure is visible rather than inferred.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-diag.mjs';
await build({
  entryPoints: ['scripts/entry-ghana-pipeline.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { GhanaStatBankProvider, GHANA } = await import(`./../${OUT}`);

const provider = new GhanaStatBankProvider();
const meta = await (await fetch(GHANA.provider.endpoint, { signal: AbortSignal.timeout(30_000) })).json();
const chapters = meta.variables
  .find((v) => v.code === GHANA.provider.dimensions.product)
  .values.filter((v) => v !== GHANA.provider.values.all_products);

console.log(`${chapters.length} chapters, ${GHANA.partners.length} partners, ${GHANA.years.length} years`);

let totalObs = 0;
let totalBytes = 0;
const started = Date.now();

for (let i = 0; i < chapters.length; i++) {
  const code = chapters[i].match(/^\s*(\d{1,2})\s*-/)?.[1]?.padStart(2, '0') ?? '??';
  const t = Date.now();
  try {
    const r = await provider.fetchObservations({
      config: GHANA,
      flow: 'import',
      years: GHANA.years,
      partners: GHANA.partners,
      products: [code],
    });
    const bytes = r.raw.reduce((s, x) => s + x.body.length, 0);
    totalObs += r.observations.length;
    totalBytes += bytes;
    const heap = (process.memoryUsage().heapUsed / 1e6).toFixed(0);
    console.log(
      `${String(i + 1).padStart(2)}/${chapters.length} HS${code}  ` +
      `${String(r.observations.length).padStart(4)} obs  ` +
      `${(bytes / 1024).toFixed(0).padStart(5)}KB  ` +
      `${((Date.now() - t) / 1000).toFixed(1)}s  heap ${heap}MB` +
      (r.ok ? '' : `  NOT OK: ${r.error}`),
    );
  } catch (err) {
    console.log(`${String(i + 1).padStart(2)}/${chapters.length} HS${code}  THREW: ${err instanceof Error ? err.message : String(err)}`);
  }
}

console.log(
  `\ndone in ${((Date.now() - started) / 1000 / 60).toFixed(1)} min, ` +
  `${totalObs} observations, ${(totalBytes / 1e6).toFixed(1)}MB of responses`,
);
rmSync(OUT, { force: true });
