#!/usr/bin/env node
// 2026-10-19 user report — hBP03-029 さくらみこ: the version list showed four Japanese
// shop names ("[SR] さくらみこ(パラレル)", "[SR] さくらみこ(パラレル/hEB01)", two R) with no
// picture, so a zh player could not tell the four real printings apart, and the set line
// was Japanese only.
//
// Pinned on the SHIPPED catalog rows (public/data/database.json), merged exactly the way
// search hands a card number to CardDetail (dedupeListings → toCanonicalCardRecord):
//   • the four printings stay four rows (SR/R × hBP03/hEB01 — never merged by number);
//   • each row has a zh label, the shop's original name and ITS OWN listing image;
//   • the two unpriced ent07 alias rows add no phantom version;
//   • repeated listings of one printing collapse to one row; disagreeing prices stay
//     visible as a conflict instead of picking one;
//   • the zh hero set line LEADS with a Chinese description of the set code
//     (補充包 第 3 彈（hBP03）); the Japanese title is shown only as 原名, not as a translation.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
const { buildPrintingDisplayRows, printingDisplayLabel, seriesLabel } = await import('../src/utils/printingDisplay.ts');
const { dedupeListings, toCanonicalCardRecord } = await import('../src/utils/canonicalCardRecord.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

const db = JSON.parse(readFileSync(new URL('../public/data/database.json', import.meta.url), 'utf8'));
const allRows = Array.isArray(db.cards) ? db.cards : Object.values(db.cards);
const rows = allRows.filter((r) => r.cardNumber === 'hBP03-029');
const listings = dedupeListings(rows.flatMap((r) => r.prices ?? []));

await test('catalog: hBP03-029 has 6 rows — 4 priced printings + 2 unpriced ent07 alias rows', async () => {
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.sourceProduct === 'ent07' && (r.prices ?? []).length === 0).length, 2);
  assert.equal(listings.length, 4);
});

await test('four printings stay four zh rows, each with its own listing image (SR/R never merged)', async () => {
  const out = buildPrintingDisplayRows(listings, 'zh');
  const byLabel = Object.fromEntries(out.map((r) => [r.sourceLabel, r]));
  assert.equal(out.length, 4);
  assert.deepEqual(
    out.map((r) => [r.rarity, r.label, r.sellPrice]).sort((a, b) => a[2] - b[2]),
    [['R', '一般版・hEB01 收錄', 50], ['SR', '平行版・hEB01 收錄', 120], ['R', '一般版', 180], ['SR', '平行版', 1280]],
  );
  assert.match(byLabel['さくらみこ'].imageUrl, /hbp03\/10062\.jpg$/);
  assert.match(byLabel['さくらみこ(パラレル)'].imageUrl, /hbp03\/10063\.jpg$/);
  assert.match(byLabel['さくらみこ(hEB01)'].imageUrl, /heb01\/10135\.jpg$/);
  assert.match(byLabel['さくらみこ(パラレル/hEB01)'].imageUrl, /heb01\/10136\.jpg$/);
  assert.equal(new Set(out.map((r) => r.imageUrl)).size, 4, 'no printing borrows a sibling picture');
});

await test('ja keeps the source descriptors', async () => {
  assert.equal(printingDisplayLabel('さくらみこ(パラレル/hEB01)', 'ja'), 'パラレル/hEB01');
  assert.equal(printingDisplayLabel('さくらみこ', 'ja'), '通常');
  assert.equal(printingDisplayLabel('ラプラス・ダークネス(パラレル/サイン)', 'zh'), '平行版・簽名版');
  assert.equal(printingDisplayLabel('宝鐘マリン(パラレル)(エラッタ後)', 'zh'), '平行版');
});

await test('repeated listings of ONE printing collapse; disagreeing prices are a visible conflict', async () => {
  const same = buildPrintingDisplayRows([
    { name: 'X(パラレル)', sellPrice: 500, rarity: 'SR', imageUrl: 'a.jpg' },
    { name: 'X(パラレル)', sellPrice: 500, rarity: 'SR', imageUrl: 'a.jpg' },
  ]);
  assert.equal(same.length, 1);
  assert.equal(same[0].sellPrice, 500);
  const conflict = buildPrintingDisplayRows([
    { name: 'X(パラレル)', sellPrice: 500, imageUrl: 'a.jpg' },
    { name: 'X(パラレル)', sellPrice: 3480, imageUrl: 'b.jpg' },
  ]);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].ambiguous, true);
  assert.equal(conflict[0].sellPrice, null, 'no price is picked');
  assert.equal(conflict[0].imageUrl, null, 'disagreeing art shows no picture');
});

await test('zh series label: Chinese description of the code leads, Japanese title only as 原名', async () => {
  assert.deepEqual(seriesLabel('hBP03', 'ブースターパック「エリートスパーク」', 'zh'), { primary: '補充包 第 3 彈（hBP03）', original: 'ブースターパック「エリートスパーク」' });
  assert.deepEqual(seriesLabel('hBP03', 'エリートスパーク', 'zh'), { primary: '補充包 第 3 彈（hBP03）', original: 'エリートスパーク' });
  assert.deepEqual(seriesLabel('hEB01', 'エクストラブースター サマー・ホログラム', 'zh'), { primary: '額外補充包 第 1 彈（hEB01）', original: 'エクストラブースター サマー・ホログラム' });
  assert.deepEqual(seriesLabel('hSD16', 'ライブスタートデッキ さくらみこ', 'zh'), { primary: 'Live 起始牌組（hSD16）', original: 'ライブスタートデッキ さくらみこ' });
  assert.deepEqual(seriesLabel('hPR', 'PRカード', 'zh'), { primary: 'PR 宣傳卡（hPR）', original: 'PRカード' });
  assert.deepEqual(seriesLabel('hY', 'Yokohama Promo', 'zh'), { primary: 'hY 系列', original: 'Yokohama Promo' }, 'unknown family: no invented translation');
  assert.deepEqual(seriesLabel('hBP03', 'ブースターパック「エリートスパーク」', 'ja'), { primary: 'ブースターパック「エリートスパーク」', original: null });
  for (const l of [seriesLabel('hBP03', 'エリートスパーク'), seriesLabel('hEB01', 'エクストラブースター サマー・ホログラム')]) {
    assert.doesNotMatch(l.primary, /[\u3040-\u30ff]/, 'zh primary has no kana');
  }
});

await test('CardDetail renders the four printings with zh labels, source names and pictures', async () => {
  const rep = rows.find((r) => r.id === 'hBP03-029_hBP03_R_hBP03-029_R');
  // nameMap = the shipped series-names.json, as search passes it (Japanese titles).
  const nameMap = JSON.parse(readFileSync(new URL('../data/series-names.json', import.meta.url), 'utf8'));
  const card = toCanonicalCardRecord({ ...rep, prices: listings }, nameMap);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {} },
  })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  try {
    const variantRows = [...container.querySelectorAll('[data-testid^="card-detail-variant-"]')]
      .filter((el) => /^card-detail-variant-(?!image-|noimage-|hint)/.test(el.getAttribute('data-testid')));
    assert.equal(variantRows.length, 4, 'four version rows');
    const text = variantRows.map((el) => el.textContent).join('|');
    for (const label of ['[R] 一般版', '[SR] 平行版', '[R] 一般版・hEB01 收錄', '[SR] 平行版・hEB01 收錄']) {
      assert.ok(text.includes(label), `zh label ${label}`);
    }
    assert.ok(text.includes('さくらみこ(パラレル/hEB01)'), 'original shop name kept beside the zh label');
    const imgs = container.querySelectorAll('[data-testid^="card-detail-variant-image-"]');
    assert.equal(imgs.length, 4, 'every printing shows its own picture');
    const hero = container.querySelector('[data-testid="card-detail-hero"]');
    const set = container.querySelector('[data-testid="card-detail-set"]');
    assert.equal(set.textContent, '補充包 第 3 彈（hBP03）', 'zh primary set line');
    assert.equal(container.querySelector('[data-testid="card-detail-set-original"]').textContent, '原名：エリートスパーク', 'source title kept, labelled as original');
    assert.match(hero.textContent, /櫻巫女/, 'card name is the zh name');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

// CI 2026-10-19 (test:favorites-canonical-payload): a reduced route payload reached
// CardDetail with a non-string where a listing name belongs, and descriptors() threw
// "normalize is not a function". A non-string states no printing → unknown (null), never a
// guessed 一般版/平行版 and never "[object Object]"; string inputs keep their labels.
await test('label helpers: null / undefined / object / array / number are UNKNOWN, not guessed or stringified', async () => {
  for (const bad of [null, undefined, { name: 'さくらみこ(パラレル)' }, ['hBP03'], 42, true]) {
    assert.equal(printingDisplayLabel(bad, 'zh'), null, `zh ${JSON.stringify(bad)}`);
    assert.equal(printingDisplayLabel(bad, 'ja'), null, `ja ${JSON.stringify(bad)}`);
    const s = seriesLabel(bad, bad, 'zh');
    assert.ok(!/object Object/.test(`${s.primary}${s.original}`), 'no stringified object');
    assert.equal(s.original, null, 'no invented original title');
  }
  assert.deepEqual(seriesLabel('hBP03', { title: 'x' }, 'zh'), { primary: '補充包 第 3 彈（hBP03）', original: null }, 'valid code still described');
  assert.equal(printingDisplayLabel('さくらみこ(パラレル)', 'zh'), '平行版', 'strings unchanged');
  assert.equal(printingDisplayLabel('さくらみこ', 'zh'), '一般版', 'strings unchanged');
});

await test('CardDetail renders the reduced favorites-shaped payload (no listings) without crashing', async () => {
  const rep = rows.find((r) => r.id === 'hBP03-029_hBP03_SR_hBP03-029_SR');
  const full = toCanonicalCardRecord({ ...rep, prices: listings }, {});
  const reduced = {
    id: full.id, cardNumber: full.cardNumber, name: full.name, nameZh: full.nameZh,
    printing: 'PARALLEL', printingLabel: 'さくらみこ(パラレル)', series: full.series, type: full.type, imageUrl: full.imageUrl,
  };
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardDetailScreen, {
    route: { params: { card: reduced } },
    navigation: { navigate() {}, goBack() {} },
  })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  try {
    assert.ok(container.textContent.includes(full.nameZh || full.name), 'the page rendered');
    assert.ok(!container.textContent.includes('[object Object]'), 'no stringified object');
    assert.ok(!container.textContent.includes('1,280'), 'no price invented without listings');
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ printing-display (hBP03-029 versions): ${passed} checks passed`);
else console.error('\n❌ printing-display failed');
