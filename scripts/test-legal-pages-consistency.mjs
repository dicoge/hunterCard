#!/usr/bin/env node
// DIC-1380 legal / pricing / support / terms consistency gate.
//
// The four public HTML surfaces (privacy, pricing, terms, support) are the
// only user-visible pages Vercel serves outside the app bundle. They must
// share a coherent header (canonical URL, mobile viewport, language tag) and
// present a coherent draft state — the DIC-1380 correction called out that a
// mix of "Engineering Review Draft" badges on some pages and no badge on
// others is exactly the inconsistency users perceive as "which of these am I
// actually reading". This gate pins:
//
//   • Every legal page exists, opens with the same `<!DOCTYPE html>` +
//     `<html lang="zh-TW">` shell, and declares a mobile viewport meta.
//   • Each page's `<link rel="canonical">` points at its own filename on the
//     canonical production origin (holohunter.dicoge.com) — no path drift.
//   • Each page has a non-empty `<title>`.
//   • Draft state is consistent — either all four pages carry the
//     `【工程審核草案 / Engineering Review Draft】` marker or none do.
//   • privacy.html retains the DIC-1248 privacy-disclosure sections
//     ("拍攝的照片" / "Captured photos") verbatim (their own dedicated
//     regression is test:privacy-disclosure — this gate only asserts that
//     removing the section during a badge/consistency edit fails closed).

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const PAGES = [
  { file: 'privacy.html' },
  { file: 'pricing.html' },
  { file: 'terms.html' },
  { file: 'support.html' },
];

const ORIGIN = 'https://holohunter.dicoge.com';
const DRAFT_MARKER = '【工程審核草案 / Engineering Review Draft】';

// DIC-1380 W4 CR: the parity test now also rejects residual draft / sandbox
// / TBD copy in the page BODIES. Every entry below is a substring the pages
// carried in earlier revisions and which the W4 handback explicitly asked
// us to remove or truthfully replace. A page that re-introduces any of
// these markers fails closed — a fresh regression tightens this list
// rather than silently accepting new draft copy.
const FORBIDDEN_BODY_SUBSTRINGS = [
  '草案',
  '草稿',
  'Draft',
  'draft',
  'Sandbox',
  'sandbox',
  '沙盒',
  'TBD',
  '工程審核',
  '工程測試',
  'テスト草案',
  '(Sandbox)',
  // DIC-1380 W6 CR: the earlier "local mock / no backend" copy in
  // support.html falsely claimed the auth / backend / cloud-sync surfaces
  // did not exist. Ban the phrases so a future edit cannot silently
  // reintroduce the falsehood.
  '本機模擬',
  'local mock',
  'Local Mock',
  '未來正式版',
  'Future production',
];

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const bodies = new Map();
for (const p of PAGES) {
  const abs = path.join(publicDir, p.file);
  check(`${p.file} exists on disk`, fs.existsSync(abs));
  if (fs.existsSync(abs)) bodies.set(p.file, fs.readFileSync(abs, 'utf8'));
}

for (const p of PAGES) {
  const body = bodies.get(p.file) ?? '';
  check(`${p.file} opens with <!DOCTYPE html>`, /^<!DOCTYPE html>/i.test(body.trimStart()));
  check(`${p.file} declares <html lang="zh-TW">`, /<html\s+lang="zh-TW"/i.test(body));
  check(`${p.file} declares mobile viewport meta`, /<meta\s+name="viewport"\s+content="width=device-width,\s*initial-scale=1(\.0)?"/i.test(body));
  const canonicalRe = new RegExp(`<link\\s+rel="canonical"\\s+href="${ORIGIN.replace(/\./g, '\\.')}/${p.file}"`, 'i');
  check(`${p.file} canonical link points at ${ORIGIN}/${p.file}`, canonicalRe.test(body));
  const titleMatch = body.match(/<title>([^<]*)<\/title>/i);
  check(`${p.file} has non-empty <title>`, !!titleMatch && titleMatch[1].trim().length > 0);
}

// Draft-state consistency: same marker presence across the four pages.
const draftPresence = new Map();
for (const p of PAGES) {
  const body = bodies.get(p.file) ?? '';
  draftPresence.set(p.file, body.includes(DRAFT_MARKER));
}
const distinct = new Set(draftPresence.values());
check(
  'draft-state marker presence is consistent across pricing / terms / privacy / support',
  distinct.size <= 1,
  `got ${JSON.stringify(Object.fromEntries(draftPresence))} — mix of drafted and non-drafted pages`,
);

// DIC-1380 W4: reject residual draft / sandbox / TBD copy on every page.
// The DRAFT_MARKER check above is the strong "badge visible on screen" test;
// this loop is the wider net that catches the same idea leaking back into a
// body paragraph, a card label, or a footer link.
for (const p of PAGES) {
  const body = bodies.get(p.file) ?? '';
  // `draft-badge` is the CSS class STYLE name (kept even though no page uses
  // it now); allow it while forbidding a rendered word. Anything else on the
  // list is straight-substring rejected.
  for (const needle of FORBIDDEN_BODY_SUBSTRINGS) {
    if (needle === 'draft' && body.includes('draft-badge {') && !new RegExp(String.raw`\bdraft\b(?!-badge)`, 'i').test(body.replace(/draft-badge/g, ''))) {
      passed += 1;
      console.log(`  ✓ ${p.file} has no residual "${needle}" body copy (draft-badge CSS class allowed)`);
      continue;
    }
    check(
      `${p.file} has no residual "${needle}" body copy`,
      !body.includes(needle),
      `page still carries the "${needle}" marker`,
    );
  }
}

// Privacy disclosure invariants — the DIC-1248 sections must survive any
// consistency edit. Full mutation-sensitivity lives in test:privacy-disclosure.
{
  const privacy = bodies.get('privacy.html') ?? '';
  check('privacy.html retains the on-device photo cache disclosure (zh)', privacy.includes('拍攝的照片'));
  check('privacy.html retains the on-device photo cache disclosure (en)', privacy.includes('Captured photos'));
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ legal / pricing / terms / support consistency: ${passed} checks passed`);
} else {
  console.error(`\n❌ legal / pricing / terms / support consistency failed`);
}
