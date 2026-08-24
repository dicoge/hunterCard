#!/usr/bin/env node
// Fetches Bloomレベル (Bloom Level: Debut / 1st / 2nd / Buzz / Spot) for every
// Holomen card seen in data/official/*.json and writes the canonical map to
// data/bloom-levels.json. Non-holomen cards (Oshi/Support/Yell/Mascot) are
// skipped because Bloom Level does not apply to them (DIC-1141).
//
// Field source: <dt>Bloomレベル</dt><dd>{{value}}</dd> inside
// .cardlist-Detail_Box_Inner on
// https://hololive-official-cardgame.com/cardlist/?id={{id}}&expansion={{expansion}}
//
// Safety invariants (DIC-1141 CR follow-up — this canonical overlay is a
// deployed artifact, so a broken run must never destroy it):
//   * `--only=<series>` NEVER removes canonical entries for other series. Only
//     targets in the requested scope are eligible to be overwritten.
//   * A fetch failure or an unrecognised parse for one card NEVER wipes that
//     card's previous canonical value. It stays as it was until the next
//     successful scrape.
//   * The final overlay is written via a temp file + atomic rename, so a crash
//     mid-write can never truncate the checked-in file.
//   * Abnormal batch-level regressions (net coverage drop, fetch-failure
//     ratio above threshold) exit non-zero WITHOUT writing, so CI or a cron
//     runner surfaces the drop instead of silently publishing an empty file.
//     `--allow-coverage-drop` opts out for legitimate removals (rare).
//
// The scraper is idempotent: existing entries in bloom-levels.json are kept as
// canonical unless `--force` is passed, so re-runs converge without re-hitting
// the origin. `--force` re-fetches every in-scope target. To limit scope, pass
// `--only=hBP04`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OFFICIAL_DIR = path.join(REPO, 'data', 'official');
const OUT_FILE = path.join(REPO, 'data', 'bloom-levels.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

export const VALID_LEVELS = Object.freeze(['Debut', '1st', '2nd', 'Buzz', 'Spot']);
const VALID_LEVEL_SET = new Set(VALID_LEVELS);

// Abnormality thresholds: guard against the two silent-corruption modes CR
// flagged. Both are conservative — a well-behaved re-scrape trips neither.
const DEFAULT_MAX_FETCH_FAILURE_RATIO = 0.10; // >10% network errors is abnormal
const DEFAULT_MAX_COVERAGE_DROP = 0;           // any drop against the prior overlay is abnormal

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

export function parseBloomLevel(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<dt>\s*Bloom(?:レベル|Level)\s*<\/dt>\s*<dd>([^<]+)<\/dd>/);
  if (!m) return null;
  const raw = m[1].trim();
  return VALID_LEVEL_SET.has(raw) ? raw : null;
}

/** Read the existing overlay (byCardNumber map). Missing file → {}. Corrupt
 *  file throws — callers must decide whether to fail closed. */
export function readOverlay(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const j = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  const by = j?.byCardNumber;
  if (by == null || typeof by !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(by)) {
    if (typeof k === 'string' && typeof v === 'string' && VALID_LEVEL_SET.has(v)) out[k] = v;
  }
  return out;
}

/** Collect Holomen targets from data/official/*.json (or an injected reader).
 *  `only` restricts to a single series file name (without .json). */
export function collectHolomenTargets({
  officialDir = OFFICIAL_DIR,
  only = null,
  readdir = (dir) => fs.readdirSync(dir),
  readFile = (file) => fs.readFileSync(file, 'utf8'),
} = {}) {
  const seen = new Map(); // cardNumber -> { id, expansion }
  if (!fs.existsSync(officialDir)) return seen;
  const files = readdir(officialDir).filter((f) => {
    if (!f.endsWith('.json')) return false;
    if (f.startsWith('_') || f.startsWith('all-') || f.startsWith('cardList_')) return false;
    if (only && f !== `${only}.json`) return false;
    return true;
  });
  for (const fn of files) {
    let cards;
    try {
      cards = JSON.parse(readFile(path.join(officialDir, fn)));
    } catch {
      continue;
    }
    if (!Array.isArray(cards)) continue;
    for (const c of cards) {
      const cn = c?.cardNumber;
      const id = c?.id;
      const exp = c?.expansion;
      if (!cn || !id || !exp) continue;
      // Only ホロメン (excluding 推しホロメン, サポート, マスコット, エール).
      if (c.cardType !== 'ホロメン') continue;
      if (!seen.has(cn)) seen.set(cn, { id, expansion: exp });
    }
  }
  return seen;
}

/**
 * Merge fetch results into the existing overlay. Preservation is the whole
 * point: anything not in `inScope` stays untouched, and anything in scope with
 * no fresh success also keeps its prior value. Callers pass:
 *   - existing: prior byCardNumber map (never mutated)
 *   - inScope: Set<cardNumber> of what THIS run planned to fetch
 *   - fresh:   Map<cardNumber, {level|null, error?}> — what actually came back
 *
 * The result carries both the merged map and per-card provenance so the CLI /
 * tests can reason about drops.
 */
export function mergeResults({ existing, inScope, fresh }) {
  const merged = { ...existing };
  const preservedOnFailure = [];   // in-scope cards where fetch failed but old value survived
  const preservedOutOfScope = [];  // cards not in this run's scope, kept as-is
  const added = [];                // in-scope cards with a new value where none existed
  const overwritten = [];          // in-scope cards whose value changed
  const removedByRun = [];         // in-scope cards where fetch succeeded but returned null (level absent on official page)
  const dropped = [];              // aggregated intentional drops (mirror of removedByRun)

  for (const cn of Object.keys(existing)) {
    if (!inScope.has(cn)) preservedOutOfScope.push(cn);
  }
  for (const cn of inScope) {
    const result = fresh.get(cn);
    if (!result) {
      // In scope but no result at all — never wipe.
      if (existing[cn]) preservedOnFailure.push(cn);
      continue;
    }
    if (result.error) {
      // Fetch/parse errored — preserve the prior canonical value.
      if (existing[cn]) preservedOnFailure.push(cn);
      continue;
    }
    if (result.level == null) {
      // Fetch OK, level not found. Treat as an intentional removal signal only
      // if the caller opts in; by default we KEEP the prior canonical so a
      // one-off page render glitch cannot silently strip the record.
      if (existing[cn]) preservedOnFailure.push(cn);
      continue;
    }
    if (!VALID_LEVEL_SET.has(result.level)) {
      // Guard against a corrupt injection.
      if (existing[cn]) preservedOnFailure.push(cn);
      continue;
    }
    if (existing[cn] == null) {
      merged[cn] = result.level;
      added.push(cn);
    } else if (existing[cn] !== result.level) {
      merged[cn] = result.level;
      overwritten.push({ cardNumber: cn, from: existing[cn], to: result.level });
    }
  }

  return {
    merged,
    stats: {
      priorCount: Object.keys(existing).length,
      mergedCount: Object.keys(merged).length,
      inScope: inScope.size,
      freshCount: fresh.size,
      preservedOutOfScope: preservedOutOfScope.length,
      preservedOnFailure: preservedOnFailure.length,
      added: added.length,
      overwritten: overwritten.length,
      removedByRun: removedByRun.length,
    },
    detail: { preservedOutOfScope, preservedOnFailure, added, overwritten, removedByRun, dropped },
  };
}

/**
 * Coverage-guard decision: given the pre/post counts and the observed fetch
 * outcomes, decide whether the batch is healthy enough to publish. Returns
 * { ok, reasons[] }. Callers exit non-zero when !ok unless overrides opt in.
 */
export function evaluateCoverage({
  priorCount,
  mergedCount,
  inScope,
  freshCount,
  fetchFailures,
  fetchSuccesses,
  allowCoverageDrop = false,
  maxFetchFailureRatio = DEFAULT_MAX_FETCH_FAILURE_RATIO,
  maxCoverageDrop = DEFAULT_MAX_COVERAGE_DROP,
}) {
  const reasons = [];
  // Coverage of the checked-in canonical must never drop unless explicitly allowed.
  const drop = priorCount - mergedCount;
  if (drop > maxCoverageDrop && !allowCoverageDrop) {
    reasons.push(`coverage dropped by ${drop} card(s) (prior=${priorCount}, merged=${mergedCount})`);
  }
  // In-scope fetch failure ratio guard — pass only if we attempted anything.
  if (inScope > 0 && freshCount > 0) {
    const ratio = fetchFailures / freshCount;
    if (ratio > maxFetchFailureRatio) {
      reasons.push(`fetch failure ratio ${(ratio * 100).toFixed(1)}% exceeds threshold ${(maxFetchFailureRatio * 100).toFixed(1)}% (${fetchFailures}/${freshCount})`);
    }
    // A run that touched every target and got zero successes is an origin outage; refuse.
    if (fetchSuccesses === 0 && fetchFailures > 0) {
      reasons.push(`no successful parses out of ${fetchFailures} in-scope fetch attempts`);
    }
  }
  return { ok: reasons.length === 0, reasons };
}

/** Build the payload written to disk. Deterministic key order for a clean diff. */
export function buildPayload(merged) {
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  return {
    lastUpdated: new Date().toISOString(),
    source: 'https://hololive-official-cardgame.com/cardlist/',
    field: 'Bloomレベル',
    totalCards: Object.keys(sorted).length,
    byCardNumber: sorted,
  };
}

/** Write via <file>.tmp then rename — atomic on POSIX, so a crashed run never
 *  leaves half a file at the canonical path. */
export function writeOverlayAtomically(filePath, payload) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, filePath);
}

// ─── CLI: fetch + merge + guard + atomic write ────────────────────────────

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

async function limitedAll(tasks, limit, delayMs) {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try { await tasks[i](); } catch { /* task itself records error */ }
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
    }
  });
  await Promise.all(workers);
}

function parseCliArgs(argv) {
  const rest = argv.slice(2);
  const flags = new Set(rest.filter((a) => !a.startsWith('--only=')));
  const only = rest.find((a) => a.startsWith('--only='))?.split('=')[1] || null;
  return {
    only,
    force: flags.has('--force'),
    allowCoverageDrop: flags.has('--allow-coverage-drop'),
  };
}

async function mainCli() {
  const { only, force, allowCoverageDrop } = parseCliArgs(process.argv);
  const concurrency = Number(process.env.BLOOM_CONCURRENCY || 6);
  const delayMs = Number(process.env.BLOOM_DELAY_MS || 120);

  if (!fs.existsSync(OFFICIAL_DIR)) {
    console.error('[bloom] No data/official directory found');
    process.exit(1);
  }

  let existing;
  try {
    existing = readOverlay(OUT_FILE);
  } catch (err) {
    console.error(`[bloom] Existing overlay is corrupt (${err.message}). Fix or delete data/bloom-levels.json before re-running.`);
    process.exit(1);
  }

  const targets = collectHolomenTargets({ only });
  const inScope = new Set(targets.keys());
  const pending = [];
  for (const [cn, meta] of targets) {
    if (!force && existing[cn]) continue;
    pending.push({ cardNumber: cn, ...meta });
  }
  console.log(`[bloom] scope only=${only ?? '(all)'} force=${force} targets=${targets.size} cached=${Object.keys(existing).length} pending=${pending.length}`);

  const fresh = new Map();
  let done = 0, hits = 0, misses = 0, failures = 0;
  const tasks = pending.map((item) => async () => {
    const url = `https://hololive-official-cardgame.com/cardlist/?id=${item.id}&expansion=${item.expansion}`;
    try {
      const html = await fetchHtml(url);
      const level = parseBloomLevel(html);
      fresh.set(item.cardNumber, { level });
      if (level) hits++; else misses++;
    } catch (err) {
      fresh.set(item.cardNumber, { level: null, error: err.message });
      failures++;
      console.warn(`[bloom] fetch failed ${item.cardNumber}: ${err.message}`);
    } finally {
      done++;
      if (done % 20 === 0) {
        console.log(`[bloom] progress ${done}/${pending.length} (hits=${hits}, misses=${misses}, failures=${failures})`);
      }
    }
  });

  await limitedAll(tasks, concurrency, delayMs);

  const { merged, stats, detail } = mergeResults({ existing, inScope, fresh });
  const guard = evaluateCoverage({
    priorCount: stats.priorCount,
    mergedCount: stats.mergedCount,
    inScope: stats.inScope,
    freshCount: fresh.size,
    fetchFailures: failures,
    fetchSuccesses: hits + misses,
    allowCoverageDrop,
  });

  console.log(`[bloom] merge stats ${JSON.stringify(stats)}`);
  if (detail.overwritten.length) {
    console.log(`[bloom] overwritten ${detail.overwritten.length}: ${JSON.stringify(detail.overwritten.slice(0, 5))}${detail.overwritten.length > 5 ? '…' : ''}`);
  }
  if (detail.preservedOnFailure.length) {
    console.log(`[bloom] preserved-on-failure ${detail.preservedOnFailure.length}: ${detail.preservedOnFailure.slice(0, 5).join(',')}${detail.preservedOnFailure.length > 5 ? '…' : ''}`);
  }

  if (!guard.ok) {
    console.error('[bloom] refusing to write — coverage guard failed:');
    for (const r of guard.reasons) console.error(`  - ${r}`);
    console.error('[bloom] fix the abnormality, or re-run with --allow-coverage-drop if this drop is intentional.');
    process.exit(2);
  }

  writeOverlayAtomically(OUT_FILE, buildPayload(merged));
  console.log(`[bloom] wrote ${OUT_FILE} (total=${stats.mergedCount})`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  mainCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
