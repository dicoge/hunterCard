#!/usr/bin/env node
/**
 * test-dic1334-final-artifact-collapse.mjs — DIC-1334 regression.
 *
 * Reproduces and guards against the production failure where a healthy yuyu
 * scrape (1,793 rows / 1,214 priced cardNumbers) collapsed to 468 priced rows
 * / 424 unique cardNumbers in the final canonical artifact.
 *
 * Root cause: the yuyu-only fallback gate in scripts/build-database.js only
 * added a yuyu-only card when NO official entry existed for its cardNumber
 * (`alreadyExists`). When the official catalog had entries for a cardNumber but
 * NONE matched the yuyu listing's exact series+rarity, the cardNumber was
 * considered "alreadyExists" and the yuyu price data was permanently discarded —
 * even though every official entry had sellPrice:null. That is the 1,214→424
 * collapse.
 *
 * This regression proves, red-before-green:
 *   1. A healthy fixture scrape keeps its priced-cardNumber coverage in the
 *      FINAL canonical artifact (does not collapse when official entries exist
 *      but do not match).
 *   2. The final canonical, native (public), and native-BUNDLE serializations
 *      have fixed-point parity for priced-cardNumber coverage.
 *   3. Exact-printing provenance is preserved: a C listing stays on the C row,
 *      an HR listing stays on the HR row, no cross-fill.
 *   4. The DIC-1334 post-transformation coverage audit FAILS the build when the
 *      final artifact collapses coverage below the 50% floor (fail-closed).
 *
 * Run: node scripts/test-dic1334-final-artifact-collapse.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');

function pricedCardNumbers(dbPath) {
  const d = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const s = new Set();
  for (const c of Object.values(d.cards || {})) {
    if (Number.isFinite(c.sellPrice) && c.sellPrice > 0) s.add(c.cardNumber);
  }
  return s;
}

/**
 * Given the committed database.json, derive a yuyu fixture GREP-able to build a
 * deterministic synthetic scrape: enumerate every unique cardNumber that the
 * committed DB already prices, and emit a yuyu entry with a sourceSeries /
 * rarity / yuyuImage that represents a healthy scrape of that cardNumber. A
 * healthy fixture must cover a large fraction of committed priced cardNumbers so
 * the post-transformation audit (final coverage >= 50% of scraped) is satisfied
 * on the fixed path.
 */
function makeYuyuFixture(cards) {
  const prices = {};
  const byNumber = new Map();
  for (const c of Object.values(cards)) {
    if (!(Number.isFinite(c.sellPrice) && c.sellPrice > 0)) continue;
    const num = c.cardNumber;
    if (!byNumber.has(num)) byNumber.set(num, []);
    byNumber.get(num).push(c);
  }
  for (const [num, rows] of byNumber) {
    if (prices[num]) continue;
    // Emit a single yuyu listing for the base rarity row (C/U/SR/etc.) so the
    // exact-print matcher can populate the OWN-SET row. Use the canonical
    // sourceSeries of the first row (origin product) and a synthetic image URL
    // whose product path matches sourceProduct so provenance passes.
    const origin = rows.find((r) => {
      const prefix = String(r.cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
      return prefix && String(r.sourceProduct || r.series || '').toLowerCase() === prefix[1].toLowerCase();
    }) || rows[0];
    const product = String(origin.sourceProduct || origin.series || '').toLowerCase();
    const rarity = origin.rarity || '';
    prices[num] = [{
      sellPrice: 500,
      rarity,
      name: origin.name || num,
      yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/${product}/dic1334.jpg`,
      imageVersion: product,
      imageCid: 'dic1334',
      sourceSeries: product,
      timestamp: new Date().toISOString(),
    }];
  }
  return { prices, totalCards: Object.keys(prices).length * 2, seriesWithPrices: 1, pricingUnavailable: false };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1334-collapse-'));
const fixturePath = path.join(tmp, 'yuyu-dic1334.json');
let passed = false;

// The real build-database.js run REWRITES durable price-history files under
// data/price-history (appending today's record to files that already exist) and
// rewrites data/scrape-log.txt. Capture the pre-run BYTES — not just the file
// list — so the tree is restored to exactly what we found. Restoring only the
// listing left every pre-existing tracked history file modified, which is churn
// the pipeline's dirty-worktree detection would trip over.
const historyDir = path.join(repo, 'data/price-history');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}
if (fs.existsSync(scrapeLogPath)) preRunBytes.set(scrapeLogPath, fs.readFileSync(scrapeLogPath));

try {
  const baseline = JSON.parse(originalDb);
  const cards = baseline.cards || {};
  const fixture = makeYuyuFixture(cards);
  const scrapedCount = Object.keys(fixture.prices).length;
  assert.ok(scrapedCount > 500, `fixture must cover >500 priced cardNumbers for a meaningful test; got ${scrapedCount}`);
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  // ── Case 1 (red-before-green): healthy pre-stage coverage must NOT collapse
  // in the final canonical artifact. Before the DIC-1334 fix, the yuyu-only
  // fallback discarded price data for any cardNumber with official entries but
  // no match, so the final canonical priced-cardNumber set was a small fraction
  // of the scraped set. In the red state this assertion fails, in the green
  // state (fixed alreadyExists gate) it passes.
  const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath,
      HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(build.status, 0, `build-database fixture run failed\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`);

  const finalDb = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const finalPriced = pricedCardNumbers(dbPath);
  // The exact-print matcher can only fill rows whose sourceSeries+rarity match
  // an official row exactly. The fixture emits the origin row's rarity, which
  // should fill most origin rows; a small gap is expected (reprint/promo rows
  // without a matching listing fail closed by design). But the coverage must
  // stay well above the 50% floor — it must NOT collapse to <50% of scraped
  // (the 35% collapse shape).
  const ratio = finalPriced.size / scrapedCount;
  assert.ok(
    finalPriced.size >= Math.floor(scrapedCount / 2),
    `final canonical artifact collapsed coverage: scraped ${scrapedCount} priced cardNumbers, final has ${finalPriced.size} (ratio ${ratio.toFixed(3)}). The yuyu-only fallback discarded price data.`,
  );
  console.log(`  ✓ final canonical retains ${finalPriced.size}/${scrapedCount} priced cardNumbers (ratio ${ratio.toFixed(3)})`);

  // ── Case 2: canonical/public/native fixed-point parity ──
  // The native generator must exactly reproduce the canonical priced coverage;
  // regenerate it from the freshly built canonical and assert parity.
  const nativeGen = spawnSync(process.execPath, ['scripts/generate-native-database.mjs'], {
    cwd: repo,
    env: { ...process.env },
    encoding: 'utf8',
  });
  assert.equal(nativeGen.status, 0, `generate-native-database failed\n${nativeGen.stdout}\n${nativeGen.stderr}`);
  const publicPriced = pricedCardNumbers(publicDbPath);
  assert.equal(
    publicPriced.size,
    finalPriced.size,
    `native/public priced-cardNumber coverage ${publicPriced.size} must equal canonical ${finalPriced.size} (fixed-point parity)`,
  );
  // The sanitized native asset strips forbidden fields but must keep the same
  // set of priced cardNumbers.
  const missingInNative = [...finalPriced].filter((n) => !publicPriced.has(n));
  assert.deepEqual(missingInNative, [], 'every canonical priced cardNumber must survive into the native asset');
  console.log(`  ✓ canonical/public/native parity: ${finalPriced.size} priced cardNumbers in both`);

  // ── Case 3: exact-printing provenance is preserved ──
  // C listing stays on the C row; HR listing stays on the HR row; no cross-fill.
  const cRow = Object.values(finalDb).find((c) => c.cardNumber === 'hBP03-025' && c.rarity === 'C' && c.sourceProduct === 'hBP03');
  const hrRow = Object.values(finalDb).find((c) => c.cardNumber === 'hBP03-025' && (c.rarity === 'HR' || c.rarity === '02_HR'));
  if (cRow && hrRow) {
    const cPrice = cRow.sellPrice;
    const hrPrice = hrRow.sellPrice;
    // Both rows came through the exact-print matcher with the SAME source value
    // in the fixture (the fixture emits a single rarity). If both are priced with
    // the identical value, that is fine as long as the provenance did not cross:
    // the C row must carry the fixture's C listing, the HR row the HR listing.
    // In the fixture we only emit the origin row's rarity, so the HR row
    // (if it differs from origin) has no exact listing and must fail closed to
    // null/empty unless its rarity equals the origin rarity.
    // The important invariant: no cross-fill via cardNumber fallback. If the HR
    // row got priced, it must be because its rarity exactly matched the emitted
    // listing, not because it borrowed the C listing.
    if (hrPrice != null) {
      assert.equal(
        hrRow.rarity,
        cRow.rarity,
        'HR row must only be priced when its rarity exactly matches the source listing (no cross-fill)',
      );
    }
    // The C (origin) row must be priced — it received the emitted listing.
    assert.ok(cPrice != null && cPrice > 0, 'origin C row must receive the exact C listing');
    console.log('  ✓ exact-printing provenance preserved (C/HR rows isolated)');
  }

  // ── Case 4 (DIC-1334/CR): strict exact-printing provenance for the
  // yuyu-only fallback + fail-closed coverage. The prior revision of this test
  // codified a flaw: it EXPECTED listings with an impossible rarity token (ZZZ)
  // to be admitted as priced yuyu-only rows. Mac-Codex CR DIC-1343 flagged that
  // the fallback validated only the FIRST entry's image product, then admitted
  // the whole priceData array and picked the lowest scalar — publishing an
  // unproven sibling/reprint price (a hBP03 cardNumber resolving ¥1 from a
  // hBP07/C sibling). We replace that positive ZZZ expectation with:
  //   4a. a mutation-sensitive NEGATIVE fixture (the CR's immutable repro) that
  //       must FAIL CLOSED — no unproven sibling price may be published;
  //   4b. an exact-source POSITIVE fixture that keeps coverage healthy; and
  //   4c. a coverage-collapse fixture that must FAIL the build via the DIC-1334
  //       coverage audit (fail-closed, no artifact).
  const builderSrc = fs.readFileSync(path.join(repo, 'scripts/build-database.js'), 'utf8');

  // ── 4a. Mutation-sensitive negative (CR P0 repro) ──
  // hBP03-025 has multiple official printings (hBP03/C, hBP07/HR, ent07, hPR/P).
  // A listing hBP03/ZZZ/500 can never prove to any exact printing (rarity ZZZ
  // matches no official row), and a sibling hBP07/C/1 listing cannot prove to
  // the hBP07/HR printing (rarity C ≠ HR) nor cross into hBP03. Both must be
  // refused; before the CR fix the whole array was admitted and the lowest
  // scalar (¥1 from the hBP07/C sibling) was published on an identity-less row.
  {
    const reproFixture = {
      prices: {
        'hBP03-025': [
          { sellPrice: 500, rarity: 'ZZZ', name: 'hBP03-025(ZZZ)', sourceSeries: 'hbp03', yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp03/dic1334.jpg', imageVersion: 'hbp03', imageCid: 'dic1334', timestamp: '2026-09-03T00:00:00.000Z' },
          // Sibling/reprint listing: product hBP07 (a DIFFERENT printing of
          // hBP03-025), priced at ¥1. Must NOT feed a hBP03 container.
          { sellPrice: 1, rarity: 'C', name: 'hBP03-025', sourceSeries: 'hbp07', yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/hbp07/dic1334.jpg', imageVersion: 'hbp07', imageCid: 'dic1334', timestamp: '2026-09-03T00:00:00.000Z' },
        ],
      },
      totalCards: 100,
      seriesWithPrices: 1,
    };
    const reproPath = path.join(tmp, 'yuyu-dic1334-cr-repro.json');
    fs.writeFileSync(reproPath, JSON.stringify(reproFixture, null, 2));
    const reproBuild = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: reproPath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
      encoding: 'utf8',
    });
    const reproCards = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    const leaked = Object.values(reproCards).filter(
      (c) => c.cardNumber === 'hBP03-025' && c.rarity === '' && c.series === '' && c.sellPrice === 1,
    );
    const anySiblingPrice = Object.values(reproCards).filter(
      (c) => c.cardNumber === 'hBP03-025' && c.sellPrice === 1,
    );
    // The identity-less yuyu-only fallback row (the CR's original emission with
    // sellPrice=1) must NOT exist. Pre-fix it did (repro exits 0 and emits
    // hBP03-025/sellPrice=1 from the hBP07/C sibling); post-fix it must be
    // rejected — fail-closed, no cardNumber-wide/sibling/cross-product fallback.
    assert.equal(leaked.length, 0, 'CR P0 repro: unproven sibling price (hBP03-025 sellPrice=1, identity-less) must be rejected');
    assert.equal(anySiblingPrice.length, 0, 'CR P0 repro: no hBP03-025 row may carry the ¥1 sibling listing');
    console.log('  ✓ negative (CR P0 repro): sibling/cross-product listing rejected, no unproven price');

    // ── 4b. Exact-source positive fixture ──
    // A listing that PROVES to exactly one official printing — or a truly
    // yuyu-only cardNumber with no official row — must still be priced, so the
    // fallback never collapses legitimate provable coverage. Build the healthy
    // fixture's provable listings and assert the coverage is retained (this is
    // the positive complement to 4a, replacing the flawed ZZZ expectation).
    const positiveFixture = { prices: {}, totalCards: 0, seriesWithPrices: 1 };
    for (const num of Object.keys(fixture.prices)) {
      const src = fixture.prices[num][0];
      positiveFixture.prices[num] = [{ ...src }];
      positiveFixture.totalCards += 1;
    }
    const positivePath = path.join(tmp, 'yuyu-dic1334-positive.json');
    fs.writeFileSync(positivePath, JSON.stringify(positiveFixture, null, 2));
    const positiveBuild = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: positivePath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
      encoding: 'utf8',
    });
    const positivePriced = pricedCardNumbers(dbPath);
    const positiveScraped = Object.keys(positiveFixture.prices).length;
    assert.equal(positiveBuild.status, 0, 'exact-source positive build must succeed');
    assert.ok(
      positivePriced.size >= Math.floor(positiveScraped / 2),
      `exact-source positive coverage collapsed to ${positivePriced.size}/${positiveScraped}`,
    );
    console.log(`  ✓ exact-source positive: provable listings retained (${positivePriced.size}/${positiveScraped})`);

    // ── 4c. Coverage-collapse fail-closed (red-before-green) ──
    // A scrape whose listings are entirely unprovable (impossible rarity token)
    // must collapse coverage and the DIC-1334 coverage audit must FAIL the build
    // (exit non-zero) with the collapse message — no identity-less dummy rows
    // paper over the gap, and nothing is published.
    const collapseFixture = { prices: {}, totalCards: 0, seriesWithPrices: 1 };
    for (const num of Object.keys(fixture.prices)) {
      collapseFixture.prices[num] = [{ ...fixture.prices[num][0], sellPrice: 500, rarity: 'ZZZ' }];
      collapseFixture.totalCards += 1;
    }
    const collapsePath = path.join(tmp, 'yuyu-dic1334-collapse.json');
    fs.writeFileSync(collapsePath, JSON.stringify(collapseFixture, null, 2));
    const collapseBuild = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: collapsePath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
      encoding: 'utf8',
    });
    // Fail-closed: unprovable listings must never be force-priced, so coverage
    // collapses and the build refuses to ship. This is the OPPOSITE of the old
    // (flawed) expectation that such data would be force-kept as yuyu-only rows.
    assert.notEqual(collapseBuild.status, 0, 'unprovable full-scrape collapse must FAIL the build (fail-closed)');
    assert.match(
      `${collapseBuild.stdout}\n${collapseBuild.stderr}`,
      /\[DIC-1334\] final canonical artifact collapsed priced-cardNumber coverage/,
      'the DIC-1334 coverage audit must fire with its collapse message on a coverage drop below the 50% floor',
    );
    assert.match(
      builderSrc,
      /\[DIC-1334\] final canonical artifact collapsed priced-cardNumber coverage/,
      'build-database.js must carry the DIC-1334 post-transformation coverage audit (fail-closed)',
    );
    console.log('  ✓ coverage-collapse fail-closed: unprovable full scrape refuses to ship (DIC-1334 audit fires)');
  }

  // ── Case 5 (DIC-1343/CR rev.2): compound printing identity ──
  // The previous revision keyed proven printings by `sourceProduct|normalized
  // rarity`, which collapses genuinely distinct official rows (ent07 `C` and
  // ent07 `02_C` both normalize to `C`), reported that collision as a UNIQUE
  // match, picked the first official row arbitrarily, and then published a bare
  // cardNumber row while the official compound row it claimed to have proven
  // stayed unpriced. Both halves are covered here.
  {
    // ── 5a. Noncanonical cardNumber, one unique official compound printing ──
    // hY01-14 (yuyu's short suffix) canonicalizes to hY01-014, whose only
    // official row is the compound key hY01-014_hEB01_SY_hY01-014_SY. A
    // hEB01/SY listing proves to exactly that printing, so its price must be
    // BOUND to that compound row — never published as a second, identity-less
    // hY01-014 row that leaves the proven printing null.
    const boundKey = 'hY01-014_hEB01_SY_hY01-014_SY';
    const uniqueFixture = {
      prices: {
        'hY01-14': [{
          sellPrice: 777,
          rarity: 'SY',
          name: '白エール',
          sourceSeries: 'heb01',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/heb01/dic1334.jpg',
          imageVersion: 'heb01',
          imageCid: 'dic1334',
          timestamp: '2026-09-04T00:00:00.000Z',
        }],
      },
      totalCards: 100,
      seriesWithPrices: 1,
    };
    const uniquePath = path.join(tmp, 'yuyu-dic1334-compound-unique.json');
    fs.writeFileSync(uniquePath, JSON.stringify(uniqueFixture, null, 2));
    const uniqueBuild = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: uniquePath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
      encoding: 'utf8',
    });
    assert.equal(uniqueBuild.status, 0, `unique-compound-binding build must succeed\nSTDOUT:\n${uniqueBuild.stdout}\nSTDERR:\n${uniqueBuild.stderr}`);
    const uniqueCards = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    const bareDuplicate = uniqueCards['hY01-014'];
    assert.equal(
      bareDuplicate,
      undefined,
      'CR rev.2: the fallback must not emit a bare hY01-014 row alongside the official compound printing',
    );
    const bound = uniqueCards[boundKey];
    assert.ok(bound, `official compound row ${boundKey} must exist`);
    assert.equal(bound.sellPrice, 777, `the proven price must be written onto the official compound row ${boundKey}, not a bare duplicate`);
    assert.equal(bound.rarity, 'SY', 'binding must not alter the official printing identity');
    assert.equal(bound.sourceProduct, 'hEB01', 'binding must not alter the official printing identity');
    const hy01Rows = Object.values(uniqueCards).filter((c) => c.cardNumber === 'hY01-014');
    assert.equal(hy01Rows.length, 1, 'hY01-014 must keep exactly one row (the official compound printing)');
    console.log(`  ✓ compound binding: hY01-14 listing bound to ${boundKey} (no bare duplicate)`);

    // ── 5b. C vs 02_C ambiguity must fail closed ──
    // hBP01-024 carries TWO distinct official ent07 printings, `C` and `02_C`.
    // A ent07/C listing matches both once rarity is normalized, so it resolves
    // to more than one official compound identity and must be refused outright:
    // no bare row, and neither ent07 printing may be filled.
    const ambiguousFixture = {
      prices: {
        'hBP01-24': [{
          sellPrice: 888,
          rarity: 'C',
          name: 'ベスティア・ゼータ',
          sourceSeries: 'ent07',
          yuyuImage: 'https://card.yuyu-tei.jp/hocg/100_140/ent07/dic1334.jpg',
          imageVersion: 'ent07',
          imageCid: 'dic1334',
          timestamp: '2026-09-04T00:00:00.000Z',
        }],
      },
      totalCards: 100,
      seriesWithPrices: 1,
    };
    const ambiguousPath = path.join(tmp, 'yuyu-dic1334-compound-ambiguous.json');
    fs.writeFileSync(ambiguousPath, JSON.stringify(ambiguousFixture, null, 2));
    const ambiguousBuild = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: { ...process.env, HUNTERCARD_YUYU_FIXTURE_PATH: ambiguousPath, HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1' },
      encoding: 'utf8',
    });
    assert.equal(ambiguousBuild.status, 0, `ambiguity fixture build must complete\nSTDOUT:\n${ambiguousBuild.stdout}\nSTDERR:\n${ambiguousBuild.stderr}`);
    const ambiguousCards = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
    assert.equal(
      ambiguousCards['hBP01-024'],
      undefined,
      'CR rev.2: an ambiguous C/02_C listing must not publish a bare hBP01-024 row',
    );
    const carrying888 = Object.entries(ambiguousCards)
      .filter(([, c]) => c.cardNumber === 'hBP01-024' && c.sellPrice === 888)
      .map(([k]) => k);
    assert.deepEqual(
      carrying888,
      [],
      `CR rev.2: the ¥888 ent07 listing is ambiguous across C and 02_C and must fail closed; it leaked onto ${carrying888.join(', ')}`,
    );
    assert.match(
      `${ambiguousBuild.stdout}\n${ambiguousBuild.stderr}`,
      /distinct official printings proven \(ambiguous/,
      'the fallback must report the ambiguous-printing fail-closed reason',
    );
    console.log('  ✓ compound ambiguity: ent07 C vs 02_C listing failed closed (no bare row, no cross-fill)');
  }

  console.log('✓ DIC-1334 final-artifact-collapse regression passed');
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  // Delete every file the build runs created, then restore the pre-run bytes of
  // every file that already existed, so the worktree is byte-identical to what
  // the test found.
  for (const f of fs.readdirSync(historyDir)) {
    const p = path.join(historyDir, f);
    if (!preRunBytes.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });

  // Self-proving hermeticity: only assert once the test body itself passed, so a
  // real assertion failure is never masked by this check.
  if (passed) {
    const dirty = [];
    if (fs.readFileSync(dbPath, 'utf8') !== originalDb) dirty.push(dbPath);
    if (fs.readFileSync(publicDbPath, 'utf8') !== originalPublicDb) dirty.push(publicDbPath);
    for (const f of fs.readdirSync(historyDir)) {
      const p = path.join(historyDir, f);
      if (!preRunBytes.has(p)) dirty.push(`${p} (new)`);
    }
    for (const [p, bytes] of preRunBytes) {
      if (!fs.existsSync(p) || !fs.readFileSync(p).equals(bytes)) dirty.push(p);
    }
    assert.deepEqual(dirty, [], `regression must be worktree-hermetic; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched tracked file restored byte-for-byte');
  }
}
