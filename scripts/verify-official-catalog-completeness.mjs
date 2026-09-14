#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const officialDir = path.join(repo, 'data', 'official');
const dbPath = path.join(repo, 'data', 'database.json');
const publicDbPath = path.join(repo, 'public', 'data', 'database.json');

const REQUIRED_OFFICIAL_FIELDS = ['cardNumber', 'name', 'sourceProduct', 'sourceProductName', 'imageUrl'];
// DIC-1439: `skillsJp` is required on EVERY official row. Authoritative Japanese
// skill text is obtainable for every printing from the official cardlist
// (scripts/scrape-effects.js), so a row without it is always a real defect.
const REQUIRED_DB_FIELDS = ['id', 'cardNumber', 'name', 'sourceProduct', 'sourceProductName', 'officialImage', 'nameZh', 'skillsJp'];
const OFFICIAL_IMAGE_PREFIX = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/';

// DIC-1439: `skillsZh` cannot be required unconditionally the way `skillsJp`
// can. data/effects-zh.json is a TRANSLATION artifact, not an upstream official
// source — scripts/translate-effects.js is hard-disabled under the DIC-1185
// OpenRouter denylist ("No inference call may be made from this script") and no
// compliant provider is wired — so Traditional-Chinese skill text simply does
// not exist yet for cardNumbers first published after the last translation run.
// The two dishonest ways out are both refused here: fabricating TC text would
// violate the denylist, and emitting the raw Japanese fallback would ship kana
// into a `zh` field, which DIC-465 forbids and translate-effects' own
// `validate()` rejects. Instead the gap is PINNED to an explicit baseline file
// and policed from three directions, so the check is tightened, not weakened:
//   1. a row whose cardNumber is NOT in the baseline must have skillsZh —
//      this is the DIC-454 silent-skillsZh-drop regression, now fail-closed;
//   2. the baseline may never GROW to cover a new cardNumber silently — adding
//      one is a reviewable diff to data/official-skills-zh-gap.json;
//   3. a baseline entry whose cardNumber HAS a real effects-zh translation, or
//      is no longer an official printing at all, is a hard failure — the
//      baseline must shrink to nothing as translations land and can never rot
//      into a blanket exemption.
const effectsZhPath = path.join(repo, 'data', 'effects-zh.json');
const zhGapPath = path.join(repo, 'data', 'official-skills-zh-gap.json');

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

function verifyDatabase(label, db, officialBySignature, products, zhGap) {
  assert.ok(db.cards && typeof db.cards === 'object', `${label} missing cards map`);
  const cards = Object.values(db.cards);
  const byProduct = new Map();
  const failures = [];
  for (const card of cards) {
    const sourceProduct = card?.sourceProduct || card?.series || '';
    if (!products.has(sourceProduct)) continue;
    if (!byProduct.has(sourceProduct)) byProduct.set(sourceProduct, []);
    byProduct.get(sourceProduct).push(card);

    for (const field of REQUIRED_DB_FIELDS) {
      if (!nonEmpty(card[field])) failures.push(`${label}:${sourceProduct}:${card.id || card.cardNumber}: missing ${field}`);
    }
    // DIC-1439: Traditional-Chinese skill text is required unless this exact
    // cardNumber is on the pinned, reviewable translation-gap baseline.
    if (!nonEmpty(card.skillsZh) && !zhGap.has(card.cardNumber)) {
      failures.push(`${label}:${sourceProduct}:${card.id || card.cardNumber}: missing skillsZh (cardNumber ${card.cardNumber} is not on the pinned data/official-skills-zh-gap.json baseline)`);
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

const meta = readJson(path.join(officialDir, '_meta.json'));
const products = productList(meta);
assert.ok(products.length > 0, 'data/official/_meta.json must contain dynamic product discovery results');

const productCodes = new Set(products.map((p) => p.code));
const officialBySignature = new Map();
const officialCardNumbers = new Set();
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
    if (row.cardNumber) officialCardNumbers.add(row.cardNumber);
    officialBySignature.set(signature(row), row);
  }
}
failList('official product file completeness', officialFailures);
if (Number.isInteger(meta.totalCards)) assert.equal(officialTotal, meta.totalCards, 'official _meta totalCards must equal dynamic product row total');

// DIC-1439: load and police the pinned Traditional-Chinese gap baseline BEFORE
// it is allowed to exempt anything, so it can only ever shrink (see the
// contract comment above REQUIRED_DB_FIELDS).
assert.ok(fs.existsSync(zhGapPath), 'missing data/official-skills-zh-gap.json pinned translation-gap baseline');
const zhGapFile = readJson(zhGapPath);
assert.ok(Array.isArray(zhGapFile.cardNumbers), 'data/official-skills-zh-gap.json must expose a cardNumbers array');
const zhGap = new Set(zhGapFile.cardNumbers);
const effectsZh = fs.existsSync(effectsZhPath) ? readJson(effectsZhPath) : {};
const baselineFailures = [];
for (const cardNumber of zhGap) {
  if (Object.hasOwn(effectsZh, cardNumber)) {
    baselineFailures.push(`${cardNumber}: has a real data/effects-zh.json translation — remove it from the pinned baseline`);
  }
  if (!officialCardNumbers.has(cardNumber)) {
    baselineFailures.push(`${cardNumber}: no longer an official printing — remove it from the pinned baseline`);
  }
}
failList('pinned skillsZh translation-gap baseline must shrink, never rot', baselineFailures);

const dbByProduct = verifyDatabase('data/database.json', readJson(dbPath), officialBySignature, productCodes, zhGap);
const publicByProduct = verifyDatabase('public/data/database.json', readJson(publicDbPath), officialBySignature, productCodes, zhGap);

const countFailures = [];
for (const { code, expectedCount } of products) {
  if (!Number.isInteger(expectedCount)) continue;
  const dbCount = dbByProduct.get(code)?.length || 0;
  const publicCount = publicByProduct.get(code)?.length || 0;
  if (dbCount !== expectedCount) countFailures.push(`${code}: data/database.json has ${dbCount}/${expectedCount}`);
  if (publicCount !== expectedCount) countFailures.push(`${code}: public/data/database.json has ${publicCount}/${expectedCount}`);
}
failList('database per-product official counts', countFailures);

console.log(`✓ official catalog completeness gate passed: ${products.length} products, ${officialTotal} official rows, skillsJp/nameZh/image coverage complete in canonical and public databases; skillsZh complete except ${zhGap.size} cardNumber(s) pinned in data/official-skills-zh-gap.json`);
