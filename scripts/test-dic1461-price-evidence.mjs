#!/usr/bin/env node
/**
 * test-dic1461-price-evidence.mjs — DIC-1461 opt-in diagnostic evidence dump.
 *
 * Proves the HUNTERCARD_PRICE_EVIDENCE_PATH contract:
 *   1. Default mode (env unset) emits NO artifact — byte-identical canonical
 *      behavior, nothing written at any evidence path.
 *   2. Opt-in mode writes valid, bounded, structured JSON atomically (no
 *      temp-file residue) whose classification is coherent with the scrape.
 *   3. Failure paths retain the evidence: a build that fail-closes at the
 *      DIC-1334 coverage gate still leaves the evidence artifact on disk,
 *      and the canonical failure semantics (exit code + collapse message)
 *      are unchanged.
 *   4. Collector unit contract: first-failing-predicate classification and
 *      string bounding over synthetic inputs; atomic writer contract.
 *
 * Run: node scripts/test-dic1461-price-evidence.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { collectPriceEvidence, writePriceEvidenceAtomic } from './lib/price-evidence.js';
import { yuyuImageProductPath } from './lib/preserve-market-fields.js';
import { normalizeRarityCode } from './lib/variant-key.js';
import { canonicalizeCardNumber } from './lib/card-number.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');

// ── Unit layer: collector classification + atomic writer ────────────────────
{
  const officialRow = (cardNumber, sourceProduct, rarity) => ({
    cardNumber, sourceProduct, series: sourceProduct, rarity,
  });
  const IMG = (product) => `https://card.yuyu-tei.jp/hocg/100_140/${product}/1.jpg`;

  const officialA = officialRow('hZZ01-001', 'hZZ01', 'C');
  const officialB1 = officialRow('hZZ01-002', 'hZZ01', 'C');
  const officialB2 = officialRow('hZZ01-002', 'hZZ01', 'SR');
  const officialC1 = officialRow('hZZ01-003', 'hZZ01', 'C');
  const officialC2 = officialRow('hZZ01-003', 'hZZ02', 'C');
  const officialD = officialRow('hZZ01-004', 'hZZ01', 'C');
  const officialE = officialRow('hZZ01-005', 'hZZ01', 'C');

  const officialByCardNum = {
    'hZZ01-001': [officialA],
    'hZZ01-002': [officialB1, officialB2],
    'hZZ01-003': [officialC1, officialC2],
    'hZZ01-004': [officialD],
    'hZZ01-005': [officialE],
  };
  const officialKeyByRow = new Map([
    [officialA, 'hZZ01-001_hZZ01_C'],
    [officialB1, 'hZZ01-002_hZZ01_C'],
    [officialB2, 'hZZ01-002_hZZ01_SR'],
    [officialC1, 'hZZ01-003_hZZ01_C'],
    [officialC2, 'hZZ01-003_hZZ02_C'],
    [officialD, 'hZZ01-004_hZZ01_C'],
    [officialE, 'hZZ01-005_hZZ01_C'],
  ]);

  // Deterministic stand-in matcher for the unit layer: exact product match on
  // the image URL, exact rarity when the listing carries one, unique-candidate
  // requirement when it does not — the same *shape* as the build matcher. The
  // integration layer below proves the real wiring.
  const matchesOfficial = (entry, official, candidateCount) => {
    const urlProd = yuyuImageProductPath(entry.yuyuImage);
    const officialSource = String(official.sourceProduct || '').toLowerCase();
    if (!entry.sourceSeries) return false;
    if (!urlProd || urlProd !== officialSource) return false;
    const entryRarity = normalizeRarityCode(entry.rarity || '');
    if (entryRarity !== '') return entryRarity === normalizeRarityCode(official.rarity);
    return candidateCount === 1;
  };

  const longUrl = `https://card.yuyu-tei.jp/hocg/100_140/hzz01/${'x'.repeat(1000)}.jpg`;
  const prices = {
    // unique exact proof
    'hZZ01-001': [{ sellPrice: 100, rarity: 'C', sourceSeries: 'hZZ01', yuyuImage: IMG('hzz01') }],
    // same-product multi-print ambiguity: empty rarity, 2 candidates in hZZ01
    'hZZ01-002': [{ sellPrice: 100, rarity: '', sourceSeries: 'hZZ01', yuyuImage: IMG('hzz01') }],
    // cross-product ambiguity: two listings each proving a different product
    'hZZ01-003': [
      { sellPrice: 100, rarity: 'C', sourceSeries: 'hZZ01', yuyuImage: IMG('hzz01') },
      { sellPrice: 200, rarity: 'C', sourceSeries: 'hZZ02', yuyuImage: IMG('hzz02') },
    ],
    // missing metadata: no sourceSeries at all
    'hZZ01-004': [{ sellPrice: 100, rarity: '', sourceSeries: '', yuyuImage: IMG('hzz01') }],
    // invalid image evidence (bounded-string check rides along on a second listing)
    'hZZ01-005': [
      { sellPrice: 100, rarity: '', sourceSeries: 'hZZ01', yuyuImage: 'https://card.yuyu-tei.jp/noimage_100_140.jpg' },
      { sellPrice: 100, rarity: '', sourceSeries: 'hZZ01', yuyuImage: longUrl.replace('/hzz01/', '/%%%/') },
    ],
    // yuyu-only: no official row
    'hZZ99-001': [{ sellPrice: 100, rarity: '', sourceSeries: 'hZZ99', yuyuImage: IMG('hzz99') }],
  };

  const finalCards = { 'hZZ01-001_hZZ01_C': { sellPrice: 100 } };
  const evidence = collectPriceEvidence({
    prices,
    officialByCardNum,
    officialKeyByRow,
    officialPricedCardNums: new Set(['hZZ01-001']),
    canonicalizeCardNumber,
    matchesOfficial,
    imageProductPath: yuyuImageProductPath,
    normalizeRarity: normalizeRarityCode,
    finalCards,
    prevPricedCardNumbers: new Set(['hZZ01-001', 'hZZ01-777']),
  });

  const byNum = Object.fromEntries(evidence.cardNumbers.map((r) => [r.cardNumber, r]));
  assert.equal(byNum['hZZ01-001'].bucket, 'unique_exact_proof');
  assert.equal(byNum['hZZ01-001'].decision, 'accepted_official_match');
  assert.equal(byNum['hZZ01-002'].bucket, 'same_product_multi_print_ambiguity');
  assert.equal(byNum['hZZ01-003'].bucket, 'cross_product_or_reprint_ambiguity');
  assert.equal(byNum['hZZ01-003'].reason, 'multiple_printings_proven_across_products');
  assert.equal(byNum['hZZ01-004'].bucket, 'missing_source_metadata');
  assert.equal(byNum['hZZ01-005'].bucket, 'invalid_or_missing_image_evidence');
  assert.equal(byNum['hZZ99-001'].bucket, 'source_listing_absent');
  assert.equal(byNum['hZZ99-001'].decision, 'yuyu_only_no_official_row');
  // hZZ01-777 was previously priced but is absent from the scrape.
  assert.ok(evidence.previouslyPricedNowUnlisted.includes('hZZ01-777'));
  assert.equal(
    evidence.classification.source_listing_absent,
    2,
    'yuyu-only cardNumber + previously-priced-now-unlisted must both land in source_listing_absent',
  );
  // Bounded strings: the >1000-char malformed URL must be truncated.
  const boundedListing = byNum['hZZ01-005'].listings[1];
  assert.ok(boundedListing.yuyuImage.length <= 320, 'listing strings must be bounded');
  assert.ok(boundedListing.yuyuImage.endsWith('…[truncated]'));
  // Classification total = scraped cardNumbers + unlisted-previously-priced.
  const classifiedTotal = Object.values(evidence.classification).reduce((a, b) => a + b, 0);
  assert.equal(classifiedTotal, evidence.cardNumbers.length + evidence.previouslyPricedNowUnlisted.length);

  // Atomic writer: file lands, parses, no temp residue, overwrite works.
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1461-evidence-unit-'));
  try {
    const outPath = path.join(tmpDir, 'evidence.json');
    writePriceEvidenceAtomic(outPath, evidence);
    writePriceEvidenceAtomic(outPath, evidence); // idempotent overwrite
    const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
    assert.equal(parsed.schema, 'dic1461-price-evidence/v1');
    const residue = fs.readdirSync(tmpDir).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(residue, [], 'atomic writer must leave no temp files');
    // A write failure must throw (missing directory), not silently no-op.
    assert.throws(() => writePriceEvidenceAtomic(path.join(tmpDir, 'no-such-dir', 'x.json'), evidence));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  console.log('  ✓ unit: classification buckets, bounded strings, atomic writer');
}

// ── Integration layer: real build-database.js runs ──────────────────────────
// Same worktree-hermetic harness as test-dic1334-final-artifact-collapse.mjs:
// snapshot the bytes of everything the build rewrites, restore afterwards.
function makeHealthyFixture(cards) {
  const prices = {};
  const byNumber = new Map();
  for (const c of Object.values(cards)) {
    if (!(Number.isFinite(c.sellPrice) && c.sellPrice > 0)) continue;
    if (!byNumber.has(c.cardNumber)) byNumber.set(c.cardNumber, []);
    byNumber.get(c.cardNumber).push(c);
  }
  for (const [num, rows] of byNumber) {
    const origin = rows.find((r) => {
      const prefix = String(r.cardNumber || '').match(/^([A-Za-z]+[0-9A-Za-z]*)-\d+/);
      return prefix && String(r.sourceProduct || r.series || '').toLowerCase() === prefix[1].toLowerCase();
    }) || rows[0];
    const product = String(origin.sourceProduct || origin.series || '').toLowerCase();
    prices[num] = [{
      sellPrice: 500,
      rarity: origin.rarity || '',
      name: origin.name || num,
      yuyuImage: `https://card.yuyu-tei.jp/hocg/100_140/${product}/dic1461.jpg`,
      imageVersion: product,
      imageCid: 'dic1461',
      sourceSeries: product,
      timestamp: new Date().toISOString(),
    }];
  }
  return { prices, totalCards: Object.keys(prices).length * 2, seriesWithPrices: 1, pricingUnavailable: false };
}

const historyDir = path.join(repo, 'data/price-history');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}
if (fs.existsSync(scrapeLogPath)) preRunBytes.set(scrapeLogPath, fs.readFileSync(scrapeLogPath));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1461-evidence-'));
let passed = false;
try {
  const baselineCards = JSON.parse(originalDb).cards || {};
  const healthy = makeHealthyFixture(baselineCards);
  const healthyPath = path.join(tmp, 'yuyu-healthy.json');
  fs.writeFileSync(healthyPath, JSON.stringify(healthy));
  const scrapedCount = Object.keys(healthy.prices).length;
  assert.ok(scrapedCount > 300, `healthy fixture must be meaningful; got ${scrapedCount}`);

  const evidencePath = path.join(tmp, 'evidence-live.json');

  // ── 1. Default mode: env unset → NO artifact ──
  {
    const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: {
        ...process.env,
        HUNTERCARD_YUYU_FIXTURE_PATH: healthyPath,
        HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
        HUNTERCARD_PRICE_EVIDENCE_PATH: '',
      },
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, `default-mode build must succeed\n${build.stdout}\n${build.stderr}`);
    assert.ok(!fs.existsSync(evidencePath), 'default mode must emit no evidence artifact');
    assert.ok(
      !`${build.stdout}${build.stderr}`.includes('[DIC-1461]'),
      'default mode must not log the evidence step',
    );
  }

  // ── 2. Opt-in mode: valid bounded JSON, atomic, coherent ──
  {
    const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: {
        ...process.env,
        HUNTERCARD_YUYU_FIXTURE_PATH: healthyPath,
        HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
        HUNTERCARD_PRICE_EVIDENCE_PATH: evidencePath,
      },
      encoding: 'utf8',
    });
    assert.equal(build.status, 0, `opt-in build must succeed\n${build.stdout}\n${build.stderr}`);
    assert.ok(fs.existsSync(evidencePath), 'opt-in mode must write the evidence artifact');
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    assert.equal(evidence.schema, 'dic1461-price-evidence/v1');
    assert.equal(evidence.cardNumbers.length, scrapedCount, 'one evidence row per scraped cardNumber');
    assert.equal(evidence.gate.wouldFail, false, 'healthy fixture must not trip the gate');
    assert.ok(evidence.classification.unique_exact_proof > scrapedCount / 2, 'healthy fixture must mostly prove');
    const residue = fs.readdirSync(tmp).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(residue, [], 'no temp residue next to the artifact');
    // Structured metadata only — spot-check no bulk content fields exist.
    for (const row of evidence.cardNumbers.slice(0, 50)) {
      for (const listing of row.listings) {
        assert.ok(!('html' in listing) && !('headers' in listing) && !('cookies' in listing));
        assert.ok(listing.yuyuImage.length <= 320);
      }
    }
  }

  // ── 3. Failure path: DIC-1334 collapse still writes evidence first ──
  {
    const collapse = { prices: {}, totalCards: 0, seriesWithPrices: 1 };
    for (const num of Object.keys(healthy.prices)) {
      collapse.prices[num] = [{ ...healthy.prices[num][0], rarity: 'ZZZ' }];
      collapse.totalCards += 1;
    }
    const collapsePath = path.join(tmp, 'yuyu-collapse.json');
    fs.writeFileSync(collapsePath, JSON.stringify(collapse));
    const collapseEvidencePath = path.join(tmp, 'evidence-collapse.json');
    const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
      cwd: repo,
      env: {
        ...process.env,
        HUNTERCARD_YUYU_FIXTURE_PATH: collapsePath,
        HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
        HUNTERCARD_PRICE_EVIDENCE_PATH: collapseEvidencePath,
      },
      encoding: 'utf8',
    });
    assert.notEqual(build.status, 0, 'unprovable full scrape must still fail closed at the DIC-1334 gate');
    assert.match(
      `${build.stdout}\n${build.stderr}`,
      /\[DIC-1334\] final canonical artifact collapsed priced-cardNumber coverage/,
      'canonical failure semantics (collapse message) must be unchanged in diagnostic mode',
    );
    assert.ok(
      fs.existsSync(collapseEvidencePath),
      'the evidence artifact must be retained when the build fail-closes at the gate',
    );
    const evidence = JSON.parse(fs.readFileSync(collapseEvidencePath, 'utf8'));
    assert.equal(evidence.gate.wouldFail, true, 'evidence must record that the gate fired');
    assert.equal(evidence.classification.unique_exact_proof, 0, 'nothing can prove under an impossible rarity token');
    assert.ok(
      evidence.cardNumbers.every((r) => r.decision !== 'accepted_official_match' && r.decision !== 'accepted_fallback_bound'),
      'no accepted decisions under an impossible rarity token',
    );
  }

  console.log('✓ DIC-1461 price-evidence contract passed');
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  for (const f of fs.readdirSync(historyDir)) {
    const p = path.join(historyDir, f);
    if (!preRunBytes.has(p)) fs.rmSync(p, { recursive: true, force: true });
  }
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  fs.rmSync(tmp, { recursive: true, force: true });
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
    assert.deepEqual(dirty, [], `test must be worktree-hermetic; still differing: ${dirty.join(', ')}`);
    console.log('  ✓ worktree-hermetic: every touched tracked file restored byte-for-byte');
  }
}
