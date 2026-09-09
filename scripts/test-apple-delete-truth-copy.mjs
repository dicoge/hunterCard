#!/usr/bin/env node
// DIC-1380 W12 CR — the public + in-app deletion copy MUST match the real
// per-provider deletion path shipped on this build.
//
// Mac-Codex evidence: the previous privacy.html + settings_delete_note
// claimed in-app deletion is "implemented" and revokes "the provider
// token" without qualification. The shipping truth source disagrees:
//
//   • api/_lib/apple-token-store.ts is a non-shipping stub —
//     persistAppleRefreshToken() throws TokenStoreNotImplementedError,
//     getStoredAppleRefreshToken() always returns null,
//     deleteStoredAppleRefreshToken() is a no-op.
//   • api/auth/delete-account.ts consequently returns 501
//     `apple_deletion_not_implemented` for every Apple-linked account.
//   • src/services/authService.ts signOutNativeGoogle() runs only on
//     Android and does a LOCAL sign-out — it does NOT revoke the
//     Google refresh_token server-side.
//
// This suite reads the source-of-truth files and asserts the public/App
// copy names those facts (Apple-linked deletion routes to email; Google
// deletion is best-effort local sign-out on Android only, not
// server-side token revocation). Every stub predicate is grep-mutation-
// sensitive: swapping the stub for a real implementation, or adding a
// truthful implementation, forces the copy to be revisited.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

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

// ── Truth sources ──────────────────────────────────────────────────
const appleTokenStore = fs.readFileSync(path.join(repoRoot, 'api/_lib/apple-token-store.ts'), 'utf8');
const deleteAccountHandler = fs.readFileSync(path.join(repoRoot, 'api/auth/delete-account.ts'), 'utf8');
const authService = fs.readFileSync(path.join(repoRoot, 'src/services/authService.ts'), 'utf8');
const privacyRaw = fs.readFileSync(path.join(repoRoot, 'public/privacy.html'), 'utf8');
const supportRaw = fs.readFileSync(path.join(repoRoot, 'public/support.html'), 'utf8');
const zhSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n/locales/zh.ts'), 'utf8');
const jaSrc = fs.readFileSync(path.join(repoRoot, 'src/i18n/locales/ja.ts'), 'utf8');

// ── Confirm the Apple token store is still a stub ──────────────────
// The whole rationale for the copy fix collapses if this ships. When
// the file becomes a real implementation, that predicate flips and
// this suite MUST be re-read — the copy needs to be updated to match
// the new reality, not the old stub.
ok(
  'api/_lib/apple-token-store.ts persistAppleRefreshToken() throws TokenStoreNotImplementedError (stub is still shipping)',
  /export async function persistAppleRefreshToken[\s\S]*?throw new TokenStoreNotImplementedError\(\)/.test(appleTokenStore),
  'if this predicate flips (real persist implementation lands), revisit privacy.html + settings_delete_note',
);
ok(
  'api/_lib/apple-token-store.ts getStoredAppleRefreshToken() returns null unconditionally (stub is still shipping)',
  /export async function getStoredAppleRefreshToken\([\s\S]*?return null;\n\}/.test(appleTokenStore),
  'if this predicate flips (real read implementation lands), revisit privacy.html + settings_delete_note',
);

// ── Confirm delete-account handler still fails closed 501 for Apple ─
ok(
  'api/auth/delete-account.ts still returns 501 apple_deletion_not_implemented for Apple accounts without stored refresh_token',
  /apple_deletion_not_implemented/.test(deleteAccountHandler) && /501/.test(deleteAccountHandler),
);
ok(
  'api/auth/delete-account.ts still returns 501 apple_revocation_not_configured when APPLE_* env vars are unset',
  /apple_revocation_not_configured/.test(deleteAccountHandler) && /501/.test(deleteAccountHandler),
);

// ── Confirm the Google local-only signout is exactly what the copy says ─
ok(
  'src/services/authService.ts signOutNativeGoogle() is Platform.OS==="android" only (best-effort local SDK cache clear, not server-side revocation)',
  /export async function signOutNativeGoogle[\s\S]*?if \(Platform\.OS !== 'android'\) return;/.test(authService),
);
// Guard against a future PR that accidentally adds server-side Google
// refresh_token revocation without updating the copy: the endpoint file
// must NOT reference a Google revoke URL / GoogleTokenStore, otherwise
// the copy claim "Google refresh_token is NOT revoked" becomes false.
ok(
  'api/auth/delete-account.ts does NOT currently revoke Google refresh_token server-side (matches the copy)',
  !/oauth2\.googleapis\.com\/revoke|GoogleTokenStore|revokeGoogle/i.test(deleteAccountHandler),
  'if server-side Google revocation is added, revise privacy.html + settings_delete_note',
);

// ── Public copy must NAME the truthful per-provider outcome ──────────
for (const [page, raw] of [['public/privacy.html', privacyRaw], ['public/support.html', supportRaw]]) {
  // Apple-linked deletion is NOT in-app self-service today
  ok(
    `${page} states Apple-linked in-app deletion is NOT available yet`,
    /(apple_deletion_not_implemented|Apple 綁定的帳號目前 App 內尚未提供|Apple-linked accounts must use the email channel|Apple-linked accounts \(in-app deletion NOT available|Apple 綁定的帳號因 Apple refresh_token|Apple 綁定帳號目前需透過電子郵件管道)/i.test(raw),
    'page must state Apple-linked in-app deletion is not self-service today',
  );
  // Explicit fallback: email channel for Apple users
  ok(
    `${page} routes Apple-linked users to the support email`,
    /(Apple[\s\S]{0,120}dicoge\.chen@gmail\.com|dicoge\.chen@gmail\.com[\s\S]{0,120}Apple)/i.test(raw),
    'Apple-linked users must be told to email support',
  );
  // Must NOT claim "cascade-deletes Google / Apple" without qualification
  ok(
    `${page} does NOT claim unqualified Google / Apple cascade deletion`,
    !/cascade-?deletes?[\s\S]{0,40}(Google \/ Apple|Google and Apple)/i.test(raw)
      && !/級聯刪除[\s\S]{0,40}Google \/ Apple/i.test(raw),
    'the unqualified "cascade-deletes Google/Apple identities" wording contradicts the Apple 501 branch',
  );
  // Must state the truthful Google side: on-device sign-out only,
  // NOT server-side revocation of the Google refresh_token.
  ok(
    `${page} explicitly states Google refresh_token is NOT revoked server-side`,
    /(does NOT revoke your Google refresh_token|後端不會撤銷[\s\S]{0,20}Google refresh_token|不會伺服器端撤銷您的 Google refresh_token|後端目前不會撤銷 Google refresh_token)/i.test(raw),
    'copy must not claim server-side Google token revocation, since delete-account.ts does not do it',
  );
}

// ── settings_delete_note (zh + ja) must describe per-provider truth ──
for (const [locale, src] of [['zh', zhSrc], ['ja', jaSrc]]) {
  const match = src.match(/settings_delete_note:\s*'([^']*)'/);
  assert.ok(match, `${locale} locale must declare settings_delete_note`);
  const note = match[1];
  ok(
    `${locale} settings_delete_note describes per-provider truth (mentions Google AND Apple explicitly)`,
    /Google/.test(note) && /Apple/.test(note),
    'a generic "provider token" note hides the Apple 501 branch',
  );
  ok(
    `${locale} settings_delete_note NAMES the Apple 501 apple_deletion_not_implemented reason`,
    /apple_deletion_not_implemented/.test(note),
    'the exact backend reason keeps the note tied to the actual server response',
  );
  ok(
    `${locale} settings_delete_note routes Apple users to dicoge.chen@gmail.com`,
    /dicoge\.chen@gmail\.com/.test(note),
  );
  ok(
    `${locale} settings_delete_note does NOT claim generic "provider token revocation"`,
    !/撤銷 provider token|revokes the provider token|プロバイダートークンを取り消して/i.test(note)
      || /Google refresh_token(?!を|.{0,5}を)|does NOT revoke/i.test(note),
    'settings_delete_note must describe per-provider behaviour, not a bare "revokes provider token" line',
  );
  ok(
    `${locale} settings_delete_note names the Google-side truth (Android-only local SDK cache clear)`,
    /GoogleSignin\.signOut\(\)/i.test(note),
    'the Google side is a local SDK cache clear on Android only — the note must say so',
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W12 Apple-delete truth copy: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W12 Apple-delete truth copy failed`);
}
