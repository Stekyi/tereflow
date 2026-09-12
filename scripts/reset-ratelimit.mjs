/**
 * Clear local rate-limit state before an end-to-end run.
 *
 * Miniflare keeps the KV store open while `wrangler dev` is running, so on
 * Windows removing the directory fails with EPERM. The previous version of this
 * script caught that, printed a line about it, and carried on.
 *
 * That looked harmless and was not. The whole suite shares one client IP
 * against a forty-logins-per-fifteen-minutes ceiling, so a reset that silently
 * did nothing meant later suites started getting 429s. It surfaced as four
 * unrelated assertions failing in the network suite, including one account that
 * could not be closed, which then left a card in the public directory and
 * failed a cleanup check on the run after that. None of those point at a rate
 * limiter.
 *
 * So it still does not abort the run, but it now says plainly that the limits
 * were NOT cleared and what that will look like when it bites. A warning nobody
 * can act on is the same as no warning.
 */
import { rmSync, existsSync } from 'node:fs';

const KV = '.wrangler/state/v3/kv';

if (!existsSync(KV)) {
  console.log('Rate-limit state already clear.');
  process.exit(0);
}

try {
  rmSync(KV, { recursive: true, force: true });
  // force:true swallows failures, so the delete is verified rather than assumed.
  if (existsSync(KV)) throw Object.assign(new Error('directory still present'), { code: 'EPERM' });
  console.log('Rate-limit state cleared.');
} catch (err) {
  const held = err.code === 'EPERM' || err.code === 'EBUSY';
  console.log('');
  console.log('  WARNING  Rate-limit state was NOT cleared.');
  console.log(
    held
      ? '           The dev server holds the KV files open, which Windows does not permit deleting.'
      : `           ${err.code ?? err.message}`,
  );
  console.log('           Later suites in this run may receive 429s. That shows up as');
  console.log('           unrelated-looking failures: a password check reporting "Too many');
  console.log('           attempts", an account that will not close, or a leftover test card.');
  console.log('           For a clean run: stop `wrangler dev`, delete .wrangler/state/v3/kv,');
  console.log('           then start it again. Killing the wrangler node process is not enough;');
  console.log('           its workerd child holds the port and the files, and respawns.');
  console.log('');
}