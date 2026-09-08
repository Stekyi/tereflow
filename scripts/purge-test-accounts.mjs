/**
 * Remove test accounts left behind by earlier e2e runs.
 *   node scripts/purge-test-accounts.mjs           show what would go
 *   node scripts/purge-test-accounts.mjs --commit  actually delete
 *
 * The network suite used to register two people and never close them, so every
 * run added a duplicate to the public directory. It cleans up after itself now;
 * this clears what accumulated before that.
 *
 * Deliberately narrow. It only matches the exact pattern those runs produced,
 * a timestamped @example.com address, so it cannot take a real account with it.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const commit = process.argv.includes('--commit');

const file = readdirSync(ROOT)
  .filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
  .sort((a, b) => b.size - a.size)[0];
if (!file) throw new Error(`No sqlite file under ${ROOT}`);

const db = new DatabaseSync(join(ROOT, file.f));

// The personas the e2e suites register, and nothing else. Each is a name
// followed by a run timestamp, so the pattern cannot match a real address.
const PERSONAS = ['ama', 'kwesi', 'yaw', 'kojo', 'bystander'];
const PATTERN = `(${PERSONAS.map((p) => `email GLOB '${p}[0-9]*@example.com'`).join(' OR ')})`;

const victims = db.prepare(`SELECT id, email, full_name, created_at FROM users WHERE ${PATTERN} ORDER BY created_at`).all();
console.log(`test accounts found: ${victims.length}`);
if (victims.length) {
  console.log(`  oldest: ${victims[0].email}  ${victims[0].created_at}`);
  console.log(`  newest: ${victims[victims.length - 1].email}  ${victims[victims.length - 1].created_at}`);
}

const realUsers = db.prepare(`SELECT COUNT(*) n FROM users WHERE NOT ${PATTERN}`).get().n;
console.log(`accounts that are not this pattern, and will not be touched: ${realUsers}`);

const ids = victims.map((v) => v.id);
const counts = {};
for (const [label, sql] of [
  ['business_cards', 'SELECT COUNT(*) n FROM business_cards WHERE user_id = ?'],
  ['sessions', 'SELECT COUNT(*) n FROM sessions WHERE user_id = ?'],
  ['messages', 'SELECT COUNT(*) n FROM messages WHERE sender_id = ?'],
  ['ratings', 'SELECT COUNT(*) n FROM ratings WHERE rater_id = ?'],
  ['subscriptions', 'SELECT COUNT(*) n FROM subscriptions WHERE user_id = ?'],
]) {
  const stmt = db.prepare(sql);
  counts[label] = ids.reduce((sum, id) => sum + stmt.get(id).n, 0);
}
console.log('rows attached to them:', JSON.stringify(counts));

if (!commit) {
  console.log('\nDry run. Pass --commit to delete.');
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
try {
  let removed = 0;
  for (const id of ids) {
    db.prepare('DELETE FROM ratings WHERE rater_id = ? OR subject_id = ?').run(id, id);
    db.prepare('DELETE FROM messages WHERE sender_id = ?').run(id);
    db.prepare('DELETE FROM subscriptions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM business_cards WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM conversations WHERE a_user_id = ? OR b_user_id = ?').run(id, id);
    removed += db.prepare('DELETE FROM users WHERE id = ?').run(id).changes;
  }
  // Messages whose conversation went with the account that held it.
  db.exec('DELETE FROM messages WHERE conversation_id NOT IN (SELECT id FROM conversations)');
  db.exec('COMMIT');
  console.log(`\ndeleted ${removed} account(s)`);
} catch (err) {
  db.exec('ROLLBACK');
  console.error('rolled back:', err.message);
  process.exitCode = 1;
}

const after = db.prepare('SELECT COUNT(*) n FROM users').get().n;
const cards = db.prepare('SELECT COUNT(*) n FROM business_cards').get().n;
console.log(`users now: ${after}, business cards now: ${cards}`);
db.close();
