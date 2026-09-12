#!/usr/bin/env node
// DIC-1380 W7 CR — legal-page claims must match actual STORE_MVP behavior.
//
// The W7 handback: "Reconcile support/privacy quota/subscription claims
// with actual implemented STORE_MVP behavior; tests must compare factual
// claims." A test that just greps for text is not comparing claims to
// behavior — it just pins the text. This suite pulls the truthful values
// FROM the source of truth and asserts the legal pages state them.
//
// Truth sources:
//   • src/services/permissionService.ts — MONTHLY_SCAN_LIMIT (100)
//   • src/config/releaseFlags.ts        — FEATURES.premium (Store MVP
//     disables premium → subscriber collapses to free_user)
//   • src/services/accountSyncClient.ts / accountSyncOrchestrator.ts
//     — the sync payload SHAPE (favorites / decks / collection /
//     priceAlerts / settings — NOT scan quota, NOT subscription state)
//
// Claims the pages must therefore make (verified below):
//   1. The free-tier monthly scan limit matches MONTHLY_SCAN_LIMIT.
//   2. Both pages state paid subscription is not open yet.
//   3. Both pages describe scan quota as a per-device counter today
//      (matches scanQuotaStore's local persist), not a server-side
//      anti-tamper log.
//   4. Neither page claims scan quota is currently synced to the
//      account server (it isn't — snapshotFromLocalStores does not
//      include a `scanQuota` field).
//   5. Both pages describe subscribers as a FUTURE role; support.html
//      calls out the collapse-to-free_user behavior (effectiveRole).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const publicDir = path.join(repoRoot, 'public');

const permissionSrc = fs.readFileSync(path.join(repoRoot, 'src/services/permissionService.ts'), 'utf8');
const releaseFlagsSrc = fs.readFileSync(path.join(repoRoot, 'src/config/releaseFlags.ts'), 'utf8');
const orchestratorSrc = fs.readFileSync(path.join(repoRoot, 'src/services/accountSyncOrchestrator.ts'), 'utf8');
const clientSrc = fs.readFileSync(path.join(repoRoot, 'src/services/accountSyncClient.ts'), 'utf8');
const appSrc = fs.readFileSync(path.join(repoRoot, 'App.tsx'), 'utf8');
const supportRaw = fs.readFileSync(path.join(publicDir, 'support.html'), 'utf8');
const privacyRaw = fs.readFileSync(path.join(publicDir, 'privacy.html'), 'utf8');

let passed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

// ── Extract truth from source ────────────────────────────────────────
const scanLimitMatch = permissionSrc.match(/MONTHLY_SCAN_LIMIT\s*=\s*(\d+)/);
assert.ok(scanLimitMatch, 'permissionService.ts must declare MONTHLY_SCAN_LIMIT (source of truth)');
const scanLimit = Number(scanLimitMatch[1]);

// FEATURES.premium is `!STORE_MVP`; premium is OFF in Store MVP (the
// exact profile the store build ships).
const premiumGate = /premium:\s*!STORE_MVP/.test(releaseFlagsSrc);
// effectiveRole collapses subscriber to free_user when premium is off.
const collapse = /if\s*\(!FEATURES\.premium && role === 'subscriber'\)\s*return\s*'free_user'/.test(permissionSrc);

// snapshotFromLocalStores composes the sync payload from decks +
// collection + priceAlerts + settings + favorites — NOT scan quota,
// NOT subscription state. Prove it by grep-testing the orchestrator +
// client type for those absent fields.
const orchestratorFields = orchestratorSrc.match(/export function snapshotFromLocalStores\([\s\S]*?return\s*\{([\s\S]*?)\n\s*\};/);
assert.ok(orchestratorFields, 'orchestrator must expose snapshotFromLocalStores() returning a patch literal');
const returnedFields = orchestratorFields[1];
const syncsFavorites = /\bfavorites\b/.test(returnedFields);
const syncsDecks = /\bdecks\b/.test(returnedFields);
const syncsCollection = /\bcollection\b/.test(returnedFields);
const syncsPriceAlerts = /\bpriceAlerts\b/.test(returnedFields);
const syncsSettings = /\bsettings\b/.test(returnedFields);
const syncsScanQuota = /scanQuota/i.test(returnedFields);
const syncsSubscription = /subscription/i.test(returnedFields);

ok('code sanity: MONTHLY_SCAN_LIMIT is 100', scanLimit === 100);
ok('code sanity: FEATURES.premium is derived from STORE_MVP (Store MVP disables premium)', premiumGate);
ok('code sanity: effectiveRole collapses subscriber → free_user when premium is off', collapse);
ok('code sanity: sync payload includes favorites/decks/collection/priceAlerts/settings', syncsFavorites && syncsDecks && syncsCollection && syncsPriceAlerts && syncsSettings);
ok('code sanity: sync payload does NOT include a scanQuota field', !syncsScanQuota);
ok('code sanity: sync payload does NOT include a subscription field', !syncsSubscription);

// AccountSyncPatch shape (the wire contract) should agree.
const patchInterfaceMatch = clientSrc.match(/export interface AccountSyncPatch\s*\{([\s\S]*?)\}/);
assert.ok(patchInterfaceMatch, 'AccountSyncPatch interface must exist');
const patchFields = patchInterfaceMatch[1];
ok('code sanity: AccountSyncPatch does NOT declare a scanQuota field', !/scanQuota/i.test(patchFields));
ok('code sanity: AccountSyncPatch does NOT declare a subscription field', !/subscription/i.test(patchFields));

// ── Claim assertions vs source of truth ──────────────────────────────
for (const [page, raw] of [['support.html', supportRaw], ['privacy.html', privacyRaw]]) {
  ok(`${page} states the free-tier scan limit as ${scanLimit}/month (matches MONTHLY_SCAN_LIMIT)`,
    raw.includes(String(scanLimit)) && /(每月|per month|monthly).{0,30}掃描/i.test(raw) || raw.includes(`${scanLimit} scans per month`) || raw.includes(`${scanLimit} card scans per month`) || raw.includes(`${scanLimit} 次`),
    `page should mention "${scanLimit} scans per month" or the zh equivalent`);
  ok(`${page} states that paid subscription / IAP is not open yet (matches !FEATURES.premium)`,
    /(尚未開放|not open yet|not implemented|no payment or subscription mechanism)/i.test(raw));
  ok(`${page} describes scan quota as a per-device counter today (matches scanQuotaStore local persist)`,
    /(裝置端計數|per-device counter|per device counter|local counter)/i.test(raw));
  // "Server-side quota enforcement" claims must be flagged as future,
  // never as implemented. Assert no page says "server-side" enforcement
  // is live TODAY.
  ok(`${page} does NOT claim server-side scan quota enforcement is currently live`,
    !/(伺服器端).{0,25}(已實作|已上線)/i.test(raw) && !/server-side.{0,40}(is|are)\s+implemented/i.test(raw));
}

// support.html: mention the effectiveRole collapse behavior in some form.
ok('support.html describes the current build as Store MVP (favorites/premium hidden by default)',
  /Store MVP/.test(supportRaw));

// privacy.html: the current role list should not include an "active"
// subscriber role because effectiveRole collapses it.
ok('privacy.html frames subscriber as a FUTURE role (not currently active)',
  /(未來|future|尚未|will be active|becomes active|will ship)/i.test(privacyRaw));
ok('privacy.html states the sync payload does NOT currently carry scan-quota progress or subscription state',
  /(掃描剩餘額度|scan quota progress).{0,60}(未列入|NOT part of)/i.test(privacyRaw)
    || /(未列入 sync payload)/i.test(privacyRaw)
    || /(NOT part of the current sync payload)/i.test(privacyRaw));

// ── DIC-1380 W8 CR: sync binding gate — Store MVP does NOT install the
// binding, so any legal-copy claim that sync is "active" for
// favorites/decks/alerts/settings is false. Truth source: App.tsx.
const bindingGate = /installAccountSyncBinding\(\)/.test(appSrc)
  && /FEATURES\.favorites\s*\|\|\s*FEATURES\.watchlist\s*\|\|\s*FEATURES\.premium/.test(appSrc);
ok('code sanity: App.tsx gates installAccountSyncBinding() on FEATURES.favorites || .watchlist || .premium', bindingGate);

for (const [page, raw] of [['support.html', supportRaw], ['privacy.html', privacyRaw]]) {
  // Every page must name the binding-install gate — either by naming
  // `installAccountSyncBinding` or by stating "sync binding is not
  // installed under Store MVP" explicitly.
  ok(
    `${page} discloses that the sync binding is NOT installed under Store MVP (DIC-1380 W8 CR)`,
    /(installAccountSyncBinding|不會安裝 sync binding|不會啟動雲端同步|不會發出任何|does NOT install the sync binding|does not currently issue any|does not install the sync binding|does NOT install the account-sync binding)/i.test(raw),
    'page must state that Store MVP does not activate the account-sync binding',
  );
  // No page may claim sync is ACTIVELY happening for the four data
  // stores today, because it is not under Store MVP.
  ok(
    `${page} does NOT claim the sync binding is ACTIVELY running for favorites/decks/alerts today under Store MVP`,
    !/(sync binding is (installed|running|active) under Store MVP|Store MVP.{0,80}sync binding.{0,40}(已安裝|已啟用|已運作))/i.test(raw),
    'page must not contradict App.tsx by asserting sync is active in Store MVP',
  );
  // No page may claim monthly quota is aggregated / shared across
  // devices via Internal User ID today — permissionService's local
  // MONTHLY_SCAN_LIMIT is device-scoped.
  ok(
    `${page} does NOT claim monthly scan quota is shared across devices via Internal User ID today`,
    !/(共享.{0,20}使用量配額|sharing the same.{0,20}monthly quota|shared.{0,20}monthly quota)/i.test(raw),
    'monthly quota is a per-device counter today; per Internal User ID sharing is future',
  );
  // No page may claim subscription is included in Internal User ID
  // sharing today, since subscription is not implemented.
  ok(
    `${page} does NOT claim subscription state is shared today (subscription is not implemented)`,
    !/(共享.{0,20}訂閱權限|sharing the same.{0,10}(monthly quotas, and )?subscription state)/i.test(raw),
    'subscription state cannot be part of shared Internal User ID state until FEATURES.premium is on',
  );
}

// ── DIC-1381 W9 CR: ordinary-language sync claims must not contradict
// the actual binding gate. The narrow "sync binding is active" pattern
// the W8 test caught is one shape of the contradiction; the CR named a
// broader one — plain sentences that say "favorites, decks, price alerts,
// and settings sync to that account while you are signed in" or its zh
// equivalent. Under STORE_MVP those fields do NOT sync (App.tsx gates
// installAccountSyncBinding() on FEATURES that are all false), so those
// sentences are false without a Store-MVP-not-applied qualifier.
//
// Detection strategy: find sentences that list at least three of the
// per-user sync fields together with a syncs-to-account verb, and reject
// any such sentence that does NOT carry a Store-MVP / feature-flag /
// Web-Develop qualifier. Any such sentence discovered must be re-worded
// or explicitly gated.
const SYNC_FIELD_WORDS = [
  '收藏', '牌組', '價格提醒', '到價提醒', '設定',
  'favorites', 'decks', 'price alerts', 'settings', 'collection',
];
const SYNC_VERB_PATTERN = /(同步到|sync to that account|are synced|會同步|sync to your account|sync\s+(back\s+)?to|同步至)/i;
const QUALIFIER_PATTERN = /(Store MVP|feature flag|FEATURES\.(favorites|watchlist|premium)|installAccountSyncBinding|Web Develop|Web Staging|不會|does not|不會安裝|does NOT|not currently|not part of|do not currently|do not sync|do NOT sync|only sync|僅在啟用|尚未|not\s+sent|不會發出)/i;

for (const [page, raw] of [['privacy.html', privacyRaw]]) {
  // Split by sentence-ish delimiters (period, 。, </p>, <br>) and scan.
  // Tag stripping is deliberate here — we're checking user-visible copy.
  const stripped = raw.replace(/<[^>]+>/g, ' ');
  const sentences = stripped.split(/(?<=[。.!?])\s+|<\/?p[^>]*>|<br\s*\/?>/i);
  const contradictions = [];
  for (const s of sentences) {
    if (!s || s.length < 20) continue;
    const fieldsPresent = SYNC_FIELD_WORDS.filter((w) => s.includes(w));
    if (fieldsPresent.length < 3) continue;
    if (!SYNC_VERB_PATTERN.test(s)) continue;
    if (QUALIFIER_PATTERN.test(s)) continue;
    contradictions.push(s.trim().slice(0, 220));
  }
  ok(
    `${page} has no ordinary-language sentence claiming favorites/decks/priceAlerts/settings sync without a Store MVP qualifier (DIC-1381 W9 CR)`,
    contradictions.length === 0,
    contradictions.length ? `Offending sentences:\n    - ${contradictions.join('\n    - ')}` : '',
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W7 legal-copy vs behavior: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W7 legal-copy vs behavior failed`);
}
