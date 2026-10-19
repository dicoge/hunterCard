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
  assert.match(ent07.provenance.quotedAt, /^2026-10-1/);
  assert.match(hpr.provenance.quotedAt, /^2026-08-25/);
  assert.equal(ent07.provenance.listing, hpr.provenance.listing);
  assert.equal(ent07.provenance.quoteSource, 'yuyu-tei');
  assert.equal(ent07.provenance.language, null);
  assert.equal(ent07.sellPrice, 8980, 'raw row price unchanged');
  assert.equal(hpr.sellPrice, 9980, 'raw row price unchanged');
});
let resolved;
await test('resolver: hBD24-023 is ONE proven version (hPR identity) at its latest same-listing quote, both alias ids + both quotes kept', () => {
  resolved = resolvePrintingByCardNumber(all, 'hBD24-023');
  assert.equal(resolved.status, 'unique');
  const card = resolved.card;
  assert.equal(card.id, 'hBD24-023_hPR_P_hBD24-023_P', 'the real product row is the identity');
  assert.equal(card.sellPrice, 8980);
  assert.deepEqual([...card.aliasIds].sort(), ['hBD24-023_ent07', 'hBD24-023_hPR_P_hBD24-023_P']);
  assert.deepEqual(card.priceQuotes.map((q) => q.price).sort(), [8980, 9980]);
  assert.match(card.provenance.quotedAt, /^2026-10-1/);
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
  assert.deepEqual(miko.printings.map((c) => c.sellPrice).sort((a, b) => a - b), [50, 120, 180, 1280]);
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
const render = (cards) => renderToStaticMarkup(React.createElement(Selector, {
  visible: true, tier: 'mid', candidates: cards.map((card) => ({ card, confidence: 0.5 })),
  onSelect() {}, onRescan() {}, onManualSearch() {}, onDismiss() {}, preferredCurrency: 'JPY', preferredLanguage: 'zh',
}));
await test('actual chooser: the proven version is ONE row "#hBD24-023 · P · 一般版 ¥8,980" with "PR 卡 · 2026-10-1x 報價" (zh product type, 2026-10-19)', () => {
  const html = render([resolved.card]);
  const meta = metaOf(html, 'scan-candidate-meta');
  const source = metaOf(html, 'scan-candidate-source');
  assert.equal(meta.length, 1);
  assert.match(meta[0], /#hBD24-023 · P · 一般版\s+¥8,980/);
  assert.equal(source.length, 1);
  assert.match(source[0], /^hPR・PR 卡 · 2026-10-1\d 報價$/);
});
await test('actual chooser: hBP03-029 rows carry zh version, zh product type, own picture', () => {
  const html = render(miko.printings);
  const meta = metaOf(html, 'scan-candidate-meta').join('|');
  for (const m of [/· R · 一般版\s+¥180/, /· SR · 平行版\s+¥1,280/, /· R · 一般版・hEB01 收錄\s+¥50/, /· SR · 平行版・hEB01 收錄\s+¥120/]) assert.match(meta, m);
  const source = metaOf(html, 'scan-candidate-source').join('|');
  assert.match(source, /補充包「エリートスパーク」/);
  assert.match(source, /額外補充包 サマー・ホログラム/);
  assert.equal((html.match(/data-testid="scan-candidate-image"/g) || []).length, 4);
  // RN-web's static markup omits the <img> src; the source is the row's own listing picture.
  const pics = miko.printings.map((c) => buildPrintingDisplayRows(c.prices, 'zh')[0].imageUrl).sort();
  assert.deepEqual(pics.map((u) => u.replace(/^.*100_140\//, '')), ['hbp03/10062.jpg', 'hbp03/10063.jpg', 'heb01/10135.jpg', 'heb01/10136.jpg']);
});
await test('actual chooser: unproven lookalikes are told apart by source + date, marked 版本未確認 (not by price alone)', () => {
  const rows = caseRows('same_images_but_alias_unproven_no_blind_merge').map((r) => ({
    id: r.id, name: 'x', cardNumber: r.cardNumber, type: '', rarity: r.rarity, series: '', sellPrice: r.sellPrice,
    yuyuName: '', color: '', imageUrl: r.artIdentity, provenance: r.provenance,
  }));
  const cards = consolidatePrintingCards(rows);
  const source = metaOf(render(cards), 'scan-candidate-source');
  assert.equal(source.length, 2);
  assert.notEqual(source[0], source[1]);
  assert.ok(source.every((s) => /\d{4}-\d{2}-\d{2} 報價/.test(s) && s.includes('版本未確認')), source.join(' | '));
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
    assert.equal(mapped[0].sellPrice, 8980);
  }
  const missing = mapApiCardToCardInfo({ id: 'x', cardNumber: 'hBP01-001' });
  assert.equal(missing.provenance, null, 'a legacy payload without provenance stays unknown');
});

await test('data files untouched: database.json bytes identical before / after', () => {
  assert.ok(DB_BYTES.equals(fs.readFileSync(new URL('../public/data/database.json', import.meta.url))));
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ printing-quote-identity: ${passed} checks passed (fetches answered in memory: ${fetches})`);
else console.error('\n❌ printing-quote-identity failed');
