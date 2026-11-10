#!/usr/bin/env node
/**
 * v44 P0 (user report: "same printing, different price"): printing versions and quote
 * provenance — pure rules (src/utils/printingQuotes) on the 10 prepared identity cases,
 * then the REAL data path for the collision the investigation found in the shipped
 * catalog (hBD24-023: an `ent07` aggregation row JPY 8,980 quoted 2026-10-17 and the
 * `hPR` row JPY 9,980 quoted 2026-08-25, same shop listing, same official image):
 *   local catalog (loadAllCards) → resolver → actual ScanCandidateSelector,
 *   API (real recognize-card handler, provider stubbed) → apiCardMapper → candidates.
 * No network: database / provider fetches are answered in memory. The repo's data files
 * are read only.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

process.env.EXPO_PUBLIC_STORE_MVP = '1';
const CASES = JSON.parse(fs.readFileSync(new URL('./fixtures/v44-printing/price-identity-cases.json', import.meta.url), 'utf8'));
const DB_BYTES = fs.readFileSync(new URL('../public/data/database.json', import.meta.url));
const database = JSON.parse(DB_BYTES);

let providerText = 'CARD_NUMBER: hBD24-023\nCHARACTER: 癒月ちょこ\nRARITY: P';
let fetches = 0;
globalThis.fetch = async (url) => {
  const href = String(url);
  fetches += 1;
  if (href.includes('/data/database.json')) return Response.json(database);
  if (href.includes('generativelanguage.googleapis.com')) {
    return Response.json({ candidates: [{ content: { parts: [{ text: providerText }] } }] });
  }
  throw new Error(`unexpected fetch: ${href}`);
};

const { buildPrintingVersions, provenanceFromRow, samePrintingProof } = await import('../src/utils/printingQuotes.ts');
const { loadAllCards, resolvePrintingByCardNumber, consolidatePrintingCards } = await import('../src/services/cardRecognition.ts');
const { mapApiCardToCardInfo } = await import('../src/utils/apiCardMapper.ts');
const { buildPrintingDisplayRows } = await import('../src/utils/printingDisplay.ts');
const React = (await import('react')).default;
const { renderToStaticMarkup } = await import('react-dom/server');
const { default: Selector } = await import('../src/components/ScanCandidateSelector.tsx');

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

// Fixture row → the module's row shape (listingIdentity is the shop listing).
const asRow = (r) => ({
  id: r.id, cardNumber: r.cardNumber, rarity: r.rarity, sellPrice: r.sellPrice,
  artIdentity: r.artIdentity, physicalPrinting: r.physicalPrinting, priceType: r.priceType,
  provenance: provenanceFromRow({ ...r, listing: r.listingIdentity, quoteSource: r.source }),
});
const caseRows = (name) => CASES.cases.find((c) => c.name === name).inputRows.map(asRow);
const versionsOf = (name) => buildPrintingVersions(caseRows(name));
const sellHistory = (v) => v.quotes.filter((q) => q.type === 'sell').map((q) => q.price).sort((a, b) => a - b);

await test('proven same printing + same listing: ONE version, current = the latest quote (8,980), both quotes and both raw rows kept', () => {
  const v = versionsOf('proven_same_printing_same_source_listing_latest_quote');
  assert.equal(v.length, 1);
  assert.equal(v[0].proof, 'explicit');
  assert.equal(v[0].currentSell.price, 8980);
  assert.deepEqual(sellHistory(v[0]), [8980, 9980]);
  assert.deepEqual(v[0].memberIds.sort(), ['alias-A', 'official-A']);
});
await test('same images + same listing but NO printing proof: two versions kept, flagged lookalike, each with its OWN price', () => {
  const v = versionsOf('same_images_but_alias_unproven_no_blind_merge');
  assert.equal(v.length, 2);
  assert.ok(v.every((x) => x.lookalike && x.proof === null));
  assert.deepEqual(v.map((x) => x.currentSell.price).sort(), [8980, 9980]);
  assert.ok(v.every((x) => x.primary.provenance.quotedAt && x.primary.provenance.sourceProduct), 'dates + sources to show');
});
await test('different rarity / different art / different language: separate versions', () => {
  for (const name of ['same_number_different_rarity_art_remain_separate', 'same_number_same_rarity_different_art_remain_separate', 'different_language_no_merge']) {
    assert.equal(versionsOf(name).length, 2, name);
  }
});
await test('buy vs sell: one version, typed quotes separate (sell 8,980, buy 7,000)', () => {
  const v = versionsOf('buy_vs_sell_not_two_versions_or_interchangeable');
  assert.equal(v.length, 1);
  assert.equal(v[0].currentSell.price, 8980);
  assert.equal(v[0].currentBuy.price, 7000);
});
await test('different conditions: one version, two labelled quote options, no single "current" price', () => {
  const v = versionsOf('different_conditions_label_and_preserve');
  assert.equal(v.length, 1);
  assert.deepEqual(v[0].conditions.sort(), ['NM', 'played']);
  assert.equal(v[0].currentSell, null);
});
await test('same-time conflicting quotes: no current price (neither max nor min), conflict visible, both kept', () => {
  const v = versionsOf('same_timestamp_conflicting_quote_no_arbitrary_max_or_min');
  assert.equal(v.length, 1);
  assert.equal(v[0].currentSell, null);
  assert.equal(v[0].sellConflict, true);
  assert.deepEqual(sellHistory(v[0]), [8980, 9980]);
});
await test('unknown language / condition stay unknown (null), not assumed', () => {
  const [v] = versionsOf('unknown_language_condition_not_assumed');
  assert.equal(v.primary.provenance.language, null);
  assert.equal(v.primary.provenance.condition, null);
});
await test('no quote: never borrows the sibling version\'s price', () => {
  const v = versionsOf('no_quote_sibling_price_never_borrowed');
  assert.equal(v.length, 2);
  assert.equal(v.find((x) => x.memberIds.includes('alias-A')).currentSell, null);
});

await test('CR e8f14dc P2 #2: an unknown-rarity aggregation row never bridges a known P and a known SR printing (group-wide consistency)', () => {
  const common = { cardNumber: 'hBP01-010', imageUrl: 'https://fixture.invalid/art/same.png', sellPrice: 100 };
  const prov = { sourceProduct: 'hBP01', sourceProductName: 'A', quotedAt: '2026-10-18T12:00:00Z', listing: 'https://card.yuyu-tei.jp/hocg/100_140/hBP01/one.jpg', quoteSource: 'yuyu-tei', language: null, condition: null };
  const agg = { ...common, id: 'aggregate-unknown', rarity: '', provenance: { ...prov, sourceProduct: 'ent07' } };
  const p = { ...common, id: 'official-P', rarity: 'P', provenance: prov };
  const sr = { ...common, id: 'official-SR', rarity: 'SR', provenance: { ...prov, sourceProduct: 'hPR' } };
  const three = buildPrintingVersions([agg, p, sr]);
  assert.equal(three.length, 3, JSON.stringify(three.map((v) => v.memberIds)));
  assert.ok(three.every((v) => v.memberIds.length === 1));
  // in any order
  assert.equal(buildPrintingVersions([sr, agg, p]).length, 3);
  // …while the unambiguous pair still joins
  const two = buildPrintingVersions([agg, p]);
  assert.equal(two.length, 1);
  assert.equal(two[0].proof, 'aggregate-alias-same-listing');
});

// ── the real shipped collision ──
const real = CASES.actualCollisionRows;

// The daily scrape re-quotes the ent07 row (2026-10-17 when investigated, 2026-10-22 in
// CI run 39776779489), so its date is never hardcoded. Expected quote / date come from the
// RAW catalog rows directly — not provenanceFromRow / buildPrintingVersions, which are
// under test: the newest priced row on the investigated listing, its day in UTC.
const RAW = JSON.parse(DB_BYTES).cards;
const LISTING = real[0].yuyuImage;
const latestListingQuote = (rows) => {
  const quoted = rows.filter((r) => r.yuyuImage === LISTING && r.sellPrice > 0 && Number.isFinite(Date.parse(r.timestamp)));
  const top = Math.max(...quoted.map((r) => Date.parse(r.timestamp)));
  const atTop = quoted.filter((r) => Date.parse(r.timestamp) === top);
  assert.equal(new Set(atTop.map((r) => r.sellPrice)).size, 1, 'oracle: no same-time conflict');
  return atTop[0];
};
const utcDay = (iso) => {
  assert.match(iso, /^\d{4}-\d{2}-\d{2}T[^Z]*Z$/, `catalog quote time is a UTC stamp: ${iso}`);
  return new Date(Date.parse(iso)).toISOString().slice(0, 10);
};
const hbdRaw = Object.values(RAW).filter((r) => r.cardNumber === 'hBD24-023');
const HBD_LATEST = latestListingQuote(hbdRaw);
// 2026-11-10 (PR #287 CI 42828493043): the daily catalog moves real prices (hBP03-029 SR
// ¥1,280 → ¥980) and marks rows not re-quoted this run as retained (hBD24-023 hPR,
// 2026-08-25). Real-catalog expectations are therefore derived from the RAW printing rows
// by exact id — never from the resolver / chooser under test — and compared per printing id.
const ENT07_ID = 'hBD24-023_ent07';
const HPR_ID = 'hBD24-023_hPR_P_hBD24-023_P';
const rawPrice = (id) => {
  const p = RAW[id] && RAW[id].sellPrice;
  assert.ok(Number.isFinite(p) && p > 0, `oracle: raw row ${id} has its own positive sell quote`);
  return p;
};
const rawRetained = (id) => RAW[id].sellQuoteRetained === true;
const yen = (p) => `¥${p.toLocaleString('en-US')}`;
// zh chooser source line for hBD24-023. 2026-11-10 USER OVERRIDE (Android: 「本次更新無新報價・
// 沿用 2026-08-25 的原報價（舊價）」—「如果會請拿掉 我可沒叫你這樣顯示」): product + original name
// only — no quote day, no 舊價 / 無新報價 / 報價日期不明. The card's provenance still carries the
// current quote's own time and retained flag (asserted where it matters, never rendered).
const HBD_SOURCE_LINE = 'PR 宣傳卡（hPR） · 原名：PRカード';
const CHOOSER_HINT_RE = /舊價|無新報價|報價日期不明|未確認為最新|\d{4}-\d{2}-\d{2}/;
const assertNoChooserHint = (lines, label) => {
  for (const s of lines) assert.doesNotMatch(s, CHOOSER_HINT_RE, `${label}: no quote date / age hint in "${s}"`);
};
await test('real rows hBD24-023: the ent07 aggregation row and the hPR row are proven the SAME listing alias (same yuyu listing + official image + rarity)', () => {
  const rows = real.map((r) => ({ id: r.id, cardNumber: r.cardNumber, rarity: r.rarity, sellPrice: r.sellPrice, imageUrl: r.officialImage, provenance: provenanceFromRow(r) }));
  assert.equal(samePrintingProof(rows[0], rows[1]), 'aggregate-alias-same-listing');
  // …but two non-aggregate rows with the same images are NOT (no blanket image rule)
  const twoProducts = rows.map((r, i) => ({ ...r, provenance: { ...r.provenance, sourceProduct: i ? 'hPR' : 'hBP02' } }));
  assert.equal(samePrintingProof(twoProducts[0], twoProducts[1]), null);
});

const all = await loadAllCards();
await test('local catalog keeps provenance of every row (product, quote time, listing, shop); language / condition unknown', () => {
  const ent07 = all.find((c) => c.id === 'hBD24-023_ent07');
  const hpr = all.find((c) => c.id === 'hBD24-023_hPR_P_hBD24-023_P');
  assert.ok(ent07 && hpr, 'both raw rows still load (ids valid)');
  assert.equal(ent07.provenance.sourceProduct, 'ent07');
  assert.equal(hpr.provenance.sourceProductName, 'PRカード');
  assert.equal(ent07.provenance.quotedAt, RAW['hBD24-023_ent07'].timestamp, 'the row\'s own raw quote time');
  assert.equal(hpr.provenance.quotedAt, RAW['hBD24-023_hPR_P_hBD24-023_P'].timestamp, 'the row\'s own raw quote time');
  assert.ok(Date.parse(ent07.provenance.quotedAt) >= Date.parse(real[0].timestamp), `ent07 quote ${ent07.provenance.quotedAt} not older than the investigated ${real[0].timestamp}`);
  assert.ok(Date.parse(ent07.provenance.quotedAt) > Date.parse(hpr.provenance.quotedAt), 'the ent07 quote is the newer one');
  assert.match(hpr.provenance.quotedAt, /^2026-08-25/);
  assert.equal(ent07.provenance.listing, hpr.provenance.listing);
  assert.equal(ent07.provenance.quoteSource, 'yuyu-tei');
  assert.equal(ent07.provenance.language, null);
  assert.equal(ent07.sellPrice, rawPrice(ENT07_ID), 'raw row price unchanged (loaded == its own raw row)');
  assert.equal(hpr.sellPrice, rawPrice(HPR_ID), 'raw row price unchanged (loaded == its own raw row)');
  // the writer's retained flag is carried per row, exactly as written (fresh vs retained)
  assert.equal(ent07.provenance.retained === true, rawRetained(ENT07_ID), 'ent07 retained status = its raw sellQuoteRetained');
  assert.equal(hpr.provenance.retained === true, rawRetained(HPR_ID), 'hPR retained status = its raw sellQuoteRetained');
});
let resolved;
await test('resolver: hBD24-023 is ONE proven version (hPR identity) at its latest same-listing quote, both alias ids + both quotes kept', () => {
  resolved = resolvePrintingByCardNumber(all, 'hBD24-023');
  assert.equal(resolved.status, 'unique');
  const card = resolved.card;
  assert.equal(card.id, 'hBD24-023_hPR_P_hBD24-023_P', 'the real product row is the identity');
  assert.equal(card.sellPrice, rawPrice(ENT07_ID), 'current = the ent07 row\'s own raw quote (the latest), not the higher/lower one');
  assert.deepEqual([...card.aliasIds].sort(), ['hBD24-023_ent07', 'hBD24-023_hPR_P_hBD24-023_P']);
  assert.deepEqual(card.priceQuotes.map((q) => q.price).sort((a, b) => a - b), [rawPrice(ENT07_ID), rawPrice(HPR_ID)].sort((a, b) => a - b));
  // per row, not merely a bag: each quote is its own row's raw price (a swap would fail)
  assert.deepEqual(Object.fromEntries(card.priceQuotes.filter((q) => q.type === 'sell').map((q) => [q.rowId, q.price])), { [ENT07_ID]: rawPrice(ENT07_ID), [HPR_ID]: rawPrice(HPR_ID) });
  assert.equal(HBD_LATEST.id, 'hBD24-023_ent07', 'oracle: the ent07 row holds the latest same-listing quote');
  assert.equal(card.sellPrice, HBD_LATEST.sellPrice);
  assert.equal(card.provenance.quotedAt, HBD_LATEST.timestamp, 'quote time of the latest same-listing quote');
  assert.equal(card.provenance.retained === true, rawRetained(HBD_LATEST.id), 'retained status travels with the CURRENT quote row only');
  assert.equal(card.provenance.listing, LISTING);
  assert.equal(card.provenance.sourceProductName, 'PRカード');
});
await test('other real multi-printing numbers are NOT collapsed by number (hBP01-024 keeps its printings)', () => {
  const rows = all.filter((c) => c.cardNumber === 'hBP01-024');
  const res = resolvePrintingByCardNumber(all, 'hBP01-024');
  assert.ok(rows.length > 2);
  assert.equal(res.status, 'ambiguous');
  assert.ok(res.printings.length >= rows.length - rows.filter((r) => r.provenance?.sourceProduct === 'ent07').length);
});

// 2026-10-19 user report (hBP03-029 さくらみこ): four real printings (R/SR × hBP03/hEB01)
// plus two ent07 aggregation rows with no listing and no price whose official image and
// rarity equal the hBP03 R / SR rows. The unlisted aliases fold into those printings
// (ids kept, no quote added); the four printings stay four.
let miko;
await test('resolver: hBP03-029 = 4 printings; unpriced unlisted ent07 rows fold into hBP03 R/SR, prices untouched', () => {
  const rows = all.filter((c) => c.cardNumber === 'hBP03-029');
  assert.equal(rows.length, 6);
  miko = resolvePrintingByCardNumber(all, 'hBP03-029');
  assert.equal(miko.status, 'ambiguous');
  const byId = Object.fromEntries(miko.printings.map((c) => [c.id, c]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'hBP03-029_hBP03_R_hBP03-029_R', 'hBP03-029_hBP03_SR_hBP03-029_SR',
    'hBP03-029_hEB01_R_hBP03-029_R_02', 'hBP03-029_hEB01_SR_hBP03-029_SR_02',
  ]);
  assert.deepEqual([...byId['hBP03-029_hBP03_R_hBP03-029_R'].aliasIds].sort(), ['hBP03-029_ent07_R_hBP03-029_R', 'hBP03-029_hBP03_R_hBP03-029_R']);
  assert.deepEqual([...byId['hBP03-029_hBP03_SR_hBP03-029_SR'].aliasIds].sort(), ['hBP03-029_ent07', 'hBP03-029_hBP03_SR_hBP03-029_SR']);
  // Per printing id: each printing ships its OWN raw row's price (reported 2026-10-19 as
  // 180 / 1,280 / 50 / 120; the market moves, e.g. SR ¥980 on 2026-11-10). The folded ent07
  // aliases are unpriced in the raw catalog, so folding adds no quote.
  for (const alias of ['hBP03-029_ent07', 'hBP03-029_ent07_R_hBP03-029_R']) {
    assert.ok(!(RAW[alias].sellPrice > 0), `oracle: alias ${alias} is unpriced`);
  }
  assert.deepEqual(Object.fromEntries(miko.printings.map((c) => [c.id, c.sellPrice])),
    Object.fromEntries(Object.keys(byId).map((id) => [id, rawPrice(id)])), 'prices untouched, per printing');
  assert.equal(byId['hBP03-029_hBP03_SR_hBP03-029_SR'].provenance.sourceProduct, 'hBP03', 'the real product row is the identity');
  assert.equal(byId['hBP03-029_hEB01_SR_hBP03-029_SR_02'].aliasIds, undefined, 'the hEB01 reprint is never joined');
});
await test('unlisted alias that matches two printings joins neither (no guess)', () => {
  const base = { cardNumber: 'X-1', rarity: 'SR', imageUrl: 'same.png' };
  const v = buildPrintingVersions([
    { ...base, id: 'a', sellPrice: 100, provenance: provenanceFromRow({ sourceProduct: 'hBP01', yuyuImage: 'https://card.yuyu-tei.jp/a.jpg' }) },
    { ...base, id: 'b', sellPrice: 900, provenance: provenanceFromRow({ sourceProduct: 'hBP02', yuyuImage: 'https://card.yuyu-tei.jp/b.jpg' }) },
    { ...base, id: 'alias', provenance: provenanceFromRow({ sourceProduct: 'ent07' }) },
  ]);
  assert.equal(v.length, 3);
  const priced = { ...base, id: 'p', sellPrice: 500, provenance: provenanceFromRow({ sourceProduct: 'ent07' }) };
  assert.equal(samePrintingProof(priced, { ...base, id: 'a', sellPrice: 100, provenance: provenanceFromRow({ sourceProduct: 'hBP01', yuyuImage: 'https://card.yuyu-tei.jp/a.jpg' }) }), null, 'a PRICED alias still needs the same listing');
});

const metaOf = (html, id) => [...html.matchAll(new RegExp(`data-testid="${id}"[^>]*>(.*?)</div>`, 'gs'))].map((m) => m[1].replace(/<[^>]*>/g, '').replace(/<!--.*?-->/gs, ''));
// The chooser no longer takes a clock (no age label); `now` here is only passed to prove the
// rendered line is identical at any time after the quote (fresh, 30 days, unknown).
const HOUR = 60 * 60 * 1000;
const render = (cards, now) => renderToStaticMarkup(React.createElement(Selector, {
  visible: true, tier: 'mid', candidates: cards.map((card) => ({ card, confidence: 0.5 })),
  onSelect() {}, onRescan() {}, onManualSearch() {}, onDismiss() {}, preferredCurrency: 'JPY', preferredLanguage: 'zh',
  ...(now === undefined ? {} : { now }),
}));
const priceRe = (p) => new RegExp(`#hBD24-023 · P · 一般版\\s+${yen(p).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\d)`);
await test('actual chooser: the proven version is ONE row "#hBD24-023 · P · 一般版 ¥<latest raw quote>" with "PR 宣傳卡（hPR） · 原名：PRカード" (zh primary; no quote-date / age hint)', () => {
  const html = render([resolved.card], Date.parse(resolved.card.provenance.quotedAt) + HOUR);
  const meta = metaOf(html, 'scan-candidate-meta');
  const source = metaOf(html, 'scan-candidate-source');
  assert.equal(meta.length, 1);
  assert.match(meta[0], priceRe(HBD_LATEST.sellPrice));
  assert.deepEqual(source, [HBD_SOURCE_LINE]);
  assertNoChooserHint([...meta, ...source], 'fresh');
  // internal provenance still carries the current quote's own time + the writer's retained flag
  assert.equal(resolved.card.provenance.quotedAt, HBD_LATEST.timestamp);
  assert.equal(resolved.card.provenance.retained === true, rawRetained(HBD_LATEST.id));
});
await test('actual chooser, last-known price: the same quote 30 days later renders the SAME line and price (no 舊價 / 無新報價 / date)', () => {
  const quotedAt = resolved.card.provenance.quotedAt;
  const html = render([resolved.card], Date.parse(quotedAt) + 30 * 24 * HOUR);
  const meta = metaOf(html, 'scan-candidate-meta');
  const source = metaOf(html, 'scan-candidate-source');
  assert.match(meta[0], priceRe(HBD_LATEST.sellPrice), 'same exact printing, same retained value');
  assert.deepEqual(source, [HBD_SOURCE_LINE]);
  assertNoChooserHint([...meta, ...source], '30 days');
});
await test('actual chooser, unknown / future quote time: same product line, no 報價日期不明 and no date', () => {
  const card = { ...resolved.card, provenance: { ...resolved.card.provenance, quotedAt: null } };
  const source = metaOf(render([card], Date.parse(HBD_LATEST.timestamp)), 'scan-candidate-source');
  assert.deepEqual(source, [HBD_SOURCE_LINE]);
  const future = { ...resolved.card, provenance: { ...resolved.card.provenance, quotedAt: '2099-01-01T00:00:00.000Z' } };
  const fsource = metaOf(render([future], Date.parse(HBD_LATEST.timestamp)), 'scan-candidate-source');
  assert.deepEqual(fsource, [HBD_SOURCE_LINE]);
  assertNoChooserHint([...source, ...fsource], 'unknown / future');
});
await test('actual chooser across re-quotes: the 2026-10-22 CI quote and month / year rollovers show that quote\'s own day; an older ent07 quote never takes over from hPR', () => {
  // SYNTHETIC re-quote fixture (in memory; the catalog file is not touched). Deterministic: the
  // ent07 quote time is set by hand and the writer's retained flag is RESET on both alias rows,
  // so the case measures only "which quote is current / which day is shown" — not today's
  // catalog run state (the real hPR row is currently retained; that is asserted separately
  // below and in the real-catalog checks above). Prices are each row's own raw quote.
  const HPR_AT = RAW[HPR_ID].timestamp;
  assert.ok(Date.parse(HPR_AT) > Date.parse('2026-08-01T00:00:00.000Z') && Date.parse(HPR_AT) < Date.parse('2026-10-22T12:10:01.865Z'),
    `oracle: the hPR quote (${HPR_AT}) lies between the synthetic older and newer ent07 times`);
  const variant = (at, retained = {}) => all.map((c) => {
    if (c.id !== ENT07_ID && c.id !== HPR_ID) return c;
    const { retained: _real, ...prov } = c.provenance;
    return { ...c, provenance: { ...prov, ...(c.id === ENT07_ID ? { quotedAt: at } : {}), ...(retained[c.id] ? { retained: true } : {}) } };
  });
  // [ent07 quote time, chooser day, current row] — written out by hand, then cross-checked
  // against the raw-row oracle on the same in-memory variant.
  for (const [at, day, currentId] of [
    ['2026-10-22T12:10:01.865Z', '2026-10-22', ENT07_ID],
    ['2026-10-31T23:59:59.999Z', '2026-10-31', ENT07_ID],
    ['2026-11-01T00:00:00.000Z', '2026-11-01', ENT07_ID],
    ['2027-01-01T00:00:00.000Z', '2027-01-01', ENT07_ID],
    ['2026-08-01T00:00:00.000Z', utcDay(HPR_AT), HPR_ID],
  ]) {
    const price = rawPrice(currentId);
    const want = latestListingQuote(hbdRaw.map((r) => (r.id === ENT07_ID ? { ...r, timestamp: at } : r)));
    assert.deepEqual([want.id, utcDay(want.timestamp), want.sellPrice], [currentId, day, price], `oracle @ ${at}`);
    const res = resolvePrintingByCardNumber(variant(at), 'hBD24-023');
    assert.equal(res.status, 'unique', at);
    assert.equal(res.card.sellPrice, price, at);
    assert.equal(res.card.provenance.quotedAt, want.timestamp, at);
    assert.equal(res.card.provenance.retained, undefined, `${at}: fixture retained state reset`);
    assert.deepEqual([...res.card.aliasIds].sort(), ['hBD24-023_ent07', 'hBD24-023_hPR_P_hBD24-023_P'], at);
    const html = render([res.card], Date.parse(want.timestamp) + HOUR);
    assert.match(metaOf(html, 'scan-candidate-meta')[0], priceRe(price), at);
    // the current quote's own day is provenance (asserted above via quotedAt), never rendered
    assert.deepEqual(metaOf(html, 'scan-candidate-source'), [HBD_SOURCE_LINE], at);
    assert.ok(!html.includes(day), `${at}: quote day ${day} not rendered`);
  }
  // Explicit retained cases: the retained flag travels INTERNALLY with the current row only (the
  // non-current row's flag never leaks); the rendered line is the same either way (no hint).
  for (const [at, retainedRow, isCurrent] of [
    ['2026-08-01T00:00:00.000Z', HPR_ID, true],      // hPR current + retained (today's real state)
    ['2026-08-01T00:00:00.000Z', ENT07_ID, false],   // ent07 retained but older
    ['2026-10-22T12:10:01.865Z', ENT07_ID, true],    // ent07 current + retained
    ['2026-10-22T12:10:01.865Z', HPR_ID, false],     // hPR retained but older
  ]) {
    const res = resolvePrintingByCardNumber(variant(at, { [retainedRow]: true }), 'hBD24-023');
    const t = Date.parse(res.card.provenance.quotedAt);
    assert.equal(res.card.provenance.retained === true, isCurrent, `${at} / ${retainedRow}: retained travels only with the current row`);
    for (const now of [t + HOUR, t + 30 * 24 * HOUR]) {
      const lines = metaOf(render([res.card], now), 'scan-candidate-source');
      assert.deepEqual(lines, [HBD_SOURCE_LINE], `${at} / ${retainedRow} @ +${Math.round((now - t) / HOUR)}h`);
      assertNoChooserHint(lines, `${at} / ${retainedRow}`);
    }
  }
  assert.equal(all.find((c) => c.id === ENT07_ID).provenance.quotedAt, RAW[ENT07_ID].timestamp, 'variants never leak into the loaded catalog');
  assert.equal(all.find((c) => c.id === HPR_ID).provenance.retained === true, rawRetained(HPR_ID), 'retained reset never leaks into the loaded catalog');
});
await test('actual chooser: hBP03-029 rows carry zh version, zh primary series (原名 kept), own picture', () => {
  const html = render(miko.printings);
  const metaRows = metaOf(html, 'scan-candidate-meta');
  // Each candidate row (in render order = miko.printings order) names ITS OWN printing and
  // shows ITS OWN raw row's price — per printing id, so swapped prices or versions fail.
  const VERSION_LABEL = {
    'hBP03-029_hBP03_R_hBP03-029_R': '· R · 一般版',
    'hBP03-029_hBP03_SR_hBP03-029_SR': '· SR · 平行版',
    'hBP03-029_hEB01_R_hBP03-029_R_02': '· R · 一般版・hEB01 收錄',
    'hBP03-029_hEB01_SR_hBP03-029_SR_02': '· SR · 平行版・hEB01 收錄',
  };
  assert.equal(metaRows.length, miko.printings.length);
  miko.printings.forEach((c, i) => {
    const label = VERSION_LABEL[c.id];
    assert.ok(label, `known printing ${c.id}`);
    const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    assert.match(metaRows[i].trim(), new RegExp(`^#hBP03-029 ${esc(label)}\\s+${esc(yen(rawPrice(c.id)))}$`), `${c.id}: own version + own raw price`);
  });
  // (the R rows and the SR rows are told apart by version, not by price alone)
  assert.equal(new Set(metaRows.map((m) => m.trim().replace(/\s+¥[\d,]+$/, ''))).size, 4, 'four distinct version labels');
  const sourceLines = metaOf(html, 'scan-candidate-source');
  const source = sourceLines.join('|');
  assert.match(source, /補充包 第 3 彈（hBP03） · [^|]*原名：ブースターパック「エリートスパーク」/);
  assert.match(source, /額外補充包 第 1 彈（hEB01） · [^|]*原名：エクストラブースター サマー・ホログラム/);
  assertNoChooserHint([...metaRows, ...sourceLines], 'hBP03-029');
  assert.equal((html.match(/data-testid="scan-candidate-image"/g) || []).length, 4);
  // RN-web's static markup omits the <img> src; the source is the row's own listing picture.
  const pics = miko.printings.map((c) => buildPrintingDisplayRows(c.prices, 'zh')[0].imageUrl).sort();
  assert.deepEqual(pics.map((u) => u.replace(/^.*100_140\//, '')), ['hbp03/10062.jpg', 'hbp03/10063.jpg', 'heb01/10135.jpg', 'heb01/10136.jpg']);
});
await test('actual chooser: unproven lookalikes are told apart by their source product (+ own price), marked 版本未確認; no quote date (user override)', () => {
  const rows = caseRows('same_images_but_alias_unproven_no_blind_merge').map((r) => ({
    id: r.id, name: 'x', cardNumber: r.cardNumber, type: '', rarity: r.rarity, series: '', sellPrice: r.sellPrice,
    yuyuName: '', color: '', imageUrl: r.artIdentity, provenance: r.provenance,
  }));
  const cards = consolidatePrintingCards(rows);
  const html = render(cards);
  const source = metaOf(html, 'scan-candidate-source');
  const meta = metaOf(html, 'scan-candidate-meta');
  assert.equal(source.length, 2);
  assert.notEqual(source[0], source[1], 'the two source products stay distinguishable');
  assert.ok(source.every((s) => s.includes('版本未確認')), source.join(' | '));
  // each lookalike keeps ITS OWN price (8,980 / 9,980), never one borrowed for both
  assert.deepEqual(meta.map((m) => (m.match(/¥([\d,]+)/) || [])[1]).sort(), ['8,980', '9,980']);
  assertNoChooserHint(source, 'lookalikes');
  // the quote dates stay internal provenance on each card (fixture: 2026-10-17 / 2026-08-25)
  assert.deepEqual(cards.map((c) => c.provenance.quotedAt).sort(), rows.map((r) => r.provenance.quotedAt).sort());
});
await test('actual chooser: a same-time quote conflict shows 報價不一致 and no price', () => {
  const rows = caseRows('same_timestamp_conflicting_quote_no_arbitrary_max_or_min').map((r) => ({
    id: r.id, name: 'x', cardNumber: r.cardNumber, type: '', rarity: r.rarity, series: '', sellPrice: r.sellPrice,
    yuyuName: '', color: '', imageUrl: r.artIdentity, physicalPrinting: r.physicalPrinting, provenance: r.provenance,
  }));
  const html = render(consolidatePrintingCards(rows));
  assert.ok(metaOf(html, 'scan-candidate-source')[0].includes('報價不一致'));
  assert.ok(!/[¥]\d/.test(metaOf(html, 'scan-candidate-meta')[0]), 'no current price claimed');
});

// ── API: real handler fmt → mapper → candidate consolidation ──
const handler = (await import('../api/recognize-card.ts')).default;
process.env.GEMINI_API_KEY = 'test-key-never-sent';
const PIXEL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAA+gAAAV4CAIAAAAAAAAA';
await test('API fmt → apiCardMapper keep provenance of every hBD24-023 row it returns; client consolidation makes them one candidate', async () => {
  const res = await handler(new Request('https://holohunter.dicoge.com/api/recognize-card', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image: PIXEL }),
  }));
  const body = await res.json();
  const raw = [body.card, ...(body.candidates ?? []), ...(body.printings ?? [])].filter((c) => c && c.cardNumber === 'hBD24-023');
  assert.ok(raw.length > 0, `API returned hBD24-023 (keys: ${Object.keys(body).join(',')})`);
  for (const c of raw) {
    assert.ok(c.provenance && c.provenance.quotedAt && c.provenance.listing, `fmt provenance on ${c.id}`);
    assert.equal(mapApiCardToCardInfo(c).provenance.quotedAt, c.provenance.quotedAt, 'mapper passes it through');
  }
  const ids = new Set(raw.map((c) => c.id));
  const mapped = consolidatePrintingCards([...ids].map((id) => mapApiCardToCardInfo(raw.find((c) => c.id === id))));
  if (ids.size > 1) {
    assert.equal(mapped.length, 1, 'proven alias rows → one candidate');
    assert.equal(mapped[0].sellPrice, HBD_LATEST.sellPrice, 'the latest same-listing raw quote');
  }
  const missing = mapApiCardToCardInfo({ id: 'x', cardNumber: 'hBP01-001' });
  assert.equal(missing.provenance, null, 'a legacy payload without provenance stays unknown');
});

await test('data files untouched: database.json bytes identical before / after', () => {
  assert.ok(DB_BYTES.equals(fs.readFileSync(new URL('../public/data/database.json', import.meta.url))));
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ printing-quote-identity: ${passed} checks passed (fetches answered in memory: ${fetches})`);
else console.error('\n❌ printing-quote-identity failed');
