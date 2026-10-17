/** The SQLite -> Oracle translator the application data gateway uses.   npm run test:sql-oracle */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-sql-oracle.mjs';
await build({ entryPoints: ['shared/sql-oracle.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { toOracle, RENAMED_BACK } = await import(`../${OUT}`);
rmSync(OUT);

const T = new Set(['users', 'sessions', 'code_setup', 'manual_payments', 'premium_grants', 'billing_events', 'guide_runs', 'listings', 'bids',
  'subscriptions', 'ratings', 'follows', 'saved_opportunities', 'entities', 'notifications', 'conversations', 'messages', 'feed_items', 'analysis_runs']);
const norm = (s) => s.replace(/\s+/g, ' ').trim();
let passed = 0;
const eq = (label, got, want) => { assert.equal(norm(got), norm(want), label); passed += 1; };

// binds
let r = toOracle('SELECT id FROM users WHERE email = ? AND tier = ?', ['a@b.c', 'free'], T);
eq('plain binds', r.sql, 'SELECT id FROM app_users WHERE email = :b1 AND tier = :b2'); assert.deepEqual(r.binds, ['a@b.c', 'free']);
r = toOracle("UPDATE listings SET current_bid = ?1, current_bidder_id = ?2, updated_at = datetime('now') WHERE id = ?3 AND mode = 'auction' AND ends_at > datetime('now')", [5, 'u', 'l'], T);
assert.match(r.sql, /UPDATE app_listings SET current_bid = :b1, current_bidder_id = :b2, updated_at = TO_CHAR\(SYSTIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'\) WHERE id = :b3 AND mode_ = 'auction'/); passed += 1;
assert.deepEqual(r.binds, [5, 'u', 'l']); passed += 1;
r = toOracle('UPDATE x SET a = ?6, b = ?1, c = ?6 WHERE id = ?2', [1, 2, 3, 4, 5, 6], new Set(['x']));
eq('numbered, repeated', r.sql, 'UPDATE app_x SET a = :b6, b = :b1, c = :b6 WHERE id = :b2'); assert.equal(r.binds.length, 6); passed += 1;
// a question mark inside a string is not a bind
r = toOracle("SELECT id FROM users WHERE full_name = 'who?' AND id = ?", ['u1'], T);
eq('? in string', r.sql, "SELECT id FROM app_users WHERE full_name = 'who?' AND id = :b1");
assert.throws(() => toOracle('SELECT 1 FROM users WHERE id = ? AND x = ?', ['only one'], T), /needs 2 binds/); passed += 1;

// dates
r = toOracle("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?", ['u'], T);
assert.match(r.sql, /^UPDATE app_users SET last_seen_at = TO_CHAR\(SYSTIMESTAMP AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS'\) WHERE id = :b1$/); passed += 1;
r = toOracle("SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n FROM users WHERE julianday('now') - julianday(created_at) <= 30 GROUP BY day", [], T);
assert.match(r.sql, /CAST\(SYSTIMESTAMP AT TIME ZONE 'UTC' AS DATE\) - TO_DATE\(SUBSTR\(created_at, 1, 19\), 'YYYY-MM-DD HH24:MI:SS'\) <= 30/); passed += 1;

// limit
r = toOracle('SELECT id FROM listings WHERE status = ? ORDER BY created_at DESC LIMIT ?', ['open', 25], T);
eq('limit bind', r.sql, 'SELECT id FROM app_listings WHERE status = :b1 ORDER BY created_at DESC FETCH FIRST :b2 ROWS ONLY');
r = toOracle("SELECT id FROM listings WHERE mode = 'auction' AND status = 'open' LIMIT 25", [], T);
eq('limit literal + reserved column', r.sql, "SELECT id FROM app_listings WHERE mode_ = 'auction' AND status = 'open' FETCH FIRST 25 ROWS ONLY");
r = toOracle('SELECT id FROM users ORDER BY created_at LIMIT ? OFFSET ?', [10, 20], T);
eq('limit offset', r.sql, 'SELECT id FROM app_users ORDER BY created_at OFFSET :b2 ROWS FETCH FIRST :b1 ROWS ONLY');

// insert or ignore
r = toOracle('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)', ['a', 'b'], T);
eq('or ignore', r.sql, 'INSERT INTO app_follows (follower_id, followee_id) VALUES (:b1, :b2)'); assert.equal(r.ignoreDup, true); passed += 1;
assert.throws(() => toOracle('INSERT OR REPLACE INTO users (id) VALUES (?)', ['a'], T), /OR REPLACE/); passed += 1;

// upsert -> merge
r = toOracle('INSERT INTO subscriptions (id, user_id, kind, value, label) VALUES (?, ?, ?, ?, ?) ON CONFLICT (user_id, kind, value) DO UPDATE SET label = excluded.label', ['i', 'u', 'k', 'v', 'l'], T);
eq('merge update', r.sql, 'MERGE INTO app_subscriptions t USING (SELECT :b1 AS id, :b2 AS user_id, :b3 AS kind, :b4 AS value, :b5 AS label FROM dual) s ON (t.user_id = s.user_id AND t.kind = s.kind AND t.value = s.value) WHEN MATCHED THEN UPDATE SET t.label = s.label WHEN NOT MATCHED THEN INSERT (id, user_id, kind, value, label) VALUES (s.id, s.user_id, s.kind, s.value, s.label)');
r = toOracle("INSERT INTO ratings (id, rater_id, subject_id, score, created_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT (rater_id, subject_id) DO UPDATE SET score = excluded.score, created_at = datetime('now')", ['i', 'a', 'b', 5], T);
assert.match(r.sql, /WHEN MATCHED THEN UPDATE SET t\.score = s\.score, t\.created_at = TO_CHAR\(SYSTIMESTAMP/); passed += 1;
r = toOracle('INSERT INTO bids (id, listing_id) VALUES (?, ?) ON CONFLICT (id) DO NOTHING', ['a', 'b'], T);
assert.doesNotMatch(r.sql, /WHEN MATCHED/); passed += 1;
assert.throws(() => toOracle('INSERT INTO listings (id, bid_count) VALUES (?, ?) ON CONFLICT (id) DO UPDATE SET bid_count = bid_count + 1', ['a', 1], T), /unsupported expression/); passed += 1;

// aliases, functions
r = toOracle('SELECT u.id, IFNULL(u.full_name, ?) AS name FROM users AS u JOIN sessions AS s ON s.user_id = u.id WHERE s.id = ?', ['x', 's1'], T);
eq('table aliases', r.sql, 'SELECT u.id, NVL(u.full_name, :b1) AS name FROM app_users u JOIN app_sessions s ON s.user_id = u.id WHERE s.id = :b2');
r = toOracle("SELECT json_extract(payload, '$.year') AS y FROM entities", [], T);
assert.match(r.sql, /JSON_VALUE\(payload, '\$\.year'\) AS y FROM app_entities/); passed += 1;

// text that looks like a table name or reserved word stays untouched
r = toOracle("SELECT 'users mode raw' AS s FROM users WHERE id = ?", ['a'], T);
eq('strings untouched', r.sql, "SELECT 'users mode raw' AS s FROM app_users WHERE id = :b1");
r = toOracle('SELECT COUNT(*) AS n FROM messages WHERE user_id = ?', ['a'], T);
eq('plain count', r.sql, 'SELECT COUNT(*) AS n FROM app_messages WHERE user_id = :b1');

// delete, update, insert with a reserved column, in-list
r = toOracle('DELETE FROM sessions WHERE id = ?', ['s'], T); eq('delete', r.sql, 'DELETE FROM app_sessions WHERE id = :b1');
r = toOracle("INSERT INTO analysis_runs (id, trigger, status, started_at) VALUES (?, 'manual', 'ok', datetime('now'))", ['r'], T);
assert.match(r.sql, /^INSERT INTO app_analysis_runs \(id, trigger_, status, started_at\) VALUES \(:b1, 'manual', 'ok', TO_CHAR/); passed += 1;
r = toOracle('UPDATE notifications SET read_at = NULL WHERE user_id = ? AND id IN (?,?,?)', ['u', 1, 2, 3], T);
eq('in list', r.sql, 'UPDATE app_notifications SET read_at = NULL WHERE user_id = :b1 AND id IN (:b2,:b3,:b4)');
assert.equal(RENAMED_BACK.mode_, 'mode'); passed += 1;

console.log(`sql-oracle: ${passed} checks passed`);
