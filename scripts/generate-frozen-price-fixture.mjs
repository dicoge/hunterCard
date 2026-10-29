#!/usr/bin/env node
/**
 * generate-frozen-price-fixture.mjs — write/verify the frozen price snapshot the
 * exact-price regressions assert against (DIC-1127).
 *
 * Writing it is a DELIBERATE act: the snapshot is what makes a pinned ¥ total
 * mean something, so regenerating it changes what those tests assert. It is never
 * the right response to a failing assertion — if the app's pricing changed, the
 * assertion is the thing to look at.
 *
 * `--check` deliberately does NOT compare the snapshot against the live database.
 * That comparison is exactly the coupling this fixture exists to remove: the
 * nightly scrape rewrites public/data/database.json, so a byte-equality check
 * would fail on the next price move and block CI all over again. What it verifies
 * is that the snapshot still DESCRIBES the repo: every card number the
 * regressions need is present, well-formed, and still exists in the shipped
 * catalog.
 *
 * Write:  node scripts/generate-frozen-price-fixture.mjs [--ref <git-ref>]
 * Extend: node scripts/generate-frozen-price-fixture.mjs --extend --ref <git-ref> [--ref <git-ref> …]
 *         ADDITIVE: keeps every existing entry byte-for-byte and adds only card numbers
 *         the regressions newly need, each recorded under `supplements` with its exact
 *         source commit and method (PR228: the vol.15 tournament decks).
 * Verify: node scripts/generate-frozen-price-fixture.mjs --check
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  FIXTURE_PATH,
  LIVE_DB_PATH,
  buildFixtureString,
  extendFixtureString,
  fixtureCardNumbers,
} from './lib/frozen-price-fixture.mjs';

const rel = (p) => path.relative(process.cwd(), p);

/** Everything that must be true of the committed snapshot, price values aside. */
function verify() {
  if (!fs.existsSync(FIXTURE_PATH)) {
    return [`${rel(FIXTURE_PATH)} is missing — run: node scripts/generate-frozen-price-fixture.mjs`];
  }
  const problems = [];
  const parsed = JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8'));
  const cards = parsed.cards ?? {};
  const required = fixtureCardNumbers();
  const live = JSON.parse(fs.readFileSync(LIVE_DB_PATH, 'utf8'));
  const liveNumbers = new Set(Object.values(live.cards ?? {}).map((r) => r.cardNumber));

  for (const cardNumber of required) {
    if (!Array.isArray(cards[cardNumber])) {
      problems.push(`${cardNumber}: the regressions need this card number, the snapshot has no listings for it`);
    }
  }
  for (const [cardNumber, listings] of Object.entries(cards)) {
    if (!Array.isArray(listings)) {
      problems.push(`${cardNumber}: listings must be an array`);
      continue;
    }
    for (const listing of listings) {
      if (!listing || typeof listing !== 'object') {
        problems.push(`${cardNumber}: a listing is not an object`);
      } else if (typeof listing.name !== 'string') {
        problems.push(`${cardNumber}: a listing has no name — printing identity comes from the label alone`);
      } else if (listing.sellPrice !== null && typeof listing.sellPrice !== 'number') {
        problems.push(`${cardNumber}: "${listing.name}" has a non-numeric sellPrice`);
      } else if ('buyPrice' in listing) {
        problems.push(`${cardNumber}: "${listing.name}" carries a buyPrice, which may never reach a deck cost`);
      }
    }
    if (!liveNumbers.has(cardNumber)) {
      problems.push(`${cardNumber}: frozen here but no longer in the shipped catalog`);
    }
  }
  // Additive supplements must say exactly where each added card number came from.
  const supplemented = new Set();
  for (const s of parsed.supplements ?? []) {
    if (!/^[0-9a-f]{40}$/.test(s?.commit ?? '')) problems.push(`supplement ${s?.ref}: commit must be a full SHA`);
    if (!['rows-agree', 'per-printing-union'].includes(s?.method)) problems.push(`supplement ${s?.ref}: unknown method ${s?.method}`);
    for (const n of s?.cardNumbers ?? []) {
      if (supplemented.has(n)) problems.push(`${n}: listed by more than one supplement`);
      supplemented.add(n);
      if (!Array.isArray(cards[n])) problems.push(`${n}: supplement names a card number the snapshot does not hold`);
    }
  }
  return problems;
}

function main() {
  if (process.argv.includes('--check')) {
    const problems = verify();
    if (problems.length > 0) {
      console.error(`✗ ${rel(FIXTURE_PATH)} does not describe this repo:`);
      for (const p of problems) console.error(`  • ${p}`);
      process.exit(1);
    }
    const count = Object.keys(JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')).cards).length;
    console.log(`✓ frozen price fixture covers all ${count} required card numbers`);
    return;
  }
  if (process.argv.includes('--extend')) {
    const refs = process.argv.flatMap((a, i) => (a === '--ref' ? [process.argv[i + 1]] : []));
    if (refs.length === 0 || refs.some((r) => !r || r.startsWith('--'))) {
      console.error('✗ --extend needs at least one --ref <git-ref>');
      process.exit(1);
    }
    const contents = extendFixtureString({ refs });
    fs.writeFileSync(FIXTURE_PATH, contents, 'utf8');
    const parsed = JSON.parse(contents);
    const added = (parsed.supplements ?? []).reduce((n, s) => n + s.cardNumbers.length, 0);
    console.log(`✓ extended ${rel(FIXTURE_PATH)} — ${Object.keys(parsed.cards).length} card numbers (${added} supplemented)`);
    return;
  }
  const refFlag = process.argv.indexOf('--ref');
  const ref = refFlag === -1 ? null : process.argv[refFlag + 1];
  if (refFlag !== -1 && !ref) {
    console.error('✗ --ref needs a git ref, e.g. --ref a00676629');
    process.exit(1);
  }
  const contents = buildFixtureString({ ref });
  fs.mkdirSync(path.dirname(FIXTURE_PATH), { recursive: true });
  fs.writeFileSync(FIXTURE_PATH, contents, 'utf8');
  const count = Object.keys(JSON.parse(contents).cards).length;
  console.log(
    `✓ wrote ${rel(FIXTURE_PATH)} — ${count} card numbers frozen from `
    + `${rel(LIVE_DB_PATH)} @ ${ref ?? '(working tree)'}`,
  );
}

main();
