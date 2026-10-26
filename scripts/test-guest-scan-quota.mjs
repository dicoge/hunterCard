#!/usr/bin/env node
/**
 * Guest scan + shared 50/month device allowance (guest-scan-50, 2026-10-05).
 *
 * Product requirement: a guest with no login can scan cards. Guests and
 * signed-in free users share ONE device-local allowance of 50 successful
 * committed scans per calendar month; switching role neither resets nor adds
 * scans. The counter is device-local (localStorage on web, AsyncStorage on
 * native) — NOT a server quota.
 *
 * Exercises the real permissionService + scanQuotaStore + authStore role
 * through the in-memory fallback storage (src/stores/storage.ts), plus
 * source-level contracts on the ScanScreen / ScanQuotaBanner gates that a
 * Node probe cannot render.
 *
 * Run: EXPO_PUBLIC_STORE_MVP=1 node --experimental-strip-types \
 *        --import ./scripts/register-ts.mjs scripts/test-guest-scan-quota.mjs
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.EXPO_PUBLIC_STORE_MVP ??= '1';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const src = (rel) => readFileSync(path.join(ROOT, rel), 'utf8');

const {
  MONTHLY_SCAN_LIMIT, getPermissions, isQuotaExceeded, canScanWithRemaining, effectiveRole, getRoleDescription,
} = await import('../src/services/permissionService.ts');
const { FEATURES } = await import('../src/config/releaseFlags.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { useAuthStore } = await import('../src/store/authStore.ts');
const platformStorage = (await import('../src/stores/storage.ts')).default;

const STORE_KEY = 'holohunter-scan-quota';
const RealDate = Date;

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function setRole(role) {
  useAuthStore.setState({ role, isGuest: role === 'guest', isAuthenticated: role !== 'guest' });
}
function monthKey(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function resetQuota() {
  platformStorage.removeItem(STORE_KEY);
  useScanQuotaStore.setState({ scanCount: 0, currentMonth: monthKey() });
}
function seed(count, month = monthKey()) {
  useScanQuotaStore.setState({ scanCount: count, currentMonth: month });
}
// Freeze "now" so month rollover is deterministic.
function withNow(iso, fn) {
  const fixed = new RealDate(iso).getTime();
  globalThis.Date = class extends RealDate {
    constructor(...a) { super(...(a.length ? a : [fixed])); }
    static now() { return fixed; }
  };
  try { return fn(); } finally { globalThis.Date = RealDate; }
}
// Mirrors ScanScreen.canScanNow (which delegates to canScanWithRemaining).
const canScanNow = () => canScanWithRemaining(useAuthStore.getState().role, useScanQuotaStore.getState().getRemaining());

console.log(`guest-scan-50 (STORE_MVP premium=${FEATURES.premium})`);

await test('limit constant is 50', () => {
  assert.equal(MONTHLY_SCAN_LIMIT, 50);
});

await test('guest is allowed to scan: permissions, remaining, gate', () => {
  resetQuota();
  setRole('guest');
  const p = getPermissions('guest', 0);
  assert.equal(p.canScan, true);
  assert.equal(p.scanQuota, 50);
  assert.equal(p.scanQuotaRemaining, 50);
  assert.equal(isQuotaExceeded('guest', 0), false);
  assert.equal(useScanQuotaStore.getState().getRemaining(), 50);
  assert.equal(canScanNow(), true);
  assert.match(getRoleDescription('guest'), /50/);
});

for (const role of ['guest', 'free_user']) {
  await test(`${role}: 49 used → scan allowed; 50th commits; 51st refused without charging`, () => {
    resetQuota();
    setRole(role);
    seed(49);
    assert.equal(isQuotaExceeded(role, 49), false);
    assert.equal(canScanNow(), true);
    assert.equal(useScanQuotaStore.getState().getRemaining(), 1);
    assert.equal(useScanQuotaStore.getState().incrementScan(), true, '50th scan commits');
    assert.equal(useScanQuotaStore.getState().scanCount, 50);
    assert.equal(useScanQuotaStore.getState().getRemaining(), 0);
    assert.equal(isQuotaExceeded(role, 50), true);
    assert.equal(canScanNow(), false, 'gate closed at 50/50');
    assert.equal(useScanQuotaStore.getState().incrementScan(), false, '51st refused');
    assert.equal(useScanQuotaStore.getState().scanCount, 50, 'refused scan is not charged');
    assert.equal(getPermissions(role, 51).scanQuotaRemaining, 0);
    assert.equal(getPermissions(role, 50).canScan, false);
  });
}

await test('legacy count from the retired 100 limit (e.g. 73) is treated as exhausted', () => {
  resetQuota();
  setRole('free_user');
  seed(73);
  assert.equal(useScanQuotaStore.getState().getRemaining(), 0);
  assert.equal(canScanNow(), false);
  assert.equal(useScanQuotaStore.getState().incrementScan(), false);
  assert.equal(useScanQuotaStore.getState().scanCount, 73);
});

await test('guest: 50 sequential commits from 0 succeed, then refused', () => {
  resetQuota();
  setRole('guest');
  for (let i = 1; i <= 50; i += 1) assert.equal(useScanQuotaStore.getState().incrementScan(), true, `scan ${i}`);
  assert.equal(useScanQuotaStore.getState().incrementScan(), false);
  assert.equal(useScanQuotaStore.getState().scanCount, 50);
});

await test('month rollover: exhausted last month → full 50 this month (gate, increment, rehydrate)', async () => {
  resetQuota();
  setRole('guest');
  withNow('2026-10-31T12:00:00', () => seed(50, monthKey()));
  withNow('2026-10-31T12:00:00', () => assert.equal(canScanNow(), false));
  withNow('2026-11-01T09:00:00', () => {
    assert.equal(useScanQuotaStore.getState().getRemaining(), 50);
    assert.equal(canScanNow(), true);
    assert.equal(useScanQuotaStore.getState().incrementScan(), true);
    assert.equal(useScanQuotaStore.getState().scanCount, 1);
    assert.equal(useScanQuotaStore.getState().currentMonth, '2026-11');
  });
  // Rehydrating a stale-month payload resets it too.
  platformStorage.setItem(STORE_KEY, JSON.stringify({ state: { scanCount: 50, currentMonth: '2020-01' }, version: 0 }));
  await useScanQuotaStore.persist.rehydrate();
  assert.equal(useScanQuotaStore.getState().scanCount, 0);
  assert.equal(useScanQuotaStore.getState().currentMonth, monthKey());
});

await test('persistence/restart: count survives store rehydration', async () => {
  resetQuota();
  setRole('guest');
  for (let i = 0; i < 7; i += 1) useScanQuotaStore.getState().incrementScan();
  const raw = platformStorage.getItem(STORE_KEY);
  const persisted = JSON.parse(raw);
  assert.equal(persisted.state.scanCount, 7);
  assert.deepEqual(Object.keys(persisted.state).sort(), ['currentMonth', 'scanCount'], 'role is not persisted with the quota');
  // Simulate a cold start: wipe in-memory state (persist echoes that write to
  // storage), put the on-disk payload back, then rehydrate from it.
  useScanQuotaStore.setState({ scanCount: 0, currentMonth: '1999-01' });
  platformStorage.setItem(STORE_KEY, raw);
  await useScanQuotaStore.persist.rehydrate();
  assert.equal(useScanQuotaStore.getState().scanCount, 7);
  assert.equal(useScanQuotaStore.getState().getRemaining(), 43);
});

await test('guest → free_user → guest keeps the same count (no reset, no bonus)', () => {
  resetQuota();
  setRole('guest');
  for (let i = 0; i < 10; i += 1) useScanQuotaStore.getState().incrementScan();
  setRole('free_user');
  assert.equal(useScanQuotaStore.getState().scanCount, 10);
  assert.equal(useScanQuotaStore.getState().getRemaining(), 40);
  seed(50);
  setRole('guest');
  assert.equal(canScanNow(), false, 'logging out does not refill the allowance');
  setRole('free_user');
  assert.equal(canScanNow(), false, 'logging in does not refill the allowance');
});

await test('Store MVP: subscriber still collapses to free_user (no unlimited scan)', () => {
  if (FEATURES.premium) return;
  resetQuota();
  setRole('subscriber');
  assert.equal(effectiveRole('subscriber'), 'free_user');
  assert.equal(useScanQuotaStore.getState().getRemaining(), 50);
  assert.equal(getPermissions('subscriber', 0).scanQuota, 50);
  assert.equal(getPermissions('subscriber', 0).canViewPremium, false);
  seed(50);
  assert.equal(canScanNow(), false);
  assert.equal(useScanQuotaStore.getState().incrementScan(), false);
});

await test('ScanScreen: gate delegates to canScanWithRemaining; no guest lockout or login CTA', () => {
  const s = src('src/screens/ScanScreen.tsx');
  assert.match(s, /const canScanNow = \(\): boolean => \{\s*(\/\/[^\n]*\n\s*)*return canScanWithRemaining\(useAuthStore\.getState\(\)\.role, getRemaining\(\)\);/);
  assert.doesNotMatch(s, /=== 'guest'\) return false/);
  assert.doesNotMatch(s, /scan_login_/);
  assert.doesNotMatch(s, /logout\(\)/, 'blocked prompt must not log the guest out');
});

await test('ScanScreen: quota is charged only on committed cards, before recording', () => {
  const s = src('src/screens/ScanScreen.tsx');
  const sites = [...s.matchAll(/incrementScan\(\)/g)].length;
  assert.equal(sites, 2, 'only commitCard and the explicit "add another" button charge');
  const commit = s.slice(s.indexOf('const commitCard = '), s.indexOf('// Route a recognition result'));
  assert.ok(commit.indexOf('incrementScan()') < commit.indexOf('addCard(card)'), 'charge before add');
  assert.ok(commit.indexOf('existing.some') < commit.indexOf('incrementScan()'), 'duplicate does not charge');
  const addAnother = s.slice(s.indexOf("bypasses dedup but"), s.indexOf("addCard(lastScannedCard, { force: true })"));
  assert.match(addAnother, /if \(!incrementScan\(\)\) \{\s*promptScanBlocked\(\);\s*return;/);
  // Recognition failure / cancel paths (captureAndRecognize, gallery pick) never
  // call incrementScan directly — they reach commitCard only on a confirmed card.
  const capture = s.slice(s.indexOf('const captureAndRecognize = async'), s.indexOf('const handleScan = '));
  assert.ok(capture.length > 0 && !capture.includes('incrementScan'));
});

await test('ScanQuotaBanner: guest gets the remaining/exhausted pill, not a lock/login pill', () => {
  const s = src('src/components/ScanQuotaBanner.tsx');
  assert.doesNotMatch(s, /scan_quota_login/);
  assert.doesNotMatch(s, /🔒/);
  assert.doesNotMatch(s, /role === 'guest'\) \{\s*return/);
  assert.match(s, /scan_role_guest/);
  assert.match(s, /scan_quota_exhausted', \{ count: Math\.min\(scanCount, MONTHLY_SCAN_LIMIT\) \}/, 'legacy >50 counts display capped');
});

await test('i18n: quota copy says 50 (zh + ja), no retired login-required scan keys', async () => {
  const { zh } = await import('../src/i18n/locales/zh.ts');
  const { ja } = await import('../src/i18n/locales/ja.ts');
  for (const [name, l] of [['zh', zh], ['ja', ja]]) {
    assert.match(l.scan_quota_remaining_banner, /\/50/, `${name} banner`);
    assert.match(l.scan_quota_exhausted, /\/50/, `${name} exhausted`);
    assert.match(l.scan_quota_body, /50/, `${name} body`);
    assert.doesNotMatch(l.scan_quota_body + l.scan_quota_premium_body, /100/);
    assert.ok(l.scan_role_guest, `${name} guest role tag`);
    for (const k of ['login_guest_hint', 'login_description', 'login_description_store', 'settings_guest_sync_store']) {
      assert.doesNotMatch(l[k], /(無法使用掃描|登入後可(使用卡牌)?掃描|スキャン機能は利用できません|ログインするとカードスキャン)/, `${name}.${k} must not say guests cannot scan`);
    }
    for (const k of ['scan_login_title', 'scan_login_body', 'scan_login_action', 'scan_quota_login', 'scan_guest_limit']) {
      assert.equal(l[k], undefined, `${name}.${k} removed`);
    }
  }
});

await test('Web persistence uses localStorage; Android/iOS uses AsyncStorage; gate code is platform-agnostic', async () => {
  const mem = new Map();
  globalThis.localStorage = {
    getItem: (k) => (mem.has(k) ? mem.get(k) : null),
    setItem: (k, v) => mem.set(k, String(v)),
    removeItem: (k) => mem.delete(k),
  };
  const web = (await import('../src/stores/storage.web.ts')).default;
  web.setItem(STORE_KEY, '{"state":{"scanCount":3}}');
  assert.equal(mem.get(STORE_KEY), '{"state":{"scanCount":3}}');
  assert.equal(web.getItem(STORE_KEY), '{"state":{"scanCount":3}}');
  delete globalThis.localStorage;
  assert.match(src('src/stores/storage.native.ts'), /export default AsyncStorage/);
  for (const f of ['src/services/permissionService.ts', 'src/store/scanQuotaStore.ts']) {
    assert.doesNotMatch(src(f), /Platform\.OS/, `${f} must not branch by platform`);
  }
  assert.match(src('src/store/scanQuotaStore.ts'), /from '\.\.\/stores\/storage'/);
});

await test('recognition endpoint needs no session; account endpoints stay auth-only (source contract)', () => {
  const rec = src('api/recognize-card.ts');
  assert.doesNotMatch(rec, /getSession|requireSession|readSession|401/);
  // Behavioural 401 proof lives in test-auth-endpoint-contract.cjs and
  // test-account-sync-backend.cjs; here we pin that me/sync still gate on a session.
  const auth = src('api/auth/[action].ts');
  assert.match(auth, /if \(!userId\) return json\(\{ error: 'INVALID_TOKEN', reason: 'invalid_session' \}, 401\)/);
  assert.match(auth, /action === 'me'/);
  assert.match(auth, /action === 'sync'/);
});

console.log(`\n✅ guest-scan-50: ${passed} checks passed`);
