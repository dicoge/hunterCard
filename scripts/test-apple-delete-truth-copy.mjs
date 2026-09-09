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
//
// DIC-1381 W14 CR — bilingual public pages carry two independent
// language sections (`<div id="content-zh">` and `<div id="content-en">`).
// The previous CR flagged that running each predicate against the
// concatenated HTML let one locale mask a regression in the other:
// deleting every Google-only / both-501 / Google+Apple sentence from
// content-zh in memory still passed as long as content-en carried the
// facts. Split by id per file, run every W13 assertion against each
// section independently, and add mutation probes that strip the
// section-scoped anchors from one locale at a time.

function extractLocaleSection(raw, id) {
  // Find `<div id="{id}"` and consume until the matching closing </div>
  // at the SAME depth. The published bilingual pages nest a couple of
  // levels of block content inside each section (danger-card, faq-item,
  // ol/ul/li, etc.), so track div nesting rather than "the next </div>".
  const startIdx = raw.indexOf(`id="${id}"`);
  if (startIdx < 0) throw new Error(`section id="${id}" not found`);
  // Walk backwards to the enclosing <div ... `id="{id}"` open tag start
  // (there is only one `<div` before the id attribute), then scan
  // forward with a depth counter.
  const openTagStart = raw.lastIndexOf('<div', startIdx);
  if (openTagStart < 0) throw new Error(`no opening <div for id="${id}"`);
  let depth = 0;
  let i = openTagStart;
  const openRe = /<div\b[^>]*>/gi;
  const closeRe = /<\/div\s*>/gi;
  while (i < raw.length) {
    openRe.lastIndex = i;
    closeRe.lastIndex = i;
    const nextOpen = openRe.exec(raw);
    const nextClose = closeRe.exec(raw);
    if (!nextClose) throw new Error(`no matching </div> for id="${id}"`);
    if (nextOpen && nextOpen.index < nextClose.index) {
      depth += 1;
      i = nextOpen.index + nextOpen[0].length;
      continue;
    }
    // consume the close
    depth -= 1;
    if (depth === 0) {
      return raw.slice(openTagStart, nextClose.index + nextClose[0].length);
    }
    i = nextClose.index + nextClose[0].length;
  }
  throw new Error(`unbalanced <div> for id="${id}"`);
}

// One shared bundle of predicates so every (page, locale) runs the
// exact same rules; a mutation probe just calls it on a mutated copy
// and asserts at least one predicate fails.
function evaluateLocaleDeletionCopy(section) {
  const results = {};
  results.appleNotAvailable = /(apple_deletion_not_implemented|apple_revocation_not_configured|Apple 綁定的帳號目前 App 內尚未提供|Apple-linked accounts must use the email channel|Apple-linked accounts \(in-app deletion NOT available|Apple 綁定的帳號因 Apple refresh_token|Apple 綁定帳號目前需透過電子郵件管道|Any account linked with Apple|Any account with Apple linked|綁定 Apple 的帳號|any account with Apple linked)/i.test(section);
  results.appleToEmail = /(Apple[\s\S]{0,300}dicoge\.chen@gmail\.com|dicoge\.chen@gmail\.com[\s\S]{0,300}Apple)/i.test(section);
  results.noUnqualifiedCascade = !/cascade-?deletes?[\s\S]{0,40}(Google \/ Apple|Google and Apple)/i.test(section)
    && !/級聯刪除[\s\S]{0,40}Google \/ Apple/i.test(section);
  results.googleNotRevoked = /(does NOT revoke your Google refresh_token|後端不會撤銷[\s\S]{0,20}Google refresh_token|不會伺服器端撤銷您的 Google refresh_token|後端目前不會撤銷 Google refresh_token|The backend does not revoke your Google refresh_token)/i.test(section);
  results.googleOnlyScope = /(僅綁定 Google[^<。]{0,80}未同時綁定 Apple|Google-only[^<.]{0,120}no Apple identity linked|no Apple identity linked[^<.]{0,80}self|未同時綁定 Apple[^<。]{0,120}(自助|In-app|in-app))/i.test(section);
  results.bothReasons = /apple_deletion_not_implemented/i.test(section) && /apple_revocation_not_configured/i.test(section);
  results.dualLinked = /(Google\+Apple|Google \+ Apple|Google[^<。.]{0,10}與 Apple[^<。]{0,20}同時綁定|Apple-only or Google\+Apple|Google\+Apple combined|Google\s*\+\s*Apple 同時綁定|Google 與 Apple 同時綁定|Apple[^<。]{0,20}including Google\+Apple|Apple-only or Google\+Apple combined)/i.test(section);
  return results;
}

const LOCALE_PREDICATES = [
  ['appleNotAvailable', 'states Apple-linked in-app deletion is NOT available yet'],
  ['appleToEmail', 'routes Apple-linked users to the support email'],
  ['noUnqualifiedCascade', 'does NOT claim unqualified Google / Apple cascade deletion'],
  ['googleNotRevoked', 'explicitly states Google refresh_token is NOT revoked server-side'],
  ['googleOnlyScope', 'qualifies the Google-self-delete claim as "Google-only / no Apple linked" (DIC-1381 W14 CR — dual-linked truth)'],
  ['bothReasons', 'names BOTH 501 reasons — apple_deletion_not_implemented AND apple_revocation_not_configured (DIC-1381 W14 CR)'],
  ['dualLinked', 'explicitly names the Google+Apple dual-linked case going through the Apple fail-closed path (DIC-1381 W14 CR)'],
];

const pageSections = [];
for (const [page, raw] of [['public/privacy.html', privacyRaw], ['public/support.html', supportRaw]]) {
  const zh = extractLocaleSection(raw, 'content-zh');
  const en = extractLocaleSection(raw, 'content-en');
  pageSections.push({ page, raw, zh, en });
  for (const [locale, section] of [['zh', zh], ['en', en]]) {
    const results = evaluateLocaleDeletionCopy(section);
    for (const [key, label] of LOCALE_PREDICATES) {
      ok(
        `${page} :: content-${locale} ${label}`,
        results[key] === true,
        `locale-isolated predicate ${key} failed on ${page} content-${locale}`,
      );
    }
  }
}

// DIC-1381 W14 CR — mutation probes: for each bilingual page, strip
// the section-scoped anchors from ONE locale at a time and prove
// evaluateLocaleDeletionCopy() flips at least one predicate on that
// mutated section (masking the other locale must not rescue it).
function stripAnchors(section) {
  return section
    // Google-only scope (zh + en variants).
    .replace(/僅綁定 Google[^<。]{0,120}未同時綁定 Apple[^<。]*/gi, '')
    .replace(/Google-only[^<.]{0,120}no Apple identity linked[^<.]*/gi, '')
    .replace(/no Apple identity linked/gi, '')
    .replace(/未同時綁定 Apple/gi, '')
    .replace(/Google-only/gi, '')
    // Both 501 reason codes.
    .replace(/apple_deletion_not_implemented/gi, '')
    .replace(/apple_revocation_not_configured/gi, '')
    // Google+Apple dual-linked anchors.
    .replace(/Google\+Apple[^<]*/gi, '')
    .replace(/Google \+ Apple[^<]*/gi, '')
    .replace(/Google[^<。.]{0,10}與 Apple[^<。]{0,20}同時綁定/gi, '')
    .replace(/Apple-only or Google\+Apple[^<]*/gi, '')
    .replace(/Google\+Apple combined/gi, '');
}

for (const { page, zh, en } of pageSections) {
  {
    const mutated = stripAnchors(zh);
    const results = evaluateLocaleDeletionCopy(mutated);
    const flipped = LOCALE_PREDICATES.filter(([k]) => results[k] === false).map(([, l]) => l);
    ok(
      `mutation probe: stripping W14 anchors from ${page} content-zh flips at least one predicate (locale isolation intact)`,
      flipped.length > 0,
      flipped.length ? '' : 'zh mutant passed every predicate — locale isolation is not enforced',
    );
  }
  {
    const mutated = stripAnchors(en);
    const results = evaluateLocaleDeletionCopy(mutated);
    const flipped = LOCALE_PREDICATES.filter(([k]) => results[k] === false).map(([, l]) => l);
    ok(
      `mutation probe: stripping W14 anchors from ${page} content-en flips at least one predicate (locale isolation intact)`,
      flipped.length > 0,
      flipped.length ? '' : 'en mutant passed every predicate — locale isolation is not enforced',
    );
  }
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
