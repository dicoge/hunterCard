#!/usr/bin/env node
/**
 * v44 CR 14f19ab P2: every entry that hands a card to 加入 resolves the PROVEN version and
 * its current proven quote (hBD24-023: ent07 aggregation row JPY 8,980 2026-10-1x + hPR
 * row JPY 9,980 2026-08-25, same shop listing) — without depending on a warmed catalog.
 *   cold      the API answers with the hPR row ALONE before the catalog was ever loaded
 *             (recognizeCardFromImage, native payload) → 8,980; then exact-id lookups of
 *             BOTH raw ids and the search suggestions → 加入 → session 8,980
 *   warm      same API answer after loadAllCards → 8,980; an API row with a NEWER own quote
 *             (9,500, quoted strictly after every catalog quote of the proven version — the
 *             time is DERIVED from the loaded catalog, never a calendar literal, because the
 *             nightly scrape re-dates the ent07 row) is not replaced by the catalog copy →
 *             9,500. Negative controls: an OLDER own quote loses to the catalog quote, a
 *             same-time different price is a conflict (no price), and a later catalog
 *             refresh beats a time that was not re-derived.
 *   nocatalog the catalog cannot load → the API row stays as sent (9,980): no sibling
 *             evidence is invented
 * The API response is served in memory; no HTTP, provider or quota.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { register } from 'node:module';
import { JSDOM } from 'jsdom';
import { FrameScannerView } from './fixtures/native-frame-scanner-fixture.mjs';
let scannerModulePresent = true;
let viewManagerThrows = false;   // the view manager fails to load (module registered, view not)

// Modes that need a modified / failing catalog swap the platform loader for a fixture;
// every other mode runs the REAL native loader (src/utils/staticData.ts, bundled catalog).
if (['nocatalog'].includes(process.argv[2])) process.env.V44_CATALOG_FIXTURE = '1';
register(
  'data:text/javascript,' + encodeURIComponent(`
    const RN = ${JSON.stringify(new URL('./fixtures/react-native-android-shim.mjs', import.meta.url).href)};
    const CAMERA = ${JSON.stringify(new URL('./fixtures/native-camera-fixture.mjs', import.meta.url).href)};
    const PICKER = ${JSON.stringify(new URL('./fixtures/native-image-picker-fixture.mjs', import.meta.url).href)};
    export async function resolve(specifier, context, next) {
      if (specifier === 'react-native' && !String(context.parentURL || '').endsWith('react-native-android-shim.mjs')) return { url: RN, shortCircuit: true };
      if (specifier === 'expo-camera') return { url: CAMERA, shortCircuit: true };
      if (specifier.endsWith('/utils/staticData') && ${JSON.stringify(process.env.V44_CATALOG_FIXTURE === '1')}) return { url: ${JSON.stringify(new URL('./fixtures/static-data-fixture.mjs', import.meta.url).href)}, shortCircuit: true };
      if (specifier === 'expo-image-picker') return { url: PICKER, shortCircuit: true };
      if ((specifier.endsWith('/scanRuntime') || specifier.endsWith('/webOcr')) && context.parentURL) {
        return next(new URL(specifier + '.native.ts', context.parentURL).href, context);
      }
      return next(specifier, context);
    }
  `),
  import.meta.url,
);

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
Object.defineProperty(dom.window, 'innerWidth', { value: 390, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 844, configurable: true });
if (!dom.window.matchMedia) {
  dom.window.matchMedia = () => ({ matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia;
}

// Measured window rects (preview below a 56px header, frame inside it).
let PREVIEW = { x: 0, y: 56, width: 390, height: 788 };
let FRAME = { x: 28, y: 150, width: 335, height: 468 };
const rectOf = (r) => ({ x: r.x, y: r.y, left: r.x, top: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height });
const realRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
  const id = this.getAttribute?.('data-testid');
  if (id === 'scan-camera-box') return rectOf(PREVIEW);
  if (id === 'scan-frame') return rectOf(FRAME);
  return realRect.call(this);
};

const jpeg = (tag) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(tag.repeat(40))]).toString('base64');
const FULL_B64 = jpeg('context'), CROP_B64 = jpeg('crop');
// What the on-device reader "sees" inside the frame on each call (probe or fallback).
let frameText = '';
let ocrThrows = false;
// Hold the on-device reader (a probe stays in flight until released).
let ocrHold = null;
const holdReader = () => { let release; const p = new Promise((r) => { release = r; }); ocrHold = p; return () => { ocrHold = null; release(); }; };
// Where the printed number sits in the probe crop (normalised); a steady, in-frame spot
// unless a test moves it. A function lets a test move it on every probe.
let numberBox = () => ({ x: 0.1, y: 0.86, width: 0.22, height: 0.04 });
// v42 (PM BLOCK_GROUPING_REPRO): the SAME printed number, alternately grouped by ML Kit
// with the line above it into one block, or standalone. Number line/element: fixed.
let alternateGrouping = false;
let geometryOn = false;
let groupingParity = 0;
const geometryCalls = [];
const groupedFrame = (uri) => {
  const d = cropDims.get(uri) ?? { w: 900, h: 1200 };
  const b = numberBox();
  const num = { x: Math.round(b.x * d.w), y: Math.round(b.y * d.h), width: Math.round(b.width * d.w), height: Math.round(b.height * d.h) };
  const grouped = (groupingParity++ % 2) === 0;
  const above = { x: num.x, y: num.y - 4 * num.height, width: Math.round(num.width * 1.1), height: num.height };
  const numberLine = { text: frameText, boundingBox: num, elements: [{ text: frameText, boundingBox: num }] };
  return grouped
    ? { text: `illustrator text\n${frameText}`, boundingBox: { x: num.x, y: above.y, width: above.width, height: num.y + num.height - above.y },
      lines: [{ text: 'illustrator text', boundingBox: above, elements: [] }, numberLine] }
    : { text: frameText, boundingBox: num, lines: [numberLine] };
};
const cropDims = new Map();
const ocrCalls = [];
const manipulations = [];
const deleted = [];
let cropSeq = 0;
globalThis.__nativeCameraUniqueUris = true;
globalThis.require = (name) => {
  if (name === 'expo-file-system/legacy') return { deleteAsync: async (uri) => { deleted.push(uri); } };
  if (name === 'expo-image-manipulator') {
    return {
      SaveFormat: { JPEG: 'jpeg' },
      ImageManipulator: {
        manipulate(uri) {
          const ops = [];
          const ctx = {
            crop(r) { ops.push(['crop', r]); return ctx; },
            resize(r) { ops.push(['resize', r]); return ctx; },
            async renderAsync() {
              return { async saveAsync(o) {
                manipulations.push({ uri, ops, base64: !!o?.base64 });
                const isCrop = ops.some((x) => x[0] === 'crop');
                const n = ++cropSeq;
                const outUri = isCrop ? `file:///cache/ImageManipulator/frame-${n}.jpg` : `file:///cache/ImageManipulator/full-${n}.jpg`;
                // Report the saved size like the real manipulator does.
                const c = ops.find((x) => x[0] === 'crop')?.[1];
                const r = ops.find((x) => x[0] === 'resize')?.[1];
                let w = c ? c.width : 3024, h = c ? c.height : 4032;
                if (r?.width) { h = Math.round(h * r.width / w); w = r.width; } else if (r?.height) { w = Math.round(w * r.height / h); h = r.height; }
                cropDims.set(outUri, { w, h });
                return { base64: o?.base64 ? (isCrop ? CROP_B64 : FULL_B64) : undefined, uri: outUri, width: w, height: h };
              } };
            },
          };
          return ctx;
        },
      },
    };
  }
  if (name === 'expo-ocr-kit') return { recognizeText: async (uri) => {
    ocrCalls.push(uri);
    if (ocrHold) await ocrHold;
    if (ocrThrows) throw new Error('reader crashed');
    if (alternateGrouping && frameText) {
      const f = groupedFrame(uri);
      return { text: f.text, blocks: [{ text: f.text, boundingBox: f.boundingBox }] };   // block-only export (v41 native)
    }
    const d = cropDims.get(uri) ?? { w: 900, h: 1200 };
    const b = numberBox();
    const blocks = frameText ? [{ text: frameText, boundingBox: { x: Math.round(b.x * d.w), y: Math.round(b.y * d.h), width: Math.round(b.width * d.w), height: Math.round(b.height * d.h) } }] : [];
    return { text: frameText, blocks };
  } };
  // v42: the local native module modules/holohunter-ocr-geometry, reached through
  // expo-modules-core like on a device; only exposed when a test turns it on.
  if (name === 'expo-modules-core') return {
    requireNativeViewManager: (n) => {
      if (n === 'HoloHunterCardScanner' && viewManagerThrows) throw new Error("Unable to find the 'HoloHunterCardScanner' view manager");
      return n === 'HoloHunterCardScanner' ? FrameScannerView : null;
    },
    requireOptionalNativeModule: (n) => (n === 'HoloHunterCardScanner' && scannerModulePresent ? {} : n === 'HoloHunterOcrGeometry' && geometryOn ? {
      recognizeGeometry: async (uri) => {
        geometryCalls.push(uri);
        ocrCalls.push(uri);
        if (!frameText) return { text: '', blocks: [] };
        const f = groupedFrame(uri);
        return { text: f.text, blocks: [{ text: f.text, boundingBox: f.boundingBox, lines: f.lines }] };
      },
    } : null),
  };
  throw new Error(`unexpected require ${name}`);
};
globalThis.__nativeCameraPhoto = { uri: 'file:///cache/Camera/shot.jpg', width: 3024, height: 4032, base64: jpeg('original') };
globalThis.__frameScannerStillBase64 = jpeg('still');

const DB = JSON.parse(fs.readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
let providerDown = false;
const bodies = [];
let providerText = 'CARD_NUMBER: hBP01-010\nCHARACTER: 天音かなた';
globalThis.fetch = async (url, init = {}) => {
  const href = String(url);
  if (href === 'https://holohunter.dicoge.com/data/database.json') return Response.json(DB);
  if (href.includes('generativelanguage.googleapis.com')) {
    if (providerDown) return new Response('down', { status: 500 });
    return Response.json({ candidates: [{ content: { parts: [{ text: providerText }] } }] });
  }
  if (href.includes('/api/recognize-card')) {
    bodies.push(JSON.parse(init.body));
    const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', { method: 'POST', body: init.body, headers: { 'Content-Type': 'application/json' } }));
    const text = await res.text();
    return { ok: res.ok, status: res.status, json: async () => JSON.parse(text) };
  }
  return { ok: false, status: 404, json: async () => ({}), text: async () => '' };
};

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const { default: ScanScreen } = await import('../src/screens/ScanScreen.tsx');
const { planNativeCrop } = await import('../src/utils/scanFrame.ts');
const { usePhotoUploadConsentStore } = await import('../src/store/photoUploadConsentStore.ts');
const { PHOTO_UPLOAD_DISCLOSURE_VERSION } = await import('../src/services/photoUploadDisclosure.ts');
const { useScanQuotaStore } = await import('../src/store/scanQuotaStore.ts');
const { useScanSessionStore } = await import('../src/stores/scanSessionStore.ts');
const { FRAME_ANALYSIS_INTERVAL_MS, frameCropInFrame } = await import('../src/services/nativeCardScanner.ts');
const { DEFAULT_FRAME_REGION } = await import('../src/services/autoCapture.ts');





const MODE = ['cold', 'warm', 'nocatalog'].includes(process.argv[2]) ? process.argv[2] : 'cold';
const ENT07 = 'hBD24-023_ent07', HPR = 'hBD24-023_hPR_P_hBD24-023_P';
const { provenanceFromRow } = await import('../src/utils/printingQuotes.ts');
const rec = await import('../src/services/cardRecognition.ts');
const { getEffectivePrice } = await import('../src/stores/scanSessionStore.ts');
// The API's single-card success: its own row, as fmt() sends it (no candidates).
const apiRow = (over = {}) => {
  const r = { ...DB.cards[HPR], ...over };
  return { id: r.id, cardNumber: r.cardNumber, name: r.name, sellPrice: r.sellPrice, rarity: r.rarity, series: r.series,
    imageUrl: r.officialImage || r.localImage || '', prices: over.sellPrice ? [{ name: r.name, sellPrice: over.sellPrice, rarity: r.rarity }] : r.prices,
    priceHistory: {}, provenance: provenanceFromRow(r), type: '', normalized: {} };
};
let apiBody = { success: true, card: apiRow() };
// Like React Native: there is no page origin, a relative URL cannot be fetched. The catalog
// must come from the platform loader (native: bundled asset), never from fetch('/data/…').
let relativeFetches = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  const href = String(url);
  if (!/^https?:\/\//.test(href)) { relativeFetches += 1; throw new TypeError(`Network request failed (no origin): ${href}`); }
  if (href.includes('/data/')) throw new Error(`catalog must not come from the network: ${href}`);
  if (href.includes('/api/recognize-card')) return { ok: true, status: 200, json: async () => apiBody };
  return realFetch(url, init);
};
if (MODE === 'nocatalog') { globalThis.__catalogDb = DB; globalThis.__catalogFail = true; }
const dbFetches = 0;
let passed = 0;
const check = async (label, fn) => { try { await fn(); passed += 1; console.log(`  ✓ ${label}`); } catch (e) { process.exitCode = 1; console.error(`  ✗ ${label} — ${e.message}`); } };
const recognizeOnce = () => rec.recognizeCardFromImage('file:///cache/Camera/shot.jpg', { base64: jpeg('scan') });
const addAndPrice = (card) => {
  useScanSessionStore.getState().clearSession();
  useScanSessionStore.getState().addCard(card, { force: true });
  const c = useScanSessionStore.getState().cards[0];
  return { effective: getEffectivePrice(c), total: useScanSessionStore.getState().totalValue, quotes: (c.priceQuotes ?? []).map((q) => q.price).sort() };
};

if (MODE === 'warm') await rec.loadAllCards();
const fetchesBefore = dbFetches;
const r1 = await recognizeOnce();
console.log(`    API ${MODE} ${JSON.stringify({ id: r1.card?.id, sellPrice: r1.card?.sellPrice, aliasIds: r1.card?.aliasIds, catalogFetchesBefore: fetchesBefore })}`);
if (MODE === 'nocatalog') {
  await check('catalog load fails: the API row stays exactly as sent (9,980), no alias / sibling price invented', () => {
    assert.equal(r1.card.id, HPR);
    assert.equal(r1.card.sellPrice, 9980);
    assert.ok(!r1.card.aliasIds);
  });
} else {
  await check(`${MODE}: the API's single hPR card resolves to the proven version at its latest same-listing quote 8,980 (both aliases + quotes kept)`, () => {
    assert.equal(r1.card.sellPrice, 8980);
    assert.deepEqual([...r1.card.aliasIds].sort(), [ENT07, HPR]);
    assert.deepEqual(addAndPrice(r1.card), { effective: 8980, total: 8980, quotes: [8980, 9980] });
  });
}
if (MODE === 'warm') {
  // The synthetic quote's time is derived from the catalog the app actually loaded: strictly
  // after the latest valid quote of the proven version (both ENT07 and HPR rows). The scrape
  // re-dates these rows, so a fixed calendar time silently stops being "newer" (PR269).
  const OWN_PRICE = 9500;
  const STEP_MS = 24 * 60 * 60 * 1000;
  const quoteMs = (row) => {
    const ms = Date.parse(row?.provenance?.quotedAt ?? '');
    assert.ok(Number.isFinite(ms) && ms > 0, `${row?.id}: catalog quote time must be valid (${row?.provenance?.quotedAt})`);
    return ms;
  };
  const versionRows = (catalog) => {
    const rows = catalog.filter((c) => c.id === ENT07 || c.id === HPR);
    assert.deepEqual(rows.map((c) => c.id).sort(), [ENT07, HPR].sort(), 'both rows of the proven version are in the catalog');
    return rows;
  };
  const latestMs = (catalog) => Math.max(...versionRows(catalog).map(quoteMs));
  const iso = (ms) => new Date(ms).toISOString();
  const sellQuotes = (card) => (card.priceQuotes ?? []).filter((q) => q.type === 'sell').map((q) => q.price).sort();
  const catalog = await rec.loadAllCards();
  const ent07Row = catalog.find((c) => c.id === ENT07);
  const LATEST = latestMs(catalog);
  const NEWER = iso(LATEST + STEP_MS);
  const ownCard = (quotedAt) => {   // the API's own HPR row as the client maps it, with its own quote
    const base = catalog.find((c) => c.id === HPR);
    return { ...base, sellPrice: OWN_PRICE, prices: [{ name: base.name, sellPrice: OWN_PRICE, rarity: base.rarity }],
      provenance: { ...base.provenance, quotedAt } };
  };
  await check('warm: fixture precondition — the own quote is a different price and strictly newer than every catalog quote of the proven version', () => {
    assert.notEqual(ent07Row.sellPrice, OWN_PRICE);
    for (const row of versionRows(catalog)) assert.ok(Date.parse(NEWER) > quoteMs(row), `${NEWER} must be after ${row.id} ${row.provenance.quotedAt}`);
  });
  await check(`warm: an API row with its OWN newer quote (${OWN_PRICE}, after the latest catalog quote) is not replaced by the catalog copy → ${OWN_PRICE}`, async () => {
    apiBody = { success: true, card: apiRow({ sellPrice: OWN_PRICE, timestamp: NEWER }) };
    const r = await recognizeOnce();
    assert.equal(r.card.sellPrice, OWN_PRICE);
    assert.equal(r.card.provenance?.quotedAt, NEWER);
    assert.deepEqual([...r.card.aliasIds].sort(), [ENT07, HPR].sort());
    assert.equal(addAndPrice(r.card).effective, OWN_PRICE);
  });
  await check('warm negative: an OLDER own quote cannot replace the newer catalog quote → the catalog price', async () => {
    const OLDER = iso(quoteMs(ent07Row) - STEP_MS);
    assert.ok(Date.parse(OLDER) < quoteMs(ent07Row));
    apiBody = { success: true, card: apiRow({ sellPrice: OWN_PRICE, timestamp: OLDER }) };
    const r = await recognizeOnce();
    assert.equal(r.card.sellPrice, ent07Row.sellPrice);
    assert.notEqual(r.card.sellPrice, OWN_PRICE);
    assert.deepEqual(sellQuotes(r.card), [OWN_PRICE, ent07Row.sellPrice].sort(), 'the older quote is kept, not dropped');
  });
  await check('warm negative: an own quote at the SAME time as the catalog quote with a different price is a conflict (no current price)', async () => {
    const SAME = ent07Row.provenance.quotedAt;
    apiBody = { success: true, card: apiRow({ sellPrice: OWN_PRICE, timestamp: SAME }) };
    const r = await recognizeOnce();
    assert.deepEqual([...r.card.aliasIds].sort(), [ENT07, HPR].sort());
    assert.equal(r.card.sellPrice, null);
    assert.equal(r.card.priceConflict, true);
    assert.deepEqual(sellQuotes(r.card), [OWN_PRICE, ent07Row.sellPrice].sort());
  });
  await check('warm perturbation: a later catalog refresh beats a time that was not re-derived; re-deriving restores "newer" (no calendar assumption)', () => {
    // The catalog's ENT07 row is re-quoted after the time chosen above (what the nightly scrape did).
    const refreshed = catalog.map((c) => (c.id === ENT07 ? { ...c, provenance: { ...c.provenance, quotedAt: iso(Date.parse(NEWER) + STEP_MS) } } : c));
    assert.ok(latestMs(refreshed) > Date.parse(NEWER));
    const stale = rec.provenVersionOf(ownCard(NEWER), refreshed);
    assert.equal(stale.sellPrice, ent07Row.sellPrice, 'a stale fixed time loses to the refreshed catalog quote');
    const rederived = iso(latestMs(refreshed) + STEP_MS);
    const fresh = rec.provenVersionOf(ownCard(rederived), refreshed);
    assert.equal(fresh.sellPrice, OWN_PRICE);
    // Same production path on the unperturbed catalog agrees with the API flow above.
    assert.equal(rec.provenVersionOf(ownCard(NEWER), catalog).sellPrice, OWN_PRICE);
  });
}
if (MODE === 'cold') {
  for (const id of [HPR, ENT07]) {
    await check(`exact-id lookup recognizeCard('${id}') → proven version → 加入 → session 8,980`, async () => {
      const r = await rec.recognizeCard(id);
      assert.equal(r.success, true);
      assert.deepEqual([...r.card.aliasIds].sort(), [ENT07, HPR], 'the raw id still resolves');
      assert.equal(r.card.sellPrice, 8980);
      assert.deepEqual(addAndPrice(r.card), { effective: 8980, total: 8980, quotes: [8980, 9980] });
    });
  }
  await check('search suggestions: hBD24-023 is ONE suggestion at 8,980 → 加入 → session 8,980', async () => {
    const list = await rec.searchCards('hBD24-023', 10);
    const hits = list.filter((c) => c.cardNumber === 'hBD24-023');
    assert.equal(hits.length, 1, hits.map((c) => `${c.id}:${c.sellPrice}`).join(' | '));
    assert.equal(hits[0].sellPrice, 8980);
    assert.equal(addAndPrice(hits[0]).effective, 8980);
  });
  await check('genuinely different printings are untouched: hBP01-024 search still lists its separate printings', async () => {
    const rows = (await rec.loadAllCards()).filter((c) => c.cardNumber === 'hBP01-024');
    const list = (await rec.searchCards('hBP01-024', 50)).filter((c) => c.cardNumber === 'hBP01-024');
    assert.ok(list.length >= 2 && list.length <= rows.length, `${list.length} of ${rows.length}`);
  });
}
await check('no relative-URL fetch was attempted (catalog from the platform loader)', () => assert.equal(relativeFetches, 0));
if (MODE !== 'nocatalog') {
  await check('the REAL native loader (src/utils/staticData.ts → bundled public/data/database.json) served the catalog', async () => {
    const { loadDatabaseJson } = await import('../src/utils/staticData.ts');
    const bundled = await loadDatabaseJson();
    assert.ok(bundled.cards[HPR] && bundled.cards[ENT07]);
    assert.equal((await rec.loadAllCards()).length, Object.keys(bundled.cards).length);
    assert.equal(globalThis.__catalogLoads ?? 0, 0, 'the test fixture loader was not used');
  });
}
if ((process.exitCode ?? 0) === 0) console.log(`\n✅ printing-quote-entries (${MODE}): ${passed} checks passed`);
else console.error(`\n❌ printing-quote-entries (${MODE}) failed`);
process.exit();
