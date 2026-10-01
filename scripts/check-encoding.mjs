import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const roots = ['src', 'worker', 'shared', 'scripts', 'migrations', 'local'];
const extensions = new Set(['.ts', '.tsx', '.js', '.mjs', '.jsx', '.css', '.sql', '.json', '.md', '.html', '.toml', '.yaml', '.yml', '.txt']);
const mojibake = /[\u00C3\u00C2\u00E2\u00F0\u0192]/;
const control = /[\u0080-\u009F]/;
const bad = [];

function walk(dir) {
  for (const name of fs.readdirSync(dir)) {
    const file = path.join(dir, name);
    const stat = fs.statSync(file);
    if (stat.isDirectory()) walk(file);
    else if (extensions.has(path.extname(name).toLowerCase())) {
      const text = fs.readFileSync(file, 'utf8');
      if (mojibake.test(text) || control.test(text)) bad.push(path.relative(root, file));
    }
  }
}

for (const dir of roots) walk(path.join(root, dir));
if (bad.length) {
  console.error('Encoding audit failed. Mojibake/control characters found in:');
  for (const file of bad) console.error(`  ${file}`);
  process.exit(1);
}
console.log(`Encoding audit passed: ${roots.length} source trees checked.`);
