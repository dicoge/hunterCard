#!/usr/bin/env node
// DIC-1439: Official Catalog Sync must join skill text by cardNumber from the
// controlled data/effects-jp.json / data/effects-zh.json artifacts instead of
// only carrying `previous.skillsJp` / `previous.skillsZh` forward — the exact
// defect DIC-1415 fixed for nameZh, left unfixed for skills.
//
// Skills are keyed by cardNumber; database rows are keyed by PRINTING id. So a
// brand-new printing of an already-scraped cardNumber (an hBP08/hPR reprint of
// an hBP01 card) had no previous row to preserve from and shipped with no
// skills at all, even though effects-jp.json held that cardNumber's text the
// whole time. Those rows then tripped the completeness gate
// (`data/database.json official-row completeness: 770 failure(s)`).
//
// This suite pins four properties with deterministic fixtures:
//   1. Green path   — a new printing whose cardNumber has scraped effects gets
//      its skillsJp/skillsZh, including a REPRINT under a new sourceProduct
//      whose cardNumber was only ever scraped under the original product.
//   2. Fail-closed  — a cardNumber with no effects entry gets NO invented
//      skills, and a cardNumber with JP but no TC translation gets skillsJp
//      only; no fabricated or kana-leaking skillsZh is ever synthesized
//      (DIC-1185 denylist, DIC-465 kana cleanliness). The gate predicate must
//      still trip on those rows.
//   3. Preservation — a pre-existing row whose cardNumber is absent from the
//      effects files keeps the skills it already had, so a missing or partial
//      effects file can never wipe the database (the DIC-454 regression).
//   4. Prototype safety — effects maps resolve own-properties only, so a
//      cardNumber like `constructor` cannot inherit a truthy Object.prototype
//      member and sail past the fail-closed gate (DIC-1417).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { syncOfficialCatalogToDatabase } from './sync-official-catalog-to-database.mjs';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-official-sync-skills-'));
const dbPath = path.join(tmp, 'database.json');
const officialDir = path.join(tmp, 'official');
const translationPath = path.join(tmp, 'character-names-zh.json');
const effectsJpPath = path.join(tmp, 'effects-jp.json');
const effectsZhPath = path.join(tmp, 'effects-zh.json');
fs.mkdirSync(officialDir, { recursive: true });

fs.writeFileSync(translationPath, `${JSON.stringify({
  '星街すいせい': '星街菫',
  'IRyS': 'IRyS',
  'ハコス・ベールズ': '哈可斯·貝爾姿',
  'コラボパソコン': '聯動電腦',
  'かなたそ': '天音彼方',
}, null, 2)}\n`, 'utf8');

const jpIrys = {
  cardNumber: 'hBP08-001',
  name: 'IRyS',
  cardType: '推しホロメン',
  color: '白',
  oshiSkill: { name: 'ネフィリムの祝福', cost: '-2', effect: '[ターンに1回]自分のステージのホロメン1人を選ぶ。' },
};
// hBP01-072 was scraped under its ORIGINAL product; the hBP08 reprint below is
// a different printing id with no previous row — the join must still find it.
const jpBaelz = {
  cardNumber: 'hBP01-072',
  name: 'ハコス・ベールズ',
  cardType: 'ホロメン',
  color: '紫',
  arts: [{ name: 'カオスへようこそ', damage: '30' }],
};
const zhBaelz = {
  cardNumber: 'hBP01-072',
  name: '哈可斯·貝爾姿',
  cardType: '成員',
  color: '紫',
  arts: [{ name: '歡迎來到混沌', damage: '30' }],
};
// JP-only: translation has not caught up with this cardNumber yet.
const jpPasocon = {
  cardNumber: 'hBP08-090',
  name: 'コラボパソコン',
  cardType: 'サポート・アイテム',
  color: '無色',
  abilityText: '自分のホロメン1人を選ぶ。',
};

fs.writeFileSync(effectsJpPath, `${JSON.stringify({
  'hBP08-001': jpIrys,
  'hBP01-072': jpBaelz,
  'hBP08-090': jpPasocon,
}, null, 2)}\n`, 'utf8');
fs.writeFileSync(effectsZhPath, `${JSON.stringify({
  'hBP08-001': { cardNumber: 'hBP08-001', name: 'IRyS', cardType: '主推成員', color: '白' },
  'hBP01-072': zhBaelz,
}, null, 2)}\n`, 'utf8');

// Pre-existing printing whose cardNumber is deliberately ABSENT from both
// effects files, so property 3 proves preservation rather than re-application.
const existingId = 'hBP01-081_hEB01_RR_hBP01-081_RR_02';
const preservedJp = { cardNumber: 'hBP01-081', name: '星街すいせい', oshiSkill: { name: '彗星の輝き', cost: '-1', effect: '既存のJPスキル' } };
const preservedZh = { cardNumber: 'hBP01-081', name: '星街菫', oshiSkill: { name: '彗星之輝', cost: '-1', effect: '既有的中文技能' } };
fs.writeFileSync(dbPath, `${JSON.stringify({
  lastUpdated: '2026-09-13T00:00:00.000Z',
  totalCards: 1,
  cards: {
    [existingId]: {
      id: existingId,
      cardNumber: 'hBP01-081',
      name: '星街すいせい',
      type: 'ホロメン',
      color: 'blue',
      rarity: 'RR',
      series: 'hEB01',
      sourceProduct: 'hEB01',
      sourceProductName: 'エクストラブースター',
      nameZh: '星街菫',
      skillsJp: preservedJp,
      skillsZh: preservedZh,
      sellPrice: null,
      prices: [],
      officialImage: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png',
    },
  },
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, '_meta.json'), `${JSON.stringify({
  seriesStats: [
    { code: 'hEB01', expectedCount: 1, ingestedCount: 1 },
    { code: 'hBP08', expectedCount: 4, ingestedCount: 4 },
  ],
}, null, 2)}\n`, 'utf8');

fs.writeFileSync(path.join(officialDir, 'hEB01.json'), `${JSON.stringify([
  {
    cardNumber: 'hBP01-081',
    name: '星街すいせい',
    cardType: 'ホロメン',
    color: 'blue',
    rarity: 'RR',
    expansion: 'hEB01',
    sourceProduct: 'hEB01',
    sourceProductName: 'エクストラブースター',
    imageUrl: 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png',
  },
], null, 2)}\n`, 'utf8');

const hbp08 = (cardNumber, name, rarity, suffix) => ({
  cardNumber,
  name,
  cardType: 'ホロメン',
  color: 'white',
  rarity,
  expansion: 'hBP08',
  sourceProduct: 'hBP08',
  sourceProductName: 'ブースターパック「ブルーミングレディアンス」',
  imageUrl: `https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP08/${suffix}.png`,
});

fs.writeFileSync(path.join(officialDir, 'hBP08.json'), `${JSON.stringify([
  // brand-new cardNumber with both JP and TC effects
  hbp08('hBP08-001', 'IRyS', 'OSR', 'hBP08-001_OSR'),
  // REPRINT: new printing of a cardNumber scraped under the original product.
  // This is the row class that shipped skill-less before DIC-1439.
  hbp08('hBP01-072', 'ハコス・ベールズ', 'C', 'hBP01-072_C_02'),
  // JP effects exist, TC translation does not — must stay TC-fail-closed.
  hbp08('hBP08-090', 'コラボパソコン', 'C', 'hBP08-090'),
  // no effects entry at all — must stay fully fail-closed.
  hbp08('hBP08-111', 'かなたそ', 'U', 'hBP08-111'),
], null, 2)}\n`, 'utf8');

const result = syncOfficialCatalogToDatabase({
  databasePath: dbPath,
  officialDirectory: officialDir,
  translationPath,
  effectsJpPath,
  effectsZhPath,
});
assert.equal(result.upserted, 5, 'hEB01 row refreshed plus 4 hBP08 printings');
assert.equal(result.pruned, 0);

const after = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const byCard = (num, src = 'hBP08') => Object.values(after.cards).find((c) => c.cardNumber === num && c.sourceProduct === src);

// 1. Green path — new cardNumber picks up both languages by cardNumber join.
const irys = byCard('hBP08-001');
assert.ok(irys, 'hBP08-001 must be upserted');
assert.deepEqual(irys.skillsJp, jpIrys, 'new printing must receive scraped skillsJp');
assert.equal(irys.skillsZh.cardType, '主推成員', 'new printing must receive translated skillsZh');

// 1b. Green path, the regression itself — a reprint under a NEW sourceProduct
//     has no previous row, so only a cardNumber join can populate it.
const baelz = byCard('hBP01-072');
assert.ok(baelz, 'hBP01-072 hBP08 reprint must be upserted');
assert.deepEqual(baelz.skillsJp, jpBaelz, 'reprint printing must join skillsJp by cardNumber, not by printing id');
assert.deepEqual(baelz.skillsZh, zhBaelz, 'reprint printing must join skillsZh by cardNumber, not by printing id');

// 2. Fail-closed — JP available, no controlled TC translation: skillsJp only.
const pasocon = byCard('hBP08-090');
assert.ok(pasocon, 'hBP08-090 must be upserted');
assert.deepEqual(pasocon.skillsJp, jpPasocon, 'JP-only cardNumber must still receive its authoritative skillsJp');
assert.ok(!('skillsZh' in pasocon), 'untranslated cardNumber must NOT receive a fabricated skillsZh');
// The Japanese text must never be laundered into the zh field (DIC-465).
assert.notDeepEqual(pasocon.skillsZh, jpPasocon, 'skillsZh must never be back-filled with raw Japanese');

// 2b. Fail-closed — no effects at all means no skills of either language, and
//     the completeness gate predicate must still trip on the row.
const kanata = byCard('hBP08-111');
assert.ok(kanata, 'hBP08-111 must be upserted');
assert.ok(!('skillsJp' in kanata), 'cardNumber with no effects entry must NOT receive invented skillsJp');
assert.ok(!('skillsZh' in kanata), 'cardNumber with no effects entry must NOT receive invented skillsZh');
const missingSkillsJp = Object.values(after.cards).filter((c) => !c.skillsJp);
assert.ok(missingSkillsJp.some((c) => c.id === kanata.id), 'fail-closed gate must still flag the skill-less row');

// 3. Preservation — pre-existing row's cardNumber is in neither effects file;
//    a missing/partial effects file must never wipe skills already shipped.
assert.deepEqual(after.cards[existingId].skillsJp, preservedJp, 'pre-existing row must keep its skillsJp');
assert.deepEqual(after.cards[existingId].skillsZh, preservedZh, 'pre-existing row must keep its skillsZh');

// 4. Prototype-poisoning fail-closed regression (DIC-1417 class). A plain `{}`
//    effects map leaks Object.prototype: a card numbered `constructor` would
//    resolve to the inherited constructor function — truthy and non-empty — and
//    bypass the `!card.skillsJp` gate. Resolution must be own-property-only.
const poisonTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-official-sync-skills-poison-'));
const poisonDb = path.join(poisonTmp, 'database.json');
const poisonOfficial = path.join(poisonTmp, 'official');
fs.mkdirSync(poisonOfficial, { recursive: true });
const poisonNumbers = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];
fs.writeFileSync(poisonDb, `${JSON.stringify({ lastUpdated: '2026-09-13T00:00:00.000Z', totalCards: 0, cards: {} }, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(poisonOfficial, '_meta.json'), `${JSON.stringify({ seriesStats: [{ code: 'hBP08', expectedCount: poisonNumbers.length, ingestedCount: poisonNumbers.length }] }, null, 2)}\n`, 'utf8');
fs.writeFileSync(path.join(poisonOfficial, 'hBP08.json'), `${JSON.stringify(poisonNumbers.map((cardNumber, i) => ({
  cardNumber,
  name: `poison-${i}`,
  cardType: 'ホロメン',
  color: 'white',
  rarity: 'C',
  expansion: 'hBP08',
  sourceProduct: 'hBP08',
  sourceProductName: 'ブースターパック「ブルーミングレディアンス」',
  imageUrl: `https://hololive-official-cardgame.com/wp-content/images/cardlist/hBP08/poison-${i}.png`,
})), null, 2)}\n`, 'utf8');

syncOfficialCatalogToDatabase({
  databasePath: poisonDb,
  officialDirectory: poisonOfficial,
  translationPath,
  // Empty effects files: every lookup below must miss, inherited or not.
  effectsJpPath: path.join(poisonTmp, 'missing-effects-jp.json'),
  effectsZhPath: path.join(poisonTmp, 'missing-effects-zh.json'),
});
const poisoned = JSON.parse(fs.readFileSync(poisonDb, 'utf8'));
for (const card of Object.values(poisoned.cards)) {
  assert.ok(!('skillsJp' in card), `cardNumber ${card.cardNumber} must not inherit skillsJp from Object.prototype`);
  assert.ok(!('skillsZh' in card), `cardNumber ${card.cardNumber} must not inherit skillsZh from Object.prototype`);
}

fs.rmSync(tmp, { recursive: true, force: true });
fs.rmSync(poisonTmp, { recursive: true, force: true });
console.log('✓ official catalog sync joins skills by cardNumber (green path incl. reprints), stays fail-closed without fabricating JP or TC text, preserves existing skills, and resolves effects own-properties only');
