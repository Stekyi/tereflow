// Deploys with the Cloudflare credentials from .env, so a different account set in the shell cannot win.
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const env = { ...process.env };
for (const line of readFileSync(new URL('../.env', import.meta.url), 'utf8').split(/\r?\n/)) {
  const m = /^(CLOUDFLARE_ACCOUNT_ID|CLOUDFLARE_API_TOKEN)=(.*)$/.exec(line);
  if (m) env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const run = (cmd) => spawnSync(cmd, { stdio: 'inherit', shell: true, env }).status ?? 1;
process.exit(run('node scripts/build-toolkits.mjs') || run('npm run build') || run('npx wrangler deploy'));
