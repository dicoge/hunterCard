#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const defaultRepo = path.resolve(__dirname, '..');

const REQUIRED_OFFICIAL_FIELDS = ['cardNumber', 'name', 'sourceProduct', 'sourceProductName', 'imageUrl'];
// DIC-1439: `skillsJp` is required on EVERY official row. Authoritative Japanese
// skill text is obtainable for every printing from the official cardlist
// (scripts/scrape-effects.js), so a row without it is always a real defect.
//
// DIC-1167: `skillsZh` is now required on EVERY official row too, with NO
// baseline exemption. The DIC-1439/DIC-1451 pinned translation-gap baseline
// (data/official-skills-zh-gap.json) is retired: every gap cardNumber received
// a real reviewed translation in data/effects-zh.json, so the unconditional
// requirement is now satisfiable and the duty contract makes it mandatory —
// every user-visible official printing must carry Traditional-Chinese name AND
// skill text before publication. A missing skillsZh is a hard failure, and the
// reappearance of the retired baseline file is itself a hard failure so the
// exemption mechanism cannot silently return.
const REQUIRED_DB_FIELDS = ['id', 'cardNumber', 'name', 'sourceProduct', 'sourceProductName', 'officialImage', 'nameZh', 'skillsJp', 'skillsZh'];
const OFFICIAL_IMAGE_PREFIX = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/';
const RETIRED_ZH_GAP_BASENAME = 'official-skills-zh-gap.json';

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function nonEmpty(value) {
  if (typeof value === 'string') return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return value != null;
}

function imageSuffix(url = '') {
  const clean = String(url).split('?')[0].split('#')[0];
  return clean.slice(clean.lastIndexOf('/') + 1);
}

function signature(card) {
  return [
    card.cardNumber || '',
    card.sourceProduct || card.series || card.expansion || '',
    card.rarity || '',
    imageSuffix(card.officialImage || card.imageUrl || '') || card.id || '',
  ].join('|');
}

function failList(label, rows, limit = 20) {
  if (!rows.length) return;
  const sample = rows.slice(0, limit).map((r) => typeof r === 'string' ? r : JSON.stringify(r)).join('\n  ');
  assert.fail(`${label}: ${rows.length} failure(s)${rows.length > limit ? ` (showing ${limit})` : ''}\n  ${sample}`);
}

function productList(meta) {
  const fromStats = Array.isArray(meta.seriesStats) ? meta.seriesStats : [];
  if (fromStats.length) return fromStats.map((entry) => ({
    code: entry.code,
    expectedCount: entry.expectedCount,
  })).filter((entry) => entry.code);
  return (meta.series || meta.discoveredSeries || []).map((code) => ({ code, expectedCount: null }));
}

function verifyDatabase(label, db, officialBySignature, products) {
  assert.ok(db.cards && typeof db.cards === 'object', `${label} missing cards map`);
  const cards = Object.values(db.cards);
  const byProduct = new Map();
  const failures = [];
  for (const card of cards) {
    const sourceProduct = card?.sourceProduct || card?.series || '';
    if (!products.has(sourceProduct)) continue;
    if (!byProduct.has(sourceProduct)) byProduct.set(sourceProduct, []);
    byProduct.get(sourceProduct).push(card);

    // DIC-1167: every field — including nameZh AND skillsZh — is required per
    // printing, unconditionally. There is no cardNumber-level exemption path.
    for (const field of REQUIRED_DB_FIELDS) {
      if (!nonEmpty(card[field])) failures.push(`${label}:${sourceProduct}:${card.id || card.cardNumber}: missing ${field}`);
    }
    if (card.sourceProduct !== sourceProduct) failures.push(`${label}:${card.id || card.cardNumber}: sourceProduct must be explicit`);
    if (typeof card.officialImage !== 'string' || !card.officialImage.startsWith(OFFICIAL_IMAGE_PREFIX)) {
      failures.push(`${label}:${sourceProduct}:${card.id || card.cardNumber}: invalid officialImage ${card.officialImage || ''}`);
    }
    if (!officialBySignature.has(signature(card))) {
      failures.push(`${label}:${sourceProduct}:${card.id || card.cardNumber}: no matching official printing signature`);
    }
  }
  failList(`${label} official-row completeness`, failures);
  return byProduct;
}

/**
 * Run the full completeness gate against `repo`. Throws (assert.fail) on the
 * first failing check; returns a summary line on success. Exported so the
 * DIC-1167 regression suite can drive the REAL gate against fixture repos and
 * prove the retired exemption path cannot pass.
 */
export function runCompletenessGate(repo = defaultRepo) {
  const officialDir = path.join(repo, 'data', 'official');
  const dbPath = path.join(repo, 'data', 'database.json');
  const publicDbPath = path.join(repo, 'public', 'data', 'database.json');

  // DIC-1167: the pinned translation-gap baseline is RETIRED. Its presence —
  // under data/ or anywhere a future refactor might load it from — would mean
  // someone reintroduced a cardNumber-level exemption for a per-printing
  // requirement, so the file existing at its historical path is a hard failure
  // before any row is examined.
  const retiredGapPath = path.join(repo, 'data', RETIRED_ZH_GAP_BASENAME);
  assert.ok(
    !fs.existsSync(retiredGapPath),
    `data/${RETIRED_ZH_GAP_BASENAME} is retired (DIC-1167): skillsZh is required per official printing with no baseline exemption — delete the file; it can never exempt anything again`,
  );

  const meta = readJson(path.join(officialDir, '_meta.json'));
  const products = productList(meta);
  assert.ok(products.length > 0, 'data/official/_meta.json must contain dynamic product discovery results');

  const productCodes = new Set(products.map((p) => p.code));
  const officialBySignature = new Map();
  const officialFailures = [];
  let officialTotal = 0;
  for (const { code, expectedCount } of products) {
    const file = path.join(officialDir, `${code}.json`);
    assert.ok(fs.existsSync(file), `missing official product file ${path.relative(repo, file)}`);
    const rows = readJson(file);
    assert.ok(Array.isArray(rows), `${path.relative(repo, file)} must be an array`);
    if (Number.isInteger(expectedCount)) {
      assert.equal(rows.length, expectedCount, `${code} official row count must match dynamic expectedCount`);
    }
    officialTotal += rows.length;
    for (const row of rows) {
      for (const field of REQUIRED_OFFICIAL_FIELDS) {
        if (!nonEmpty(row[field])) officialFailures.push(`${code}:${row.id || row.cardNumber || '?'}: missing ${field}`);
      }
      if (row.sourceProduct !== code) officialFailures.push(`${code}:${row.id || row.cardNumber || '?'}: sourceProduct=${row.sourceProduct || ''}`);
      if (typeof row.imageUrl !== 'string' || !row.imageUrl.startsWith(OFFICIAL_IMAGE_PREFIX)) {
        officialFailures.push(`${code}:${row.id || row.cardNumber || '?'}: invalid imageUrl ${row.imageUrl || ''}`);
      }
      officialBySignature.set(signature(row), row);
    }
  }
  failList('official product file completeness', officialFailures);
  if (Number.isInteger(meta.totalCards)) assert.equal(officialTotal, meta.totalCards, 'official _meta totalCards must equal dynamic product row total');

  const dbByProduct = verifyDatabase('data/database.json', readJson(dbPath), officialBySignature, productCodes);
  const publicByProduct = verifyDatabase('public/data/database.json', readJson(publicDbPath), officialBySignature, productCodes);

  const countFailures = [];
  for (const { code, expectedCount } of products) {
    if (!Number.isInteger(expectedCount)) continue;
    const dbCount = dbByProduct.get(code)?.length || 0;
    const publicCount = publicByProduct.get(code)?.length || 0;
    if (dbCount !== expectedCount) countFailures.push(`${code}: data/database.json has ${dbCount}/${expectedCount}`);
    if (publicCount !== expectedCount) countFailures.push(`${code}: public/data/database.json has ${publicCount}/${expectedCount}`);
  }
  failList('database per-product official counts', countFailures);

  return `✓ official catalog completeness gate passed: ${products.length} products, ${officialTotal} official rows, skillsJp/skillsZh/nameZh/image coverage complete per printing in canonical and public databases (no exemptions)`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(runCompletenessGate());
}
