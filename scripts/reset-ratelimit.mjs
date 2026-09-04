/**
 * Clear local rate-limit state before an end-to-end run.
 *
 * Best effort by design. Miniflare holds the KV files open while `wrangler dev`
 * is running, so on Windows the delete fails with EPERM. That is not a reason
 * to abort the test run: the limits are set high enough that a normal run does
 * not throttle itself, and this only matters when someone runs the suites
 * several times in quick succession.
 */
import { rmSync } from 'node:fs';

const KV = '.wrangler/state/v3/kv';

try {
  rmSync(KV, { recursive: true, force: true });
  console.log('Rate-limit state cleared.');
} catch (err) {
  if (err.code === 'EPERM' || err.code === 'EBUSY') {
    console.log(
      'Could not clear rate-limit state because the dev server holds it open. ' +
        'Continuing. Stop `wrangler dev` first if a run reports 429s.',
    );
  } else {
    console.log(`Could not clear rate-limit state (${err.code}). Continuing.`);
  }
}
