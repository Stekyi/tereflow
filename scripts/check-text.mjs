// Fails when a source file holds corrupted text (mojibake), so a garbled dash or quote can never ship again.
// Typical sign: an em dash saved as "a-circumflex, euro sign, right quote" or a letter A with a tilde followed by symbols.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const BAD = /[\u00C3\u00C2][\u0080-\u017F\u0192\u02C6\u02DC\u2013-\u203A\u20AC\u2122\u00A0-\u00BF]|\u00E2[\u20AC\u0080\u0153\u2020]|\uFFFD/;
const EXT = /\.(ts|tsx|json|css|py|md|mjs|html|sql|cmd|txt|plsql)$/;
const files = execSync('git ls-files', { encoding: 'utf8' }).split(/\r?\n/).filter((f) => f && EXT.test(f) && !/(^|\/)(node_modules|dist|generated)\//.test(f));
const hits = [];
for (const f of files) {
  let text;
  try { text = readFileSync(f, 'utf8'); } catch { continue; }
  text.split(/\r?\n/).forEach((line, i) => { if (BAD.test(line)) hits.push(`${f}:${i + 1}`); });
}
if (hits.length) {
  console.error(`Corrupted characters found (${hits.length}). Re-type the character as UTF-8 and save the file as UTF-8:\n  ` + hits.slice(0, 25).join('\n  '));
  process.exit(1);
}
console.log(`text check passed (${files.length} files)`);
