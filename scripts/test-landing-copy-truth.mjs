#!/usr/bin/env node
/**
 * v41 (2026-10-17): the Landing page's feature statements match what the
 * production build does. PM finding holohunter-v41-landing-truth-finding: the FAQ
 * still said Store MVP never syncs, that mobile photos never leave the device and
 * that Google sign-in / sync were "coming soon" — while the build syncs signed-in
 * accounts and uploads recognition photos (after the disclosure) on mobile and web.
 *
 * Production profile (EXPO_PUBLIC_STORE_MVP=1). The copy is rendered by the REAL
 * LandingScreen (mobile 390: every FAQ answer open) and each claim is tied to the
 * behaviour it describes: what account sync actually sends, that the Google CTA
 * calls the real sign-in, and that photo statements agree with public/privacy.html.
 */
process.env.EXPO_PUBLIC_STORE_MVP = '1';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://holohunter.dicoge.com/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class NoopResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;
for (const [k, v] of [['innerWidth', 390], ['innerHeight', 844]]) Object.defineProperty(dom.window, k, { value: v, configurable: true });
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: 844, configurable: true });
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const LandingScreen = (await import('../src/screens/LandingScreen.tsx')).default;
const { useAuthStore } = await import('../src/store/authStore.ts');
const { FEATURES } = await import('../src/config/releaseFlags.ts');
const { snapshotFromLocalStores } = await import('../src/services/accountSyncOrchestrator.ts');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

const calls = [];
useAuthStore.setState({ loginWithGoogle: async () => { calls.push('google'); }, continueAsGuest: async () => { calls.push('guest'); } });
const host = document.createElement('div');
document.body.appendChild(host);
const root = createRoot(host);
await act(async () => { root.render(React.createElement(LandingScreen)); await Promise.resolve(); });
await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const byTestId = (id) => host.querySelector(`[data-testid="${id}"]`);
const text = host.textContent;
const faq = byTestId('landing-faq')?.textContent ?? '';
const privacy = fs.readFileSync(new URL('../public/privacy.html', import.meta.url), 'utf8');

await test('production profile: Store MVP on (the profile the copy describes)', () => {
  assert.equal(FEATURES.favorites, false);
  assert.equal(FEATURES.collection, true);
});

await test('sync claims match the binding: installed in every profile, and what a signed-in push sends = collection, decks, 估值清單, settings (no photos / diagnostics / scan allowance)', () => {
  const app = fs.readFileSync(new URL('../App.tsx', import.meta.url), 'utf8');
  assert.match(app, /\n\s+installAccountSyncBinding\(\);/, 'binding installed');
  assert.ok(!/if\s*\([^)]*FEATURES[^)]*\)\s*\{?\s*installAccountSyncBinding/.test(app), 'not gated on hidden features');
  assert.deepEqual(Object.keys(snapshotFromLocalStores()).sort(), ['collection', 'decks', 'scanSession', 'settings']);
  for (const phrase of ['收藏數量、牌組、估值清單與語言／幣別設定會同步到你的帳號', '照片、診斷紀錄與每月掃描額度不會同步']) {
    assert.ok(faq.includes(phrase), `FAQ states: ${phrase}`);
  }
});

await test('no stale "sync is off / coming soon" statement anywhere on the page', () => {
  for (const stale of ['/api/auth/sync', 'Store MVP', 'binding', 'feature flag', '本機收藏需登入', '陸續推出', '跨裝置同步為即將推出', '僅限啟用同步的建構', '不會發出']) {
    assert.ok(!text.includes(stale), `page no longer says "${stale}"`);
  }
});

await test('photo statements match the recognition flow and privacy.html: uploaded after consent on mobile AND web; the automatic scan\'s local probe is never uploaded and is deleted', () => {
  assert.ok(!faq.includes('不會離開您的裝置'), 'no "photos never leave the device" claim');
  assert.ok(faq.includes('同意後，用於辨識的照片會經 HTTPS 傳到我們的伺服器，再交給 Google Gemini 辨識，手機 App 與網頁版相同'));
  assert.ok(faq.includes('偵測用的暫存照片不會上傳，每次偵測後就刪除'));
  assert.ok(privacy.includes('手機 App（iOS / Android）與網頁版皆會上傳影像'), 'privacy says the same (mobile + web upload)');
  assert.ok(privacy.includes('偵測照片與裁切檔<strong>不會上傳</strong>'), 'privacy says the same (probe local)');
});

await test('Google sign-in: both CTAs make no coming-soon claim, never mention Apple, and call the real sign-in', async () => {
  assert.ok(!text.includes('Apple'), 'no Apple promise on the page');
  for (const id of ['landing-cta-google', 'landing-final-cta-google']) {
    const cta = byTestId(id);
    assert.ok(cta, `${id} renders`);
    assert.ok(!/即將推出/.test(cta.textContent), `${id}: no 即將推出`);
    calls.length = 0;
    await act(async () => { cta.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true })); await Promise.resolve(); });
    assert.deepEqual(calls, ['google'], `${id} calls loginWithGoogle`);
  }
});

await test('pricing: free 50 scans/month per device shared by visitors and free members; no future payment-platform promise; subscriptions not open', () => {
  assert.ok(faq.includes('每月 50 次卡片辨識掃描免費提供，訪客與免費會員共用同一裝置的額度'));
  assert.ok(faq.includes('訂閱與 App 內購目前尚未開放'));
  for (const p of ['Stripe', 'Store API', '金流']) assert.ok(!text.includes(p), `no "${p}" promise`);
});

await act(async () => root.unmount());
if ((process.exitCode ?? 0) === 0) console.log(`\n✅ landing-copy-truth: ${passed} checks passed`);
else console.error('\n❌ landing-copy-truth failed');
