/**
 * test-auth-session.mjs — DIC-665
 *
 * 驗證 app session token（api/lib/session.ts）：後端 HS256 簽發 → 驗簽 roundtrip、
 * 竄改簽章 / payload 被拒、過期被拒、access/refresh type 正確。這是「session 由後端
 * 權威簽發、client 不自行決定」的保證。
 *
 * Run: node --experimental-strip-types scripts/test-auth-session.mjs
 */
import assert from 'node:assert/strict';
import {
  signAccessToken,
  signRefreshToken,
  verifySessionToken,
  SessionTokenInvalidError,
} from '../api/lib/session.ts';

const CONFIG = { secret: 'test-secret-value', accessTtlSec: 3600, refreshTtlSec: 86400 };
const NOW_MS = 1_700_000_000_000;
const now = () => NOW_MS;
const nowSec = Math.floor(NOW_MS / 1000);

let passed = 0;
function check(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('app session token (DIC-665)');

check('access token round-trips and carries sub + type=access + exp', () => {
  const token = signAccessToken('user-42', CONFIG, now);
  const payload = verifySessionToken(token, CONFIG.secret, now);
  assert.equal(payload.sub, 'user-42');
  assert.equal(payload.type, 'access');
  assert.equal(payload.exp, nowSec + 3600);
});

check('refresh token carries type=refresh and longer ttl', () => {
  const token = signRefreshToken('user-42', CONFIG, now);
  const payload = verifySessionToken(token, CONFIG.secret, now);
  assert.equal(payload.type, 'refresh');
  assert.equal(payload.exp, nowSec + 86400);
});

check('wrong secret → rejected', () => {
  const token = signAccessToken('user-42', CONFIG, now);
  assert.throws(
    () => verifySessionToken(token, 'attacker-secret', now),
    (err) => err instanceof SessionTokenInvalidError
  );
});

check('tampered payload → rejected (signature no longer matches)', () => {
  const token = signAccessToken('user-42', CONFIG, now);
  const [h, , s] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ sub: 'admin', type: 'access', iat: nowSec, exp: nowSec + 3600 })).toString('base64url');
  assert.throws(
    () => verifySessionToken(`${h}.${forged}.${s}`, CONFIG.secret, now),
    (err) => err instanceof SessionTokenInvalidError
  );
});

check('expired token → rejected', () => {
  const token = signAccessToken('user-42', CONFIG, now);
  const later = () => NOW_MS + 3601 * 1000;
  assert.throws(
    () => verifySessionToken(token, CONFIG.secret, later),
    (err) => err instanceof SessionTokenInvalidError
  );
});

check('malformed token → rejected', () => {
  assert.throws(
    () => verifySessionToken('not.a.jwt.at.all', CONFIG.secret, now),
    (err) => err instanceof SessionTokenInvalidError
  );
});

console.log(`\n${passed} checks passed.`);
