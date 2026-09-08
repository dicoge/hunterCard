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
