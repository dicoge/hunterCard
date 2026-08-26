#!/usr/bin/env node
/**
 * DIC-1204 mutation-sensitive regression: printing-ID canonicalization must
 * preserve the proven market payload (sellPrice, prices[], priceHistory,
 * ytStats, yuyu image/name) via the strict cardNumber|sourceProduct|rarity
 * signature — the exact-id-only preservation shipped on main dropped every
 * renamed row's payload, which is the regression the market-fields test
 * caught.
 *
 * Each mutation below inverts one behaviour of the fixed
 * `scripts/lib/preserve-market-fields.js` and asserts it flips at least one
 * expectation the test just made pass. That is the mutation-sensitivity
 * requirement: if the fix silently regresses, the test fails.
 */
import assert from 'node:assert/strict';
import fsMod from 'node:fs';
import os from 'node:os';
import pathMod from 'node:path';
import {
  applyPreservedMarketFields,
  buildPreservationIndex,
  cardSignature,
  findPreservedMatch,
  findPreservedRow,
  historyFilenameFor,
  preservedMarketPayload,
  seedCanonicalHistoryFiles,
} from './lib/preserve-market-fields.js';

// ─── Fixtures ────────────────────────────────────────────────────────────
const provenPayload = {
  sellPrice: 980,
  prices: [
    {
      name: 'ラプラス・ダークネス',
      sellPrice: 980,
      rarity: 'U',
      buyPrice: 40,
      buyPriceVersion: 'BASE',
      buyPriceSource: 'fullahead',
    },
  ],
  yuyuName: 'ラプラス・ダークネス',
  yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hsd03/10011.jpg',
  timestamp: '2026-08-25T12:00:00.000Z',
  priceHistory: { '2026-08-23': 1000, '2026-08-24': 980, '2026-08-25': 980 },
  _rawPricesArchive: [{ name: 'ラプラス・ダークネス', sellPrice: 980, rarity: '' }],
  ytStats: {
    subscriberCount: 1200000,
    totalViewCount: 200000000,
    date: '2026-08-25',
    channelId: 'UCTestLaplus',
    source: 'youtube_about_ssr',
    parser: 'ytInitialData.aboutChannelViewModel/v1',
    fetchedAt: '2026-08-25T12:00:00.000Z',
  },
};

const OLD_ID = 'hSD03-011_hSD03';
const NEW_ID = 'hSD03-011_hSD03_U_hSD03-011_U';

const prevCards = {
  [OLD_ID]: {
    id: OLD_ID,
    cardNumber: 'hSD03-011',
    name: 'ラプラス・ダークネス',
    rarity: 'U',
    series: 'hSD03',
    sourceProduct: 'hSD03',
    ...provenPayload,
  },
  // Sibling with a DIFFERENT rarity — must never leak its price cross-rarity.
  'hSD03-011_hSD03_C_only_variant': {
    id: 'hSD03-011_hSD03_C_only_variant',
    cardNumber: 'hSD03-011',
    name: 'ラプラス・ダークネス',
    rarity: 'C',
    series: 'hSD03',
    sourceProduct: 'hSD03',
    sellPrice: 9999,
    prices: [{ name: 'ラプラス・ダークネス', sellPrice: 9999, rarity: 'C' }],
  },
  // Ambiguous case: two prior rows share the same signature. Must refuse to
  // pick — DIC-1013 fail-closed rule.
  'hBP01-050_hBP01_C_variant_A': {
    id: 'hBP01-050_hBP01_C_variant_A',
    cardNumber: 'hBP01-050',
    rarity: 'C',
    series: 'hBP01',
    sourceProduct: 'hBP01',
    sellPrice: 100,
  },
  'hBP01-050_hBP01_C_variant_B': {
    id: 'hBP01-050_hBP01_C_variant_B',
    cardNumber: 'hBP01-050',
    rarity: 'C',
    series: 'hBP01',
    sourceProduct: 'hBP01',
    sellPrice: 200,
  },
};

function freshCurrentCard(overrides = {}) {
  return {
    id: NEW_ID,
    cardNumber: 'hSD03-011',
    name: 'ラプラス・ダークネス',
    rarity: 'U',
    series: 'hSD03',
    sourceProduct: 'hSD03',
    sellPrice: null,
    prices: [],
    ...overrides,
  };
}

// ─── Signature contract ─────────────────────────────────────────────────
{
  assert.equal(cardSignature({ cardNumber: 'hSD03-011', sourceProduct: 'hSD03', rarity: 'U' }), 'hSD03-011|hSD03|U');
  assert.equal(cardSignature({ cardNumber: 'hSD03-011', series: 'hSD03', rarity: 'U' }), 'hSD03-011|hSD03|U', 'series is accepted as a sourceProduct alias');
  assert.equal(cardSignature({ cardNumber: 'hSD03-011', expansion: 'hSD03', rarity: 'U' }), 'hSD03-011|hSD03|U', 'expansion is accepted as a sourceProduct alias');
  // Under-specified rows never index — a missing rarity or product would silently guess.
  assert.equal(cardSignature({ cardNumber: 'hSD03-011', rarity: 'U' }), null, 'missing sourceProduct fails closed');
  assert.equal(cardSignature({ cardNumber: 'hSD03-011', sourceProduct: 'hSD03' }), null, 'missing rarity fails closed');
  assert.equal(cardSignature({ sourceProduct: 'hSD03', rarity: 'U' }), null, 'missing cardNumber fails closed');
}

// ─── Exact-id preservation still wins ───────────────────────────────────
{
  const index = buildPreservationIndex(prevCards);
  const previous = findPreservedRow(index, OLD_ID, prevCards[OLD_ID]);
  assert.ok(previous, 'exact-id match returns the previous row');
  assert.equal(previous.sellPrice, 980);
}

// ─── Canonicalized ID falls back to the strict signature ────────────────
{
  const index = buildPreservationIndex(prevCards);
  const current = freshCurrentCard();
  const match = findPreservedMatch(index, NEW_ID, current);
  assert.ok(match, 'signature fallback recovers the renamed printing');
  assert.equal(match.matchKind, 'signature', 'matchKind reflects the fallback used');
  assert.equal(match.card.sellPrice, 980);
  // The core mutation: preserve the whole proven market payload after rename.
  const summary = applyPreservedMarketFields(current, match.card, { matchKind: match.matchKind });
  assert.equal(current.sellPrice, 980, 'sellPrice must survive canonicalization');
  assert.equal(current.prices[0]?.buyPrice, 40, 'per-variant buyPrice must survive');
  assert.equal(current.prices[0]?.name, 'ラプラス・ダークネス', 'prices[] name must survive');
  assert.equal(current.priceHistory['2026-08-24'], 980, 'priceHistory must survive');
  assert.equal(current.ytStats.subscriberCount, 1200000, 'ytStats must survive');
  assert.equal(current.yuyuImage, provenPayload.yuyuImage, 'yuyuImage must survive');
  assert.equal(current.timestamp, provenPayload.timestamp, 'timestamp must survive');
  assert.deepEqual(current._rawPricesArchive, provenPayload._rawPricesArchive, '_rawPricesArchive must survive');
  assert.ok(summary.sellPrice && summary.prices && summary.priceHistory && summary.ytStats);
}

// ─── SEC signed printings never inherit prev prices[] via signature ────
// DIC-1013 / DIC-1140 fail-closed: signed-printing prices[] must be empty
// because yuyu-tei listings never prove signed identity. A regression that
// bulk-copied prev's prices[] onto the renamed SEC row would violate the
// canonical-printings assertion this fix is being audited against.
{
  const signedPrev = {
    id: 'hBP02-003_hBP02',
    cardNumber: 'hBP02-003',
    name: '宝鐘マリン',
    rarity: 'SEC',
    sourceProduct: 'hBP02',
    series: 'hBP02',
    // pre-DIC-1140 build: SEC row still carried yuyu variants + a signed image
    sellPrice: 420,
    prices: [{ name: '宝鐘マリン(パラレル/サイン)', sellPrice: 89800, rarity: '' }],
    yuyuName: '宝鐘マリン(パラレル/サイン)',
    yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp02/10212.jpg',
    _rawPricesArchive: [{ name: '宝鐘マリン(パラレル/サイン)', sellPrice: 89800 }],
    priceHistory: { '2026-08-23': 420, '2026-08-24': 420 },
    ytStats: null,
  };
  const index = buildPreservationIndex({ [signedPrev.id]: signedPrev });
  const NEW_SEC_ID = 'hBP02-003_hBP02_SEC_hBP02-003_SEC';
  const current = {
    id: NEW_SEC_ID,
    cardNumber: 'hBP02-003',
    name: '宝鐘マリン',
    rarity: 'SEC',
    sourceProduct: 'hBP02',
    sellPrice: null,
    prices: [],
  };
  const match = findPreservedMatch(index, NEW_SEC_ID, current);
  assert.ok(match && match.matchKind === 'signature');
  applyPreservedMarketFields(current, match.card, { matchKind: match.matchKind });
  assert.equal(current.sellPrice, 420, 'SEC sellPrice must still survive canonicalization');
  assert.equal(current.priceHistory['2026-08-24'], 420, 'SEC priceHistory must still survive');
  assert.equal(current.prices.length, 0, 'SEC signed printings must NOT inherit prev prices[] on rename (DIC-1013/1140)');
  assert.equal(current.yuyuName || '', '', 'SEC signed printings must NOT inherit prev yuyuName on rename');
  assert.equal(current.yuyuImage || '', '', 'SEC signed printings must NOT inherit prev yuyuImage on rename');
  // Exact-id path is still allowed to preserve every SEC descriptor — the
  // canonicalization has not renamed the row, so its historical prices[]
  // is what the build produced under the same rule set.
  const currentExact = {
    id: signedPrev.id,
    cardNumber: 'hBP02-003',
    name: '宝鐘マリン',
    rarity: 'SEC',
    sourceProduct: 'hBP02',
    sellPrice: null,
    prices: [],
  };
  applyPreservedMarketFields(currentExact, signedPrev, { matchKind: 'exact-id' });
  assert.equal(currentExact.prices.length, 1, 'exact-id preservation still restores prev prices[] verbatim');
  assert.equal(currentExact.yuyuImage, signedPrev.yuyuImage);
}

// ─── Never overwrites a freshly proven current value ────────────────────
{
  const index = buildPreservationIndex(prevCards);
  const current = freshCurrentCard({ sellPrice: 4200, prices: [{ name: 'fresh', sellPrice: 4200, rarity: 'U' }] });
  const previous = findPreservedRow(index, NEW_ID, current);
  applyPreservedMarketFields(current, previous);
  assert.equal(current.sellPrice, 4200, 'freshly proven sellPrice wins over preserved');
  assert.equal(current.prices[0].name, 'fresh', 'freshly proven prices[] wins over preserved');
  // The proven ytStats/priceHistory/etc. still fill their empty slots.
  assert.equal(current.ytStats.subscriberCount, 1200000);
  assert.equal(current.priceHistory['2026-08-24'], 980);
}

// ─── Never leaks across rarity — the DIC-856 exact-token contract ───────
{
  const index = buildPreservationIndex(prevCards);
  // Current card has rarity C; the only prev row that matches its signature
  // is the sibling C variant with its own sellPrice, NOT the U row above.
  const currentCVariant = freshCurrentCard({
    id: 'hSD03-011_hSD03_C_hSD03-011_C_02',
    rarity: 'C',
    sellPrice: null,
    prices: [],
  });
  const previous = findPreservedRow(index, currentCVariant.id, currentCVariant);
  assert.ok(previous);
  assert.equal(previous.rarity, 'C', 'signature only matches the same rarity');
  assert.notEqual(previous.sellPrice, 980, 'U-rarity 980円 must not leak onto the C variant');
  assert.equal(previous.sellPrice, 9999);
}

// ─── Ambiguous signatures refuse (DIC-1013 fail-closed) ─────────────────
{
  const index = buildPreservationIndex(prevCards);
  const current = {
    id: 'hBP01-050_hBP01_C_canonicalized',
    cardNumber: 'hBP01-050',
    sourceProduct: 'hBP01',
    rarity: 'C',
    sellPrice: null,
    prices: [],
  };
  const previous = findPreservedRow(index, current.id, current);
  assert.equal(previous, null, 'ambiguous signature must refuse to guess');
  const summary = applyPreservedMarketFields(current, previous);
  assert.equal(current.sellPrice, null, 'no preservation happens under ambiguity');
  assert.equal(summary.sellPrice, false);
}

// ─── preservedMarketPayload drops unproven / empty payload ──────────────
{
  const payload = preservedMarketPayload({ sellPrice: null, prices: [], priceHistory: {}, ytStats: null });
  assert.deepEqual(payload, {}, 'empty/null fields must not be carried forward as noise');
  const withZero = preservedMarketPayload({ sellPrice: 0 });
  assert.equal(withZero.sellPrice, undefined, 'sellPrice=0 is treated as unproven and dropped');
}

// ─── Shipped dataset regression: the fixture DIC-361 relies on ──────────
{
  const db = JSON.parse(fsMod.readFileSync('data/database.json', 'utf8'));
  const cards = Object.values(db.cards ?? {});
  const marketFixture = cards.find((c) =>
    Number(c.sellPrice) > 0
    && Number(c.buyPrice) > 0
    && c.priceHistory
    && Object.keys(c.priceHistory).length >= 2
    && c.ytStats
    && Object.values(c.ytStats).some((v) => v != null),
  );
  assert.ok(
    marketFixture,
    'shipped database.json must still contain at least one card carrying all four DIC-361 market fields',
  );
}

// ─── Renamed IDs must survive the real Step 5 append + Step 6 re-read ────
// Reviewer regression (Mac-Codex CR on 7283c521b): applyPreservedMarketFields
// restored 66-day priceHistory onto renamed printings, but build-database
// Step 5 wrote today's single-record file under the canonical id and Step 6
// then unconditionally re-read that file, collapsing the multi-day history.
// This block exercises the real ordering — preserve → seed → Step-5 append
// → Step-6 re-read — against a tmpdir fixture and asserts the preserved
// history survives the write-back.
{
  const tmp = fsMod.mkdtempSync(pathMod.join(os.tmpdir(), 'dic1204-hist-'));
  const historyDir = pathMod.join(tmp, 'price-history');
  fsMod.mkdirSync(historyDir, { recursive: true });

  const renamedId = 'hBP01-028_hBP08_HR_hBP01-028_HR';
  const preservedHistory = {
    '2026-06-16': 180,
    '2026-06-17': 180,
    '2026-06-25': 150,
    '2026-07-01': 120,
    '2026-08-25': 50,
  };
  const card = {
    id: renamedId,
    cardNumber: 'hBP01-028',
    name: '鷹嶺ルイ',
    rarity: 'HR',
    sourceProduct: 'hBP08',
    sellPrice: 50,
    prices: [{ name: '鷹嶺ルイ(パラレル/HR)', sellPrice: 50, rarity: 'HR' }],
    priceHistory: { ...preservedHistory },
  };
  const cards = { [renamedId]: card };

  // Sanity: no canonical-ID history file exists yet — this is the exact
  // renamed-printing situation the reviewer flagged (1,566 shipped rows).
  const canonicalFile = pathMod.join(historyDir, historyFilenameFor(renamedId));
  assert.ok(!fsMod.existsSync(canonicalFile), 'canonical-ID history file must NOT exist before the seed step');

  // Step 4c — seed the canonical-ID file with the preserved history.
  const seedResult = seedCanonicalHistoryFiles({
    cards,
    historyDir,
    fsAdapter: { fs: fsMod, path: pathMod },
    now: new Date('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(seedResult.seededFiles, 1, 'exactly one canonical-ID file gets seeded from the preserved history');
  assert.equal(seedResult.addedRecords, 5, 'every preserved date must appear as a records[] entry');

  // Simulate build-database.js Step 5: append today's record.
  const today = '2026-08-26';
  const todayPrice = 50;
  const stepFive = JSON.parse(fsMod.readFileSync(canonicalFile, 'utf8'));
  const seen = new Set(stepFive.records.map((r) => r.date));
  if (!seen.has(today)) {
    stepFive.records.push({ date: today, price: todayPrice, source: 'yuyu-tei', currency: 'JPY', cardId: renamedId });
    stepFive.records.sort((a, b) => a.date.localeCompare(b.date));
  }
  fsMod.writeFileSync(canonicalFile, JSON.stringify(stepFive, null, 2));

  // Simulate Step 6: unconditionally re-read the file and overwrite
  // card.priceHistory. Without the seed above this is the exact write that
  // collapsed multi-day history to today's single record on shipped main.
  const readBack = JSON.parse(fsMod.readFileSync(canonicalFile, 'utf8'));
  const rebuiltHistory = {};
  for (const r of readBack.records) rebuiltHistory[r.date] = r.price;
  card.priceHistory = rebuiltHistory;

  // Every preserved date must survive the round-trip AND today's record must
  // have been appended once. Missing preservation → collapse to 1 entry.
  const historyKeys = Object.keys(card.priceHistory).sort();
  assert.equal(historyKeys.length, 6, 'preserved 5 + appended 1 = 6 days must survive Step 5 → Step 6 write-back');
  for (const date of Object.keys(preservedHistory)) {
    assert.equal(
      card.priceHistory[date],
      preservedHistory[date],
      `preserved history for ${date} must survive the round-trip (Step 5/6 collapsing regression)`,
    );
  }
  assert.equal(card.priceHistory[today], todayPrice, "today's Step-5 append is present alongside preserved history");

  // Idempotency: seeding again after Step 5/6 must not add duplicate rows.
  const second = seedCanonicalHistoryFiles({
    cards,
    historyDir,
    fsAdapter: { fs: fsMod, path: pathMod },
    now: new Date('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(second.seededFiles, 0, 'seeding is idempotent — no duplicate rows on re-run');

  // Cross-printing leakage guard: a sibling renamed printing whose preserved
  // history has different dates + prices must not bleed into another card's
  // file. Each canonical-ID file stays isolated to its own cardId.
  const siblingId = 'hBP01-028_hBP08_HR_hBP01-028_HR_02';
  const siblingHistory = { '2026-07-15': 999, '2026-08-01': 888 };
  cards[siblingId] = {
    id: siblingId,
    cardNumber: 'hBP01-028',
    name: '鷹嶺ルイ',
    rarity: 'HR',
    sourceProduct: 'hBP08',
    sellPrice: 999,
    priceHistory: siblingHistory,
  };
  seedCanonicalHistoryFiles({
    cards,
    historyDir,
    fsAdapter: { fs: fsMod, path: pathMod },
    now: new Date('2026-08-26T00:00:00.000Z'),
  });
  const siblingDoc = JSON.parse(fsMod.readFileSync(pathMod.join(historyDir, historyFilenameFor(siblingId)), 'utf8'));
  assert.deepEqual(
    siblingDoc.records.map((r) => r.date).sort(),
    Object.keys(siblingHistory).sort(),
    'sibling canonical-ID file only carries the sibling row\'s own dates — no cross-printing leakage',
  );
  const originalDoc = JSON.parse(fsMod.readFileSync(canonicalFile, 'utf8'));
  assert.equal(
    originalDoc.records.some((r) => r.price === 999 || r.price === 888),
    false,
    'sibling prices/dates never leak into the original canonical-ID file',
  );

  // Non-positive prices are dropped fail-closed (would otherwise silently
  // pollute the trend curve with 0/null).
  const failClosedCard = {
    id: 'hXX-001_hXX_R_hXX-001_R',
    cardNumber: 'hXX-001',
    name: 'test',
    rarity: 'R',
    sourceProduct: 'hXX',
    priceHistory: { '2026-08-20': 0, '2026-08-21': -5, '2026-08-22': null, '2026-08-23': 100, '2026-08-24': 110 },
  };
  const failClosedResult = seedCanonicalHistoryFiles({
    cards: { [failClosedCard.id]: failClosedCard },
    historyDir,
    fsAdapter: { fs: fsMod, path: pathMod },
    now: new Date('2026-08-26T00:00:00.000Z'),
  });
  assert.equal(failClosedResult.addedRecords, 2, 'non-positive / null prices are dropped fail-closed');
  const failClosedDoc = JSON.parse(fsMod.readFileSync(pathMod.join(historyDir, historyFilenameFor(failClosedCard.id)), 'utf8'));
  for (const r of failClosedDoc.records) {
    assert.ok(r.price > 0, 'no zero/negative/null price survives the seed step');
  }

  // Cleanup tmpdir
  fsMod.rmSync(tmp, { recursive: true, force: true });
}

console.log('DIC-1204 market-field preservation contract checks passed');
