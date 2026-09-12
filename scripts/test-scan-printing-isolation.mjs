#!/usr/bin/env node
/**
 * DIC-1325 CR regression: the recognition response quotes the recognized
 * printing's OWN canonical sale price, never a sibling printing's.
 *
 * `fmt()` in api/recognize-card.ts carried a `rarity === 'SEC'` branch that
 * replaced the entry's canonical `sellPrice` with `Math.max` over its
 * `prices[]` — the same cross-printing Math.max the adjacent buyPrice comment
 * has forbidden since DIC-856. Every one of the 12 SEC entries that have
 * printings was affected: `hBP03-003` canonically sells for JPY 1,280 and the
 * API emitted JPY 128,000, the price of its パラレル/サイン printing.
 *
 * It was latent while DIC-1256 hid every price. DIC-1319 un-gated the scan
 * price surfaces, which turned it into a user-visible 100x wrong number on the
 * primary path — hence a release blocker rather than a cleanup.
 *
 * This test drives the REAL exported `rankCandidates` against the REAL shipped
 * catalog, in the Store MVP profile the Android build sends, and asserts
 * emitted price === the entry's own canonical price. Three layers:
 *
 *   1. The named CR fixture (hBP03-003 SEC) and every other SEC entry.
 *   2. A catalog-wide pass-through invariant over many probes, so a future
 *      rewrite keyed on something other than rarity is caught too.
 *   3. Discrimination + source guards, so the test cannot pass vacuously.
 *
 * Run: node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *        scripts/test-scan-printing-isolation.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { rankCandidates } from '../api/recognize-card.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf-8');

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const db = JSON.parse(read('data/database.json'));
const cards = db.cards;

function extractedFor(cardNumber, entry) {
  return {
    cardNumberRaw: cardNumber,
    characterName: entry?.name ?? '',
    rarity: entry?.rarity ?? '',
    hp: '',
    bloom: '',
    cardTitle: '',
  };
}

// Store MVP is what the Android release sends, so it is the profile under test.
//
// The catalog holds several rows per cardNumber (hBP03-003 alone has an SEC row
// and unpriced sibling rows), and rankCandidates legitimately picks whichever
// scores best. Reverse-mapping an emitted candidate back to its source row is
// therefore ambiguous — an early version of this test did that and mis-blamed
// the API for a null price that genuinely belonged to the row it had ranked.
//
// So the pass-through assertions rank a map containing exactly ONE entry. The
// ranked row is then known, the comparison is exact, and it still executes the
// real exported rankCandidates → fmt path. `rankWholeCatalog` keeps a realistic
// full-catalog call available where ranking behaviour itself matters.
function rankOnly(entry, storeMvp = true) {
  const id = `${entry.cardNumber}::probe`;
  const { candidates } = rankCandidates({ [id]: entry }, extractedFor(entry.cardNumber, entry), storeMvp);
  return candidates.find((c) => c.cardNumber === entry.cardNumber) ?? candidates[0];
}

function rankWholeCatalog(cardNumber, entry, storeMvp = true) {
  return rankCandidates(cards, extractedFor(cardNumber, entry), storeMvp).candidates;
}

// ── 1. The named CR fixture ──────────────────────────────────────────────────
const CR_ID = 'hBP03-003_ent07';
const crEntry = cards[CR_ID];

check(`catalog still contains the CR fixture ${CR_ID}`, !!crEntry);
check(
  `${CR_ID} is still the SEC/sibling divergence case the CR describes`,
  crEntry?.rarity === 'SEC'
    && crEntry?.sellPrice === 1280
    && Math.max(...crEntry.prices.map((p) => p.sellPrice || 0)) === 128000,
  `rarity=${crEntry?.rarity} own=${crEntry?.sellPrice} max=${crEntry && Math.max(...crEntry.prices.map((p) => p.sellPrice || 0))}`,
);

{
  const emitted = rankOnly(crEntry);
  check('the API emits a candidate for the CR fixture', !!emitted);
  check(
    "CR fixture: emitted sellPrice is the printing's own JPY 1,280",
    emitted?.sellPrice === 1280,
    `got ${emitted?.sellPrice}`,
  );
  check(
    'CR fixture: emitted sellPrice is NOT the sibling パラレル/サイン JPY 128,000',
    emitted?.sellPrice !== 128000,
    `got ${emitted?.sellPrice}`,
  );
  check(
    'CR fixture: the printing rows pass through with their own prices intact',
    JSON.stringify(emitted?.prices?.map((p) => p.sellPrice)) === JSON.stringify(crEntry.prices.map((p) => p.sellPrice)),
    `got ${JSON.stringify(emitted?.prices?.map((p) => p.sellPrice))}`,
  );
  // The 128,000 sibling must still be present as a ROW — the fix removes the
  // rewrite of the headline, it does not hide the printing list.
  check(
    'CR fixture: the expensive sibling is still listed as its own row',
    emitted?.prices?.some((p) => p.sellPrice === 128000),
  );

  // Realistic full-catalog call: whichever row ranks first, its price must be
  // that row's own, and it must never be the 128,000 rewrite.
  const wholeCatalog = rankWholeCatalog('hBP03-003', crEntry);
  check('full-catalog ranking still returns candidates for hBP03-003', wholeCatalog.length > 0);
  check(
    'full-catalog ranking never emits the rewritten JPY 128,000 headline for hBP03-003',
    wholeCatalog.every((c) => c.sellPrice !== 128000),
    `got ${JSON.stringify(wholeCatalog.map((c) => c.sellPrice))}`,
  );
}

// ── 2. Every SEC entry with printings, not just the named one ────────────────
{
  const secEntries = Object.entries(cards).filter(
    ([, e]) => e.rarity === 'SEC' && Array.isArray(e.prices) && e.prices.length > 0,
  );
  check('the catalog still has SEC entries with printings to test', secEntries.length > 0, `got ${secEntries.length}`);

  const leaked = [];
  for (const [id, entry] of secEntries) {
    const emitted = rankOnly(entry);
    if (!emitted) { leaked.push({ id, emitted: 'no candidate' }); continue; }
    if (emitted.sellPrice !== entry.sellPrice) {
      leaked.push({ id, emitted: emitted.sellPrice, own: entry.sellPrice });
    }
  }
  check(
    `no SEC entry has its headline price rewritten (${secEntries.length} checked)`,
    leaked.length === 0,
    `${leaked.length} leaked, e.g. ${JSON.stringify(leaked[0])}`,
  );
}

// ── 3. Catalog-wide pass-through, so a non-rarity-keyed rewrite is caught ────
{
  // Probe a broad slice, weighted toward the risky shape: entries whose
  // printings disagree on price. If any future branch rewrites the headline,
  // this trips regardless of what it keys on.
  const risky = Object.entries(cards).filter(([, e]) => {
    if (!Array.isArray(e.prices) || e.prices.length < 2) return false;
    const vals = e.prices.map((p) => p.sellPrice || 0);
    return Math.max(...vals) !== Math.min(...vals);
  });
  const probes = risky.slice(0, 250);
  check('probe set is large enough to be meaningful', probes.length >= 100, `got ${probes.length}`);

  const mismatches = [];
  for (const [, entry] of probes) {
    const emitted = rankOnly(entry);
    if (!emitted) continue;
    if (emitted.sellPrice !== entry.sellPrice) {
      mismatches.push({ n: entry.cardNumber, emitted: emitted.sellPrice, own: entry.sellPrice });
      continue;
    }
    const emittedPrices = JSON.stringify((emitted.prices ?? []).map((p) => p.sellPrice ?? null));
    const ownPrices = JSON.stringify((entry.prices ?? []).map((p) => p.sellPrice ?? null));
    if (emittedPrices !== ownPrices) {
      mismatches.push({ n: entry.cardNumber, rows: 'prices[] rewritten', emittedPrices, ownPrices });
    }
  }
  check(
    `emitted price equals the ranked printing's own price across ${probes.length} multi-price probes`,
    mismatches.length === 0,
    `${mismatches.length} mismatches, e.g. ${JSON.stringify(mismatches[0])}`,
  );
}

// ── 4. Controls: ordinary and パラレル printings were never the bug ──────────
// If these had been broken too, the fix would be masking a wider problem; if
// they trivially pass for every card, the probe above proves nothing. Both are
// asserted explicitly.
{
  const ordinary = Object.values(cards).find(
    (e) => e.rarity !== 'SEC' && Array.isArray(e.prices) && e.prices.length >= 2
      && typeof e.sellPrice === 'number' && e.sellPrice > 0
      && Math.max(...e.prices.map((p) => p.sellPrice || 0)) !== e.sellPrice,
  );
  check('found an ordinary (non-SEC) control whose max sibling differs from its own price', !!ordinary,
    'the control is what proves the SEC assertions are not trivially true');
  if (ordinary) {
    const emitted = rankOnly(ordinary);
    check(
      `ordinary control ${ordinary.cardNumber} keeps its own price (unchanged by this fix)`,
      emitted?.sellPrice === ordinary.sellPrice,
      `got ${emitted?.sellPrice}, own ${ordinary.sellPrice}`,
    );
  }
}

// ── 5. Discrimination: the fixture really can tell the two algorithms apart ──
// Re-implementing the REMOVED algorithm and showing it produces a different
// number on this data is what proves the assertions above are not vacuous. If
// the catalog ever flattened so that max === own, these checks would silently
// stop testing anything — this makes that failure loud.
{
  const oldAlgorithm = (entry) =>
    entry.rarity === 'SEC' && entry.prices?.length > 0
      ? Math.max(...entry.prices.map((p) => p.sellPrice || 0))
      : entry.sellPrice;

  check(
    'the removed Math.max algorithm would still produce a DIFFERENT number on the CR fixture',
    oldAlgorithm(crEntry) === 128000 && crEntry.sellPrice === 1280,
    `old=${oldAlgorithm(crEntry)} own=${crEntry.sellPrice}`,
  );

  const discriminating = Object.values(cards).filter(
    (e) => typeof e.sellPrice === 'number' && oldAlgorithm(e) !== e.sellPrice,
  );
  check(
    'multiple catalog entries still discriminate between the two algorithms',
    discriminating.length >= 5,
    `only ${discriminating.length} discriminating entries — the fixtures may have gone stale`,
  );
  console.log(`  … ${discriminating.length} entries would diverge under the removed algorithm`);
}

// ── 6. Source guard against reintroduction ───────────────────────────────────
{
  // Strip comments first. The fix's own explanatory comment necessarily names
  // the removed algorithm ("rarity === 'SEC'" ... "Math.max"), so a guard run
  // over raw source would match the documentation describing the bug and report
  // the bug as still present.
  const stripComments = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const src = stripComments(read('api/recognize-card.ts'));
  check(
    'fmt() no longer contains a rarity-keyed Math.max over prices[]',
    !/rarity\s*===\s*'SEC'[\s\S]{0,200}Math\.max/.test(src),
  );
  check(
    'no Math.max over a prices[] map survives anywhere in the recognition response builder',
    !/Math\.max\([\s\S]{0,80}prices\.map/.test(src),
  );
  check(
    'the DIC-856 cross-printing prohibition comment is still present',
    // Read raw here on purpose — this one IS asserting on a comment.
    /嚴禁在此做卡號 fallback \/ 跨版本 Math\.max/.test(read('api/recognize-card.ts')),
  );
}

// ── 7. CI runs this ──────────────────────────────────────────────────────────
{
  const ci = read('.github/workflows/ci.yml');
  check('CI executes the scan printing-isolation regression', ci.includes('test:scan-printing-isolation'));
  const pkg = JSON.parse(read('package.json'));
  check('package.json defines test:scan-printing-isolation', !!pkg.scripts['test:scan-printing-isolation']);
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Scan printing-isolation regression: ${passed} checks passed`);
} else {
  console.error('\n❌ Scan printing-isolation regression failed');
}
