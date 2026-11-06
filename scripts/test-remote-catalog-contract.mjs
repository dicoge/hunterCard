#!/usr/bin/env node
/**
 * Remote native catalog — publication contract (2026-11-06).
 *
 *  1. The client's forbidden-field lists equal the server sanitizer's.
 *  2. The REAL publisher over the REAL canonical data produces exactly the bytes
 *     native already bundles (public/data/database.json), a manifest the client
 *     accepts, and an honest observation time (database.lastUpdated).
 *  3. Publication fails closed: a forbidden field, a missing observation time, or
 *     an attempt to overwrite an immutable asset throws BEFORE the manifest exists.
 *  4. The client only ever builds absolute https URLs on PRODUCTION_ORIGIN; the
 *     web loader keeps its same-origin relative URLs (legacy URLs stay stable).
 *
 * Read-only on repository data; writes only inside an OS temp directory.
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *        --import ./scripts/register-ts.mjs scripts/test-remote-catalog-contract.mjs
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as contract from '../src/services/catalog/catalogContract.ts';
import * as sanitizer from './lib/store-mvp-sanitize.mjs';
import {
  CLIENT_LIMITS,
  assertNativeCatalogSafe,
  buildNativeCatalogRelease,
  publishNativeCatalog,
} from './lib/native-catalog-publish.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');
const stripComments = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

console.log('── remote native catalog: publication contract ──');

test('client forbidden-field lists equal the server sanitizer lists', () => {
  assert.deepEqual([...contract.FORBIDDEN_CARD_FIELDS], sanitizer.FORBIDDEN_CARD_FIELDS);
  assert.deepEqual([...contract.FORBIDDEN_VARIANT_FIELDS], sanitizer.FORBIDDEN_VARIANT_FIELDS);
  assert.deepEqual([...contract.INTERNAL_AUDIT_FIELDS], sanitizer.INTERNAL_AUDIT_FIELDS);
  for (const k of Object.keys(CLIENT_LIMITS)) {
    assert.equal(CLIENT_LIMITS[k], contract.LIMITS[k], `publisher bound ${k} equals the client bound`);
  }
});

const canonical = JSON.parse(read('data/database.json'));
const seriesNames = JSON.parse(read('data/series-names.json'));
const NOW = new Date('2026-11-06T10:00:00.000Z');
const release = buildNativeCatalogRelease({ canonical, seriesNames, now: NOW });

test('the published database asset is byte-identical to the bundled native asset', () => {
  const dbAsset = release.assets.find((a) => a.rel.includes('/database.'));
  assert.equal(dbAsset.text, read('public/data/database.json'),
    'remote asset must equal JSON.stringify(sanitizeDatabase(canonical)) = public/data/database.json');
  const namesAsset = release.assets.find((a) => a.rel.includes('/series-names.'));
  assert.deepEqual(JSON.parse(namesAsset.text), seriesNames);
});

test('the client accepts the real manifest and the real assets', () => {
  const parsed = contract.parseCatalogManifest(JSON.stringify(release.manifest));
  assert.ok(parsed.ok, parsed.reason);
  const m = parsed.value;
  // Count derived from the source data, not frozen: the daily data legitimately grows
  // (3973 → 3975 in PR281 added hBP08-017_hPR_P_hBP08-017_P and …_02). Independent checks:
  // canonical id set == bundled public asset id set == published asset id set; the manifest
  // count equals that set's size and the canonical/public totalCards metadata.
  const canonicalIds = Object.keys(canonical.cards).sort();
  const publicDb = JSON.parse(read('public/data/database.json'));
  assert.deepEqual(Object.keys(publicDb.cards).sort(), canonicalIds, 'bundled public asset has exactly the canonical card-id set');
  assert.equal(m.cardCount, canonicalIds.length, 'manifest cardCount equals the full canonical card-id set');
  assert.equal(canonical.totalCards, canonicalIds.length, 'canonical totalCards metadata matches its entries');
  assert.equal(publicDb.totalCards, canonicalIds.length, 'public totalCards metadata matches its entries');
  assert.ok(m.cardCount >= 1000, 'catalog plausibly complete (client minCardCount floor)');
  assert.equal(m.dataObservedAt, canonical.lastUpdated, 'observation time is the data\'s own');
  assert.equal(m.publishedAt, NOW.toISOString(), 'publish time is build metadata');
  for (const a of release.assets) {
    const ref = a.rel.includes('/database.') ? m.assets.database : m.assets.seriesNames;
    assert.equal(ref.path, `/${a.rel}`);
    assert.equal(ref.bytes, Buffer.byteLength(a.text, 'utf8'));
    assert.equal(ref.sha256, crypto.createHash('sha256').update(a.text, 'utf8').digest('hex'));
    assert.equal(contract.utf8ByteLength(a.text), ref.bytes, 'client byte count agrees with the server');
  }
  const db = JSON.parse(release.assets.find((a) => a.rel.includes('/database.')).text);
  assert.deepEqual(Object.keys(db.cards).sort(), canonicalIds, 'published asset carries every canonical card id');
  const ok = contract.validateCatalogDatabase(db, { cardCount: m.cardCount, dataObservedAt: m.dataObservedAt, minCardCount: 1000 });
  assert.ok(ok.ok, ok.reason);
  assert.ok(contract.validateSeriesNames(seriesNames).ok);
});

test('genuine dataset growth publishes and validates; a manifest miscount or an omitted card fails closed', () => {
  // Growth: the real publisher over canonical data plus one added card (cloned shape, new id)
  // must produce a manifest whose count is exactly one more and which the real client accepts.
  const baseIds = Object.keys(canonical.cards);
  const grown = structuredClone(canonical);
  const newId = 'hZZ99-001_hZZ99_C_hZZ99-001_C';
  assert.ok(!(newId in grown.cards), 'synthetic growth id is not real data');
  grown.cards[newId] = { ...structuredClone(grown.cards[baseIds[0]]), id: newId, cardNumber: 'hZZ99-001', series: 'hZZ99' };
  grown.totalCards = baseIds.length + 1;
  const grownRelease = buildNativeCatalogRelease({ canonical: grown, seriesNames, now: NOW });
  const gm = contract.parseCatalogManifest(JSON.stringify(grownRelease.manifest));
  assert.ok(gm.ok, gm.reason);
  assert.equal(gm.value.cardCount, baseIds.length + 1, 'manifest follows the grown data');
  const grownDb = JSON.parse(grownRelease.assets.find((a) => a.rel.includes('/database.')).text);
  const grownOk = contract.validateCatalogDatabase(grownDb, { cardCount: gm.value.cardCount, dataObservedAt: gm.value.dataObservedAt, minCardCount: 1000 });
  assert.ok(grownOk.ok, grownOk.reason);

  // Negative 1: a manifest that over-counts the unchanged real asset is rejected by the real client.
  const realDb = JSON.parse(release.assets.find((a) => a.rel.includes('/database.')).text);
  const miscount = contract.validateCatalogDatabase(realDb, {
    cardCount: release.manifest.cardCount + 1, dataObservedAt: release.manifest.dataObservedAt, minCardCount: 1000 });
  assert.equal(miscount.ok, false);
  assert.match(miscount.reason, /card count differs from manifest/);

  // Negative 2: an asset that silently omits one real card (e.g. one of PR281's two new hPR
  // printings) against the honest manifest count is rejected.
  const omitted = structuredClone(realDb);
  const victim = Object.keys(omitted.cards).find((k) => k.startsWith('hBP08-017_hPR_P_hBP08-017_P')) ?? Object.keys(omitted.cards)[0];
  delete omitted.cards[victim];
  const omittedResult = contract.validateCatalogDatabase(omitted, {
    cardCount: release.manifest.cardCount, dataObservedAt: release.manifest.dataObservedAt, minCardCount: 1000 });
  assert.equal(omittedResult.ok, false);
  assert.match(omittedResult.reason, /card count differs from manifest/);
});

test('client rejects the raw canonical database (forbidden/internal fields)', () => {
  const v = contract.validateCatalogDatabase(canonical, { cardCount: Object.keys(canonical.cards).length, dataObservedAt: canonical.lastUpdated, minCardCount: 1 });
  assert.equal(v.ok, false);
  assert.match(v.reason, /forbidden field/);
});

test('publisher fails closed on unsafe input and missing observation time', () => {
  assert.throws(() => assertNativeCatalogSafe({ cards: { a: { id: 'a', cardNumber: 'a', priceHistory: {} } } }), /priceHistory/);
  assert.throws(() => assertNativeCatalogSafe({ cards: { a: { id: 'a', prices: [{ buyPrice: 1 }] } } }), /buyPrice/);
  assert.throws(() => assertNativeCatalogSafe({ cards: { a: { id: 'b' } } }), /has id/);
  const noTime = { ...canonical };
  delete noTime.lastUpdated;
  assert.throws(() => buildNativeCatalogRelease({ canonical: noTime, seriesNames, now: NOW }), /lastUpdated/);
});

test('publish writes assets first and the manifest last; a failed asset leaves no manifest', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'native-catalog-'));
  try {
    const canonicalPath = path.join(repoRoot, 'data/database.json');
    const seriesNamesPath = path.join(repoRoot, 'data/series-names.json');
    // Pre-place a DIFFERENT file at the immutable database path: publication must refuse.
    const dbRel = release.assets.find((a) => a.rel.includes('/database.')).rel;
    fs.mkdirSync(path.dirname(path.join(tmp, dbRel)), { recursive: true });
    fs.writeFileSync(path.join(tmp, dbRel), 'tampered');
    assert.throws(() => publishNativeCatalog({ canonicalPath, seriesNamesPath, distDir: tmp, now: NOW }), /immutable/);
    assert.equal(fs.existsSync(path.join(tmp, 'data/catalog/manifest.json')), false, 'no manifest for an incomplete publication');
    fs.rmSync(path.join(tmp, dbRel));
    const manifest = publishNativeCatalog({ canonicalPath, seriesNamesPath, distDir: tmp, now: NOW });
    assert.deepEqual(manifest, release.manifest, 'deterministic for the same inputs and time');
    for (const a of release.assets) assert.equal(fs.readFileSync(path.join(tmp, a.rel), 'utf8'), a.text);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, 'data/catalog/manifest.json'), 'utf8')), release.manifest);
    // Re-publishing identical content is idempotent.
    publishNativeCatalog({ canonicalPath, seriesNamesPath, distDir: tmp, now: NOW });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('utf8ByteLength matches Node for ASCII, CJK, emoji and a lone surrogate', () => {
  for (const s of ['abc', 'ブルーミングレディアンス', '🥓 ok', 'x\ud800y', '']) {
    assert.equal(contract.utf8ByteLength(s), Buffer.byteLength(s, 'utf8'), JSON.stringify(s));
  }
});

test('native catalog code builds only absolute PRODUCTION_ORIGIN URLs; web keeps same-origin legacy URLs', () => {
  const repoSrc = stripComments(read('src/services/catalog/catalogRepository.ts'));
  assert.match(repoSrc, /import \{ PRODUCTION_ORIGIN \} from '\.\.\/\.\.\/config\/apiOrigin'/);
  assert.match(repoSrc, /`\$\{PRODUCTION_ORIGIN\}\$\{MANIFEST_PATH\}`/);
  assert.match(repoSrc, /`\$\{PRODUCTION_ORIGIN\}\$\{m\.assets\.database\.path\}`/);
  for (const rel of ['src/services/catalog/catalogRepository.ts', 'src/services/catalog/catalogPlatform.native.ts', 'src/utils/staticData.ts']) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(src, /fetch\(\s*['"`]\//, `${rel} must never fetch a relative URL (the DIC-972 bug)`);
    assert.doesNotMatch(src, /https?:\/\/(?!holohunter\.dicoge\.com)[a-z0-9.-]+\.[a-z]/i, `${rel} must not name another origin`);
  }
  assert.equal(contract.MANIFEST_PATH, '/data/catalog/manifest.json');
  const web = stripComments(read('src/utils/staticData.web.ts'));
  assert.match(web, /fetchJson\('\/data\/database\.json'/, 'web keeps the stable legacy database URL');
  assert.match(web, /fetchJson\('\/data\/series-names\.json'/, 'web keeps the stable legacy series-names URL');
  const fixHtml = read('scripts/fix-html.js');
  assert.match(fixHtml, /publishNativeCatalog\(/, 'the existing export step publishes the catalog');
  assert.match(fixHtml, /dist', 'data', 'database\.json'|'data', 'database\.json'/, 'legacy dist/data/database.json still produced');
});

test('no code download: the catalog modules never evaluate fetched text', () => {
  for (const rel of ['src/services/catalog/catalogRepository.ts', 'src/services/catalog/catalogContract.ts', 'src/services/catalog/catalogPlatform.native.ts']) {
    const src = stripComments(read(rel));
    assert.doesNotMatch(src, /\beval\(|new Function\(|\bimport\(/, `${rel} must treat downloads as data only`);
  }
});

console.log(`\n✅ remote catalog contract: ${passed} checks passed`);
