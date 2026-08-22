/**
 * frozen-price-fixture.mjs — a committed, immutable snapshot of the yuyu-tei
 * listings the price regressions assert on (DIC-1127).
 *
 * `public/data/database.json` is a LIVE artefact: the nightly scrape rewrites it
 * whenever the market moves. Suites that pinned exact prices against it therefore
 * failed on a day nothing in the app changed — the 2026-08-21 scrape moved three
 * DUKHN listings (hBP05-080 ¥980→¥680, hBP01-104 ¥500→¥420, hBP05-074 ¥320→¥180)
 * and the deck total the tests pinned (¥12,660) simply became a different, equally
 * correct number, blocking every unrelated PR.
 *
 * The fix separates the two things those suites were conflating:
 *
 *   • BEHAVIOUR — which printing wins, that a premium listing never beats a plain
 *     one, that an ambiguous listing stays unpriced, that a total is the sum of the
 *     selected printings. Exact numbers are meaningful here, so this fixture
 *     supplies them from FROZEN data that no scrape can touch.
 *   • The LIVE dataset still being wired up correctly — asserted as invariants
 *     (relations that hold at any price) against `public/data/database.json`, so a
 *     genuinely broken pipeline is still caught.
 *
 * The snapshot carries only `prices[]` per card number, which is the only input to
 * printing identity and to every price this repo derives. It covers the card
 * numbers named by the regressions plus every card of every committed tournament
 * deck, so a deck total can be computed entirely from frozen data.
 *
 * Regenerate deliberately (never as a fix for a failing assertion — a changed
 * frozen price changes what the tests mean):
 *   node scripts/generate-frozen-price-fixture.mjs
 * Verify the committed file is what the generator produces:
 *   node scripts/generate-frozen-price-fixture.mjs --check
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dirname = path.dirname(fileURLToPath(import.meta.url));
export const repoRoot = path.join(dirname, '..', '..');
export const FIXTURE_PATH = path.join(dirname, '..', 'fixtures', 'frozen-card-prices.json');
export const LIVE_DB_PATH = path.join(repoRoot, 'public', 'data', 'database.json');

/**
 * Card numbers the price regressions name explicitly, beyond the tournament decks
 * that are discovered from `data/tournaments/`. Keeping them here means the
 * generator, not a human, decides what the snapshot contains.
 */
export const PINNED_CARD_NUMBERS = [
  // DIC-1060 / DIC-1064: the five reported deck-editor regressions and the
  // genuinely unlisted yell card.
  'hBP07-006', 'hBP01-044', 'hBP01-045', 'hBP01-046', 'hSD01-009', 'hY05-003',
  // DIC-1013: version alignment / scan fail-closed named cases.
  'hBP04-005', 'hBP02-084', 'hSD01-017', 'hBP02-017',
  // DIC-1013 CR: same-price エラッタ前／後 pairs that must resolve identically on
  // the card-detail and deck production lines.
  'hBP03-027', 'hSD07-003', 'hBP01-081', 'hBP02-003', 'hBP02-078', 'hBP02-102',
];

/** Every card number appearing in a committed monthly tournament report. */
export function tournamentCardNumbers(root = repoRoot) {
  const dir = path.join(root, 'data', 'tournaments');
  const numbers = new Set();
  for (const file of fs.readdirSync(dir).filter((f) => /^\d{4}-\d{2}\.json$/.test(f))) {
    const month = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    for (const event of month.events ?? []) {
      for (const deck of event.decks ?? []) {
        for (const card of deck.cards ?? []) {
          if (card?.cardNumber) numbers.add(card.cardNumber);
        }
      }
    }
  }
  return numbers;
}

/** The exact card numbers the snapshot must cover, in deterministic order. */
export function fixtureCardNumbers(root = repoRoot) {
  return Array.from(new Set([...PINNED_CARD_NUMBERS, ...tournamentCardNumbers(root)])).sort();
}

/**
 * A card number's listings are stored once per set it was reprinted in, and every
 * such row carries the SAME listing set (printing identity lives in the listing
 * label, not in the row). One row therefore states the whole card number's prices;
 * this asserts that assumption instead of trusting it.
 */
export function listingsByCardNumber(rawCards, numbers) {
  const rows = new Map();
  for (const raw of rawCards) {
    if (!numbers.has(raw.cardNumber)) continue;
    const listings = JSON.stringify(raw.prices ?? []);
    const seen = rows.get(raw.cardNumber);
    if (seen === undefined) rows.set(raw.cardNumber, listings);
    else if (seen !== listings) {
      throw new Error(
        `${raw.cardNumber}: rows disagree about the card number's listings; the `
        + 'fixture cannot represent it as one listing set',
      );
    }
  }
  return rows;
}

/** The live database as some git ref committed it, for a reproducible snapshot. */
export function databaseAtRef(ref, root = repoRoot) {
  return execFileSync('git', ['show', `${ref}:public/data/database.json`], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
}

/**
 * The exact bytes the committed fixture must contain.
 *
 * `ref` records WHERE the frozen prices came from, so the snapshot is
 * reproducible from history rather than from whatever the scrape published on
 * the day someone happened to run the generator.
 */
export function buildFixtureString({ ref = null, root = repoRoot } = {}) {
  const source = ref
    ? databaseAtRef(ref, root)
    : fs.readFileSync(path.join(root, 'public', 'data', 'database.json'), 'utf8');
  const live = JSON.parse(source);
  const numbers = fixtureCardNumbers(root);
  const rows = listingsByCardNumber(Object.values(live.cards ?? {}), new Set(numbers));
  const missing = numbers.filter((n) => !rows.has(n));
  if (missing.length > 0) {
    throw new Error(`the source database has no row for: ${missing.join(', ')}`);
  }
  const cards = {};
  for (const cardNumber of numbers) cards[cardNumber] = JSON.parse(rows.get(cardNumber));
  return `${JSON.stringify({
    _comment: 'FROZEN test data — see scripts/lib/frozen-price-fixture.mjs. Never edit to make a test pass.',
    generator: 'scripts/generate-frozen-price-fixture.mjs',
    source: {
      path: 'public/data/database.json',
      ref: ref ?? '(working tree)',
    },
    cards,
  }, null, 2)}\n`;
}

let cached = null;

/** cardNumber → its frozen listings, exactly as the source published them. */
export function frozenListings() {
  if (!cached) {
    const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
    cached = new Map(Object.entries(parsed.cards));
  }
  return cached;
}

/**
 * The frozen snapshot in the shape `adaptDatabase` consumes: one raw row per card
 * number carrying that number's frozen listings, and nothing that could reach a
 * price. Display fields are taken from the LIVE row so the rendered card is the
 * real one — only the prices are frozen.
 *
 * A card number the live database no longer has is a real failure, not something
 * to skip: the fixture would then be describing cards the app cannot show.
 */
export function frozenRawCards(liveRawCards) {
  const listings = frozenListings();
  const byNumber = new Map();
  for (const raw of liveRawCards) {
    if (!listings.has(raw.cardNumber)) continue;
    if (!byNumber.has(raw.cardNumber)) byNumber.set(raw.cardNumber, []);
    byNumber.get(raw.cardNumber).push(raw);
  }
  const missing = Array.from(listings.keys()).filter((n) => !byNumber.has(n));
  if (missing.length > 0) {
    throw new Error(
      `frozen fixture covers card numbers the live database no longer has: ${missing.join(', ')}`,
    );
  }
  const rows = [];
  for (const [cardNumber, liveRows] of byNumber) {
    const frozen = listings.get(cardNumber);
    for (const row of liveRows) {
      // `sellPrice` is the row's card-number-wide lowest price. It is a derived
      // mirror of `prices[]`, so it is re-derived here rather than carried over
      // live and left inconsistent with the frozen listings.
      const prices = frozen.map((p) => ({ ...p }));
      const sellPrices = prices.map((p) => p.sellPrice).filter((p) => typeof p === 'number' && p > 0);
      rows.push({
        ...row,
        prices,
        sellPrice: sellPrices.length > 0 ? Math.min(...sellPrices) : null,
      });
    }
  }
  return rows;
}

/** The whole live database with every fixture-covered card number frozen. Used by
 * suites that render the real screen, which loads the database as one object. */
export function frozenDatabase(liveDb) {
  const frozen = new Map(frozenRawCards(Object.values(liveDb.cards ?? {})).map((r) => [r.id, r]));
  const cards = {};
  for (const [key, row] of Object.entries(liveDb.cards ?? {})) {
    cards[key] = frozen.get(row.id) ?? row;
  }
  return { ...liveDb, cards };
}
