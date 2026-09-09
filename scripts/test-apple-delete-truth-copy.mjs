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
//
// DIC-1381 W13 CR — the previous getStoredAppleRefreshToken predicate
// matched any function whose LAST line was `return null;`. That was
// bypassable: a real reader that reads a value from KV and returns
// null only as a fallback lands the same trailing shape. Anchor on
// the body of the function AND assert the body is a bare `return
// null;` with no KV / storage reads before it.
ok(
  'api/_lib/apple-token-store.ts persistAppleRefreshToken() throws TokenStoreNotImplementedError (stub is still shipping)',
  /export async function persistAppleRefreshToken[\s\S]*?throw new TokenStoreNotImplementedError\(\)/.test(appleTokenStore),
  'if this predicate flips (real persist implementation lands), revisit privacy.html + settings_delete_note',
);
{
  const readMatch = appleTokenStore.match(/export async function getStoredAppleRefreshToken\([^)]*\)\s*:\s*Promise<[^>]*>\s*\{([\s\S]*?)\n\}/);
  const body = readMatch ? readMatch[1].trim() : '';
  ok(
    'api/_lib/apple-token-store.ts getStoredAppleRefreshToken() body is EXACTLY `return null;` (bare stub, no KV / storage reads)',
    /^return\s+null\s*;?\s*$/.test(body),
    body ? `getStoredAppleRefreshToken body: ${body}` : 'no getStoredAppleRefreshToken match',
  );
  // Extra guarantee — no storage / KV / crypto identifier appears
  // anywhere in the function body. If a real reader is landed later,
  // one of these will trip.
  ok(
    'api/_lib/apple-token-store.ts getStoredAppleRefreshToken() body references NO kv / db / crypto / storage identifier',
    !/(kv\.|redis|@vercel\/kv|prisma|pg\.|encrypt|decrypt|crypto\.|readFileSync|storage)/.test(body),
    'a real token-store reader would call one of these; if any lands, revisit privacy.html + settings_delete_note',
  );
}
// DIC-1381 W13 CR — mutation probe: a "real" reader that returns a
// stored token if present and falls back to null MUST be rejected by
// the stub predicate above. If a future refactor loosens the regex
// back to the trailing shape, this probe fails.
{
  const realReader = `export async function getStoredAppleRefreshToken(userId: string): Promise<string | null> {\n  const stored = await kv.get<string>(\`apple:refresh:\${userId}\`);\n  if (stored) return stored;\n  return null;\n}`;
  const m = realReader.match(/export async function getStoredAppleRefreshToken\([^)]*\)\s*:\s*Promise<[^>]*>\s*\{([\s\S]*?)\n\}/);
  const body = m ? m[1].trim() : '';
  const stubPredicatePasses = /^return\s+null\s*;?\s*$/.test(body)
    && !/(kv\.|redis|@vercel\/kv|prisma|pg\.|encrypt|decrypt|crypto\.|readFileSync|storage)/.test(body);
  ok(
    'mutation probe: a real getStoredAppleRefreshToken (KV read + null fallback) IS rejected by the stub predicate',
    !stubPredicatePasses,
  );
}

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
    /(apple_deletion_not_implemented|Apple 綁定的帳號目前 App 內尚未提供|Apple-linked accounts must use the email channel|Apple-linked accounts \(in-app deletion NOT available|Apple 綁定的帳號因 Apple refresh_token|Apple 綁定帳號目前需透過電子郵件管道|Any account linked with Apple|Any account with Apple linked|綁定 Apple 的帳號)/i.test(raw),
    'page must state Apple-linked in-app deletion is not self-service today',
  );
  // Explicit fallback: email channel for Apple users
  ok(
    `${page} routes Apple-linked users to the support email`,
    /(Apple[\s\S]{0,220}dicoge\.chen@gmail\.com|dicoge\.chen@gmail\.com[\s\S]{0,220}Apple)/i.test(raw),
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
  // DIC-1381 W13 CR — the Google-branch clause MUST qualify the
  // self-delete claim with a "no Apple linked" scope. Otherwise a
  // Google+Apple dual-linked user reading the page thinks self-delete
  // is available and finds a 501 at runtime.
  ok(
    `${page} qualifies the Google-self-delete claim as "Google-only / no Apple linked" (DIC-1381 W13 CR — dual-linked truth)`,
    /(僅綁定 Google[^<。]{0,80}未同時綁定 Apple|Google-only[^<.]{0,80}no Apple identity linked|no Apple identity linked[^<.]{0,80}self|未同時綁定 Apple[^<。]{0,120}(自助|In-app|in-app))/i.test(raw),
    'without a "Google-only / no Apple linked" qualifier, a dual-linked (Google+Apple) reader is misled',
  );
  // DIC-1381 W13 CR — the copy MUST cover both 501 branches the
  // handler can emit, since a dual-linked user can hit either one
  // depending on server env.
  ok(
    `${page} names BOTH 501 reasons — apple_deletion_not_implemented AND apple_revocation_not_configured (DIC-1381 W13 CR)`,
    /apple_deletion_not_implemented/i.test(raw) && /apple_revocation_not_configured/i.test(raw),
    'delete-account.ts returns apple_revocation_not_configured when APPLE_* is unset; copy must mention it explicitly',
  );
  // DIC-1381 W13 CR — mention that a Google+Apple dual-linked account
  // takes the Apple fail-closed path (matches handler `hasApple` check).
  ok(
    `${page} explicitly names the Google+Apple dual-linked case going through the Apple fail-closed path (DIC-1381 W13 CR)`,
    /(Google\+Apple|Google \+ Apple|Google[^<。.]{0,10}與 Apple[^<。]{0,20}同時綁定|Apple-only or Google\+Apple|Google\+Apple combined|Google\s*\+\s*Apple 同時綁定|Google 與 Apple 同時綁定|Apple[^<。]{0,20}including Google\+Apple)/i.test(raw),
    'copy must acknowledge that Google+Apple dual-linked = same fail-closed path as Apple-only',
  );
}

// ── settings_delete_note (zh + ja) must describe per-provider truth ──
//
// DIC-1381 W13 CR — the previous "does NOT claim generic provider
// token revocation" predicate used `!badClaim || hasGoogleRefreshTokenText`,
// which passes as soon as the truthful Google sentence exists — the
// banned "撤銷 provider token" phrase can still be present. Replace
// with a strict conjunction: the banned phrase must NOT appear at all,
// regardless of what else is in the note. Add a mutation probe below
// that appends the banned phrase to the shipping note and proves the
// predicate rejects it.
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
    `${locale} settings_delete_note NAMES the Apple 501 apple_revocation_not_configured reason (both handler branches)`,
    /apple_revocation_not_configured/.test(note),
    'delete-account.ts returns TWO 501 codes (config-absent + config-but-no-token); the note must cover BOTH',
  );
  ok(
    `${locale} settings_delete_note routes Apple users to dicoge.chen@gmail.com`,
    /dicoge\.chen@gmail\.com/.test(note),
  );
  ok(
    `${locale} settings_delete_note does NOT contain the banned generic "provider token" phrase (DIC-1381 W13 CR — strict conjunction)`,
    !/撤銷 provider token|revokes the provider token|プロバイダートークンを取り消して/i.test(note),
    'the banned phrase must be absent regardless of other truthful sentences in the note',
  );
  ok(
    `${locale} settings_delete_note names the Google-side truth (Android-only local SDK cache clear)`,
    /GoogleSignin\.signOut\(\)/i.test(note),
    'the Google side is a local SDK cache clear on Android only — the note must say so',
  );
  // DIC-1381 W13 CR — the Google-branch clause MUST qualify the
  // self-delete claim with "not-Apple-linked" or equivalent, so a
  // dual-linked Google+Apple user is not misled into thinking they
  // can self-delete. The handler treats any linkedProviders-has-Apple
  // account as fail-closed; the copy must match.
  ok(
    `${locale} settings_delete_note qualifies the Google-self-delete claim with a "no Apple linked" scope (DIC-1381 W13 CR — dual-linked truth)`,
    /(未同時綁定 Apple|Google のみ連携|Apple を連携していない|no Apple identity linked|Google-only|Google\s*only)/i.test(note),
    'without "Google-only / not Apple-linked", a Google+Apple user reads a false claim',
  );
}

// DIC-1381 W13 CR — mutation probe: appending the banned "撤銷 provider
// token" phrase to the shipping zh note MUST still be rejected by the
// strict-conjunction predicate. Previously the OR-with-truthful-clause
// bypass let this exact mutant pass; that bug is now closed.
{
  const zhMatch = zhSrc.match(/settings_delete_note:\s*'([^']*)'/);
  const currentZh = zhMatch ? zhMatch[1] : '';
  const zhMutant = currentZh + '成功後撤銷 provider token。';
  const mutantRejected = /撤銷 provider token/i.test(zhMutant);
  ok(
    'mutation probe: appending "成功後撤銷 provider token" to zh note IS rejected by the strict-conjunction predicate',
    mutantRejected,
  );
}
{
  const jaMatch = jaSrc.match(/settings_delete_note:\s*'([^']*)'/);
  const currentJa = jaMatch ? jaMatch[1] : '';
  const jaMutant = currentJa + '成功後、プロバイダートークンを取り消して。';
  const mutantRejected = /プロバイダートークンを取り消して/i.test(jaMutant);
  ok(
    'mutation probe: appending "プロバイダートークンを取り消して" to ja note IS rejected by the strict-conjunction predicate',
    mutantRejected,
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W12 Apple-delete truth copy: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W12 Apple-delete truth copy failed`);
}
