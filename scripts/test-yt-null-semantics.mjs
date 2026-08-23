#!/usr/bin/env node
/**
 * test-yt-null-semantics.mjs — DIC-1139 YouTube-delta null-vs-zero assertions.
 *
 * Guards two invariants:
 *
 *   1. Unit — computeGrowthDeltas emits null (never 0) for:
 *      - subscriber deltas smaller than the detected source precision
 *        (`subscriberCount` rounds to nearest 10k for popular channels).
 *      - view deltas where the latest and past `totalViewCount` are
 *        identical (source snapshot didn't tick → stale).
 *      - 1-day deltas whose only available past snapshot is not exactly one
 *        day old (non-contiguous scrape day).
 *      It DOES emit real deltas when the source truly proved growth.
 *
 *   2. Full-DB — no card in data/database.json carries a synthetic zero
 *      daily YT metric (growth_1d === 0, viewCount_1d === 0). A zero here
 *      is only allowed when the underlying yt-stats-history snapshot itself
 *      records a genuine, contiguous, precision-safe zero — and after
 *      DIC-1139 the pipeline collapses those to null, so the DB should
 *      never surface a raw 0.
 *
 *   3. Full-DB history — every stamped snapshot in yt-stats-history.json
 *      matches what computeGrowthDeltas would emit today. Guarantees the
 *      restamp fully backfilled and prevents drift when a new snapshot lands
 *      via a scraper still running the old algorithm.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeGrowthDeltas } from './lib/yt-growth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.json');
const HISTORY_PATH = path.resolve(__dirname, '../data/yt-stats-history.json');

let failures = 0;
function fail(msg) { failures += 1; console.error(`  ✗ ${msg}`); }
function ok(msg) { console.log(`  ✓ ${msg}`); }
function eq(actual, expected, msg) {
  if (actual === expected) ok(msg);
  else fail(`${msg} — expected ${JSON.stringify(expected)} got ${JSON.stringify(actual)}`);
}

// Every proven-happy-path unit test carries full provenance so the
// DIC-1140 provenance gate exercises real matching rather than accidentally
// short-circuiting through legacy-null fields.
const PROV = { channelId: 'UCTEST_CH', source: 'youtube_about_ssr', parser: 'ytInitialData.aboutChannelViewModel/v1' };
const prov = (extra) => ({ ...PROV, ...extra });

console.log('── Unit: computeGrowthDeltas ──');
{
  // subscriberCount all divisible by 10_000 → precision 10_000. Delta of 0
  // is below precision, must fold to null.
  const history = [
    prov({ date: '2026-08-20', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400500000 }),
    prov({ date: '2026-08-22', subscriberCount: 4400000, totalViewCount: 2401000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, 'sub delta 0 folds to null when source precision > delta');
  eq(d.viewCount_1d, 500000, 'view delta reported when totalViewCount ticks');
}
{
  // Precision detects at 100 when values are 100-multiples; then a delta of
  // 100 is above precision and REPORTED, not folded.
  const history = [
    prov({ date: '2026-08-20', subscriberCount: 4400, totalViewCount: 1000000 }),
    prov({ date: '2026-08-21', subscriberCount: 4500, totalViewCount: 1050000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, 100, 'exact sub delta reported when precision is finer');
}
{
  // Identical totalViewCount across contiguous days → stale-snapshot heuristic.
  const history = [
    prov({ date: '2026-08-20', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.viewCount_1d, null, 'view delta null when totalViewCount identical (stale snapshot)');
}
{
  // 1-day requires exactly-adjacent snapshot. Two-day gap is non-contiguous.
  const history = [
    prov({ date: '2026-08-20', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, '1d sub delta null when only non-adjacent snapshot exists');
  eq(d.viewCount_1d, null, '1d view delta null when only non-adjacent snapshot exists');
  eq(d.subscriberGrowth_7d, null, '7d sub delta null when no snapshot within window');
}
{
  // Real delta with contiguous snapshot and above-precision growth.
  const history = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, 10000, 'reports true 1d sub growth exactly at precision');
  eq(d.viewCount_1d, 11000000, 'reports true 1d view growth');
}

console.log('\n── Unit: DIC-1140 provenance gate ──');
{
  // Cross-channel adjacent snapshots must not produce a numeric delta — this
  // is the exact case the CR named ("Cross-channel adjacent snapshots
  // currently produce numeric 1d deltas"). Mutation-sensitive: setting the
  // channelId back to a match would make the delta reappear.
  const history = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000, channelId: 'UCOTHER' }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, 'cross-channel snapshots produce null (never a numeric delta)');
  eq(d.viewCount_1d, null, 'cross-channel view snapshots produce null');
  // Sanity: aligning channelId restores the true delta so the test is
  // mutation-sensitive to the very field it guards.
  const aligned = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000 }),
  ];
  eq(computeGrowthDeltas(aligned).viewCount_1d, 11000000, 'aligning channelId restores the real 1d');
}
{
  // Source (scraper) discontinuity: same channel, different scraper produces
  // measurements from different pipelines — fail closed.
  const history = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000, source: 'youtube_channelapi' }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000, source: 'youtube_about_ssr' }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, 'source discontinuity produces null');
  eq(d.viewCount_1d, null, 'source discontinuity nulls views too');
}
{
  // Parser version bump: same channel + source, but the parser changed —
  // measurement semantics may have shifted, so fail closed.
  const history = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000, parser: 'ytInitialData.aboutChannelViewModel/v0' }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, 'parser version bump produces null');
  eq(d.viewCount_1d, null, 'parser version bump nulls views');
}
{
  // Missing current-day evidence: trailing snapshot has counts but no
  // provenance (parser failed to stamp identity) → all deltas null even
  // though counts look present.
  const history = [
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2400000000 }),
    { date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2411000000 },
  ];
  const d = computeGrowthDeltas(history);
  eq(d.subscriberGrowth_1d, null, 'latest snapshot without provenance produces null (parser failure)');
  eq(d.viewCount_1d, null, 'latest snapshot without provenance nulls views');
}
{
  // Legacy no-provenance snapshot exists at the ONLY position inside the 7d
  // window — the gate refuses it, and since no other provenance-matching
  // snapshot is close enough to 7d, the delta stays null. Proves the gate
  // isn't quietly fallen-back-to on legacy data.
  const history = [
    { date: '2026-08-15', subscriberCount: 4400000, totalViewCount: 2380000000 },
    prov({ date: '2026-08-21', subscriberCount: 4400000, totalViewCount: 2386000000 }),
    prov({ date: '2026-08-22', subscriberCount: 4410000, totalViewCount: 2387000000 }),
  ];
  const d = computeGrowthDeltas(history);
  eq(d.viewCount_1d, 1000000, '1d aligned to provenance-matching adjacent snapshot');
  eq(d.viewCount_7d, null, '7d refuses to cross legacy no-provenance snapshot');
}

console.log('\n── Full-DB: no synthetic zero daily metrics ──');
{
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const violators = [];
  for (const [id, card] of Object.entries(db.cards || {})) {
    const y = card.ytStats;
    if (!y) continue;
    // Any zero here is by definition synthetic after DIC-1139: the pipeline
    // now folds unproven zeros to null (below-precision sub deltas + stale
    // snapshots). A stamped 0 means either an old raw snapshot leaked past
    // the restamp or a new zero rule was introduced.
    if (y.growth_1d === 0) violators.push(`${id}: growth_1d===0`);
    if (y.viewCount_1d === 0) violators.push(`${id}: viewCount_1d===0`);
    if (y.viewCount_daily === 0) violators.push(`${id}: viewCount_daily===0`);
    if (y.subscriberGrowth_1d === 0) violators.push(`${id}: subscriberGrowth_1d===0`);
  }
  eq(
    violators.length,
    0,
    `no synthetic zero daily metric on any card (first 3 violators: ${violators.slice(0, 3).join(' | ')})`,
  );
}

console.log('\n── Full-DB: yt-stats-history stamped deltas match computeGrowthDeltas ──');
{
  const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  let mismatched = 0;
  const samples = [];
  for (const [channelId, entry] of Object.entries(raw)) {
    if (!entry || !Array.isArray(entry.history)) continue;
    const sorted = [...entry.history].sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < sorted.length; i += 1) {
      const slice = sorted.slice(0, i + 1);
      const d = computeGrowthDeltas(slice);
      const target = sorted[i];
      for (const k of [
        'subscriberGrowth_1d', 'subscriberGrowth_7d', 'subscriberGrowth_15d', 'subscriberGrowth_30d',
        'viewCount_1d', 'viewCount_7d', 'viewCount_15d', 'viewCount_30d',
      ]) {
        const stamped = target[k] ?? null;
        const expected = d[k] ?? null;
        if (stamped !== expected) {
          mismatched += 1;
          if (samples.length < 5) samples.push(`${channelId} ${target.date} ${k}: stamped=${stamped} vs expected=${expected}`);
        }
      }
    }
  }
  eq(mismatched, 0, `every stamped snapshot delta matches current algorithm (samples: ${samples.join(' | ')})`);
}

console.log(failures === 0 ? '\n✅ All YT null-semantics assertions pass.' : `\n❌ ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
