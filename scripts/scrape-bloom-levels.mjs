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
// Safety invariants (DIC-1141 CR iterations — this canonical overlay is a
// deployed artifact, so a broken run must never destroy or silently degrade
// it):
//   * `--only=<series>` NEVER removes canonical entries for other series. Only
//     targets in the requested scope are eligible to be overwritten.
//   * A fetch failure or an unrecognised parse for one card NEVER wipes that
//     card's previous canonical value. It stays as it was until the next
//     successful scrape.
//   * The final overlay is written via a temp file + atomic rename, so a crash
//     mid-write can never truncate the checked-in file.
//   * Abnormal batch-level regressions exit non-zero WITHOUT writing:
//       - net coverage drop against the prior overlay,
//       - fetch (network / HTTP) failure ratio above threshold,
//       - all-HTTP-200 with zero valid Bloom parses (schema break),
//       - parse-miss ratio above threshold (partial schema break).
//     `--allow-coverage-drop` opts out of the coverage-drop check for
//     legitimate removals (rare).
//   * The existing overlay reader is strict: missing / non-object
//     `byCardNumber`, invalid keys / levels, or a declared `totalCards` that
//     disagrees with the entry count all throw — the CLI then exits without
//     writing so silent overlay corruption can never be published.
//   * `--only=<series>` also refuses to run if the canonical overlay is
//     absent: without a prior file there is no non-target set to preserve, so
//     the whole point of partial mode collapses.
//
// The scraper is idempotent: existing entries in bloom-levels.json are kept as
// canonical unless `--force` is passed, so re-runs converge without re-hitting
// the origin. `--force` re-fetches every in-scope target. To limit scope, pass
// `--only=hBP04`.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isCanonicalCardNumber, CANONICAL_CARD_NUMBER_RE } from './lib/card-number.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OFFICIAL_DIR = path.join(REPO, 'data', 'official');
const OUT_FILE = path.join(REPO, 'data', 'bloom-levels.json');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

export const VALID_LEVELS = Object.freeze(['Debut', '1st', '2nd', 'Buzz', 'Spot']);
const VALID_LEVEL_SET = new Set(VALID_LEVELS);

// Abnormality thresholds. Conservative — a well-behaved re-scrape trips none.
export const DEFAULT_MAX_FETCH_FAILURE_RATIO = 0.10;  // >10% network / HTTP errors is abnormal
export const DEFAULT_MAX_PARSE_MISS_RATIO = 0.05;     // >5% "HTTP 200 but no Bloomレベル" is abnormal
export const DEFAULT_MAX_COVERAGE_DROP = 0;           // any drop against the prior overlay is abnormal

// ─── Pure helpers (exported for tests) ─────────────────────────────────────

export function parseBloomLevel(html) {
  if (typeof html !== 'string') return null;
  const m = html.match(/<dt>\s*Bloom(?:レベル|Level)\s*<\/dt>\s*<dd>([^<]+)<\/dd>/);
  if (!m) return null;
  const raw = m[1].trim();
  return VALID_LEVEL_SET.has(raw) ? raw : null;
}

/**
 * Strict overlay reader. Returns `{ present: false }` when the file is absent
 * (a virgin scrape); otherwise validates the payload and returns
 * `{ present: true, byCardNumber }` or THROWS. Any anomaly — missing
 * `byCardNumber`, non-object shape, invalid key / level, or a declared
 * `totalCards` that disagrees with the entry count — is a hard error.
 *
 * The previous lenient reader silently dropped invalid entries, which meant a
 * corrupt-then-partial-refresh sequence could delete out-of-scope canonical
 * records without any warning (Codex CR blocker #2).
 */
export function readOverlayStrict(filePath) {
  if (!fs.existsSync(filePath)) return { present: false, byCardNumber: {} };
  const raw = fs.readFileSync(filePath, 'utf8');
  let payload;
  try {
    payload = JSON.parse(raw);
  } catch (err) {
    throw new Error(`overlay JSON parse failed: ${err.message}`);
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('overlay top-level must be a JSON object');
  }
  if (!Object.prototype.hasOwnProperty.call(payload, 'byCardNumber')) {
    throw new Error('overlay missing required key byCardNumber');
  }
  const by = payload.byCardNumber;
  if (!by || typeof by !== 'object' || Array.isArray(by)) {
    throw new Error('overlay byCardNumber must be a non-null object map');
  }
  const validated = {};
  for (const [k, v] of Object.entries(by)) {
    // DIC-1141 CR#3: a non-empty string is not enough — the key must match the
    // canonical card-number format so a payload of 300 `bogus-0`..`bogus-299`
    // cannot silently satisfy the build coverage floor while touching zero
    // real cards.
    if (!isCanonicalCardNumber(k)) {
      throw new Error(`overlay has invalid card-number key ${JSON.stringify(k)} (expected ${CANONICAL_CARD_NUMBER_RE})`);
    }
    if (typeof v !== 'string' || !VALID_LEVEL_SET.has(v)) {
      throw new Error(`overlay entry ${k} has invalid Bloom Level ${JSON.stringify(v)}`);
    }
    validated[k] = v;
  }
  // Declared totalCards must match — a mismatch means someone hand-edited or
  // partially wrote the file and the two views disagree.
  if (Object.prototype.hasOwnProperty.call(payload, 'totalCards')) {
    if (!Number.isInteger(payload.totalCards) || payload.totalCards < 0) {
      throw new Error(`overlay totalCards must be a non-negative integer, got ${JSON.stringify(payload.totalCards)}`);
    }
    if (payload.totalCards !== Object.keys(validated).length) {
      throw new Error(`overlay totalCards ${payload.totalCards} does not match ${Object.keys(validated).length} entries in byCardNumber`);
    }
  }
  return { present: true, byCardNumber: validated };
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
      // DIC-1141 CR#3: same canonical schema as the overlay reader. A garbage
      // cardNumber in the input JSON must not become a canonical Bloom key.
      if (!isCanonicalCardNumber(cn)) continue;
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
 */
export function mergeResults({ existing, inScope, fresh }) {
  const merged = { ...existing };
  const preservedOnFailure = [];   // in-scope, fetch failed or parse null: old value survived
  const preservedOutOfScope = [];  // not in this run's scope: kept as-is
  const added = [];                // in-scope, new value where none existed
  const overwritten = [];          // in-scope, value changed

  for (const cn of Object.keys(existing)) {
    if (!inScope.has(cn)) preservedOutOfScope.push(cn);
  }
  for (const cn of inScope) {
    // DIC-1141 CR#3: even in the merge path, refuse to persist a card number
    // that does not match the canonical schema. Belt-and-braces after strict
    // read + strict collect.
    if (!isCanonicalCardNumber(cn)) continue;
    const result = fresh.get(cn);
    if (!result || result.error || result.level == null || !VALID_LEVEL_SET.has(result.level)) {
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
    },
    detail: { preservedOutOfScope, preservedOnFailure, added, overwritten },
  };
}

/**
 * Coverage-guard decision. Fetch outcomes are split into three categories so
 * a schema-break (all HTTP 200 but zero valid parses) cannot masquerade as
 * success — the previous shape lumped `hits + misses` into a single
 * `fetchSuccesses` count and slipped past the guard (Codex CR blocker #1).
 *
 * Inputs:
 *   - parseHits:     pages that returned a valid Bloom Level
 *   - parseMisses:   pages that fetched OK but had no valid Bloomレベル tag
 *   - fetchFailures: network / HTTP errors
 */
export function evaluateCoverage({
  priorCount,
  mergedCount,
  parseHits,
  parseMisses,
  fetchFailures,
  allowCoverageDrop = false,
  maxFetchFailureRatio = DEFAULT_MAX_FETCH_FAILURE_RATIO,
  maxParseMissRatio = DEFAULT_MAX_PARSE_MISS_RATIO,
  maxCoverageDrop = DEFAULT_MAX_COVERAGE_DROP,
}) {
  const reasons = [];
  const parseAttempts = parseHits + parseMisses;
  const totalAttempts = parseAttempts + fetchFailures;

  // Coverage of the checked-in canonical must never drop unless explicitly allowed.
  const drop = priorCount - mergedCount;
  if (drop > maxCoverageDrop && !allowCoverageDrop) {
    reasons.push(`coverage dropped by ${drop} card(s) (prior=${priorCount}, merged=${mergedCount})`);
  }

  // Schema-break guard: any successful HTTP responses but zero valid parses.
  // This is the "all HTTP 200 but Bloomレベル tag disappeared" case Codex
  // caught — the merger would keep every prior value AND touch lastUpdated,
  // so a broken source would silently stay hidden for weeks.
  if (parseAttempts > 0 && parseHits === 0) {
    reasons.push(
      `zero valid Bloom parses from ${parseAttempts} successful fetch(es) — official page schema likely changed`,
    );
  }

  // High parse-miss ratio: partial schema break. Even if there are some hits,
  // a run where most pages fail to parse is not safe to publish.
  if (parseAttempts > 0) {
    const missRatio = parseMisses / parseAttempts;
    if (missRatio > maxParseMissRatio) {
      reasons.push(
        `parse-miss ratio ${(missRatio * 100).toFixed(1)}% exceeds threshold ${(maxParseMissRatio * 100).toFixed(1)}% (${parseMisses}/${parseAttempts})`,
      );
    }
  }

  // Network failure guard.
  if (totalAttempts > 0) {
    const failRatio = fetchFailures / totalAttempts;
    if (failRatio > maxFetchFailureRatio) {
      reasons.push(
        `fetch failure ratio ${(failRatio * 100).toFixed(1)}% exceeds threshold ${(maxFetchFailureRatio * 100).toFixed(1)}% (${fetchFailures}/${totalAttempts})`,
      );
    }
    if (fetchFailures > 0 && parseAttempts === 0) {
      reasons.push(`origin outage: ${fetchFailures} attempt(s) all failed with no successful responses`);
    }
  }

  return { ok: reasons.length === 0, reasons };
}

/** Build the payload written to disk. Deterministic key order for a clean diff. */
export function buildPayload(merged, now = new Date()) {
  const sorted = Object.fromEntries(Object.keys(merged).sort().map((k) => [k, merged[k]]));
  return {
    lastUpdated: now.toISOString(),
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

/**
 * Testable orchestrator: given the fully collected in-run data, decide whether
 * to publish. Returns `{ shouldWrite: false, reasons: [...] }` on any failure
 * mode (bad existing overlay, partial-mode without canonical, coverage guard
 * fails). The CLI ONLY calls `writeOverlayAtomically` when `shouldWrite ===
 * true`, and the tests exercise this to prove the writer is never invoked on
 * an abnormal batch (Codex CR blocker #1 / #2).
 */
export function decidePublication({
  only,
  existingOverlay,      // { present, byCardNumber }
  inScope,              // Set<cardNumber>
  fresh,                // Map<cardNumber, {level|null, error?}>
  parseHits,
  parseMisses,
  fetchFailures,
  allowCoverageDrop,
  maxParseMissRatio,
  maxFetchFailureRatio,
  maxCoverageDrop,
  now = new Date(),
}) {
  // Partial mode without a canonical overlay cannot prove out-of-scope
  // preservation, so refuse rather than write a scope-limited file.
  if (only && !existingOverlay.present) {
    return {
      shouldWrite: false,
      reasons: [`--only=${only} requires an existing canonical overlay to preserve out-of-scope entries; none found`],
    };
  }
  const { merged, stats, detail } = mergeResults({
    existing: existingOverlay.byCardNumber,
    inScope,
    fresh,
  });
  const guard = evaluateCoverage({
    priorCount: stats.priorCount,
    mergedCount: stats.mergedCount,
    parseHits,
    parseMisses,
    fetchFailures,
    allowCoverageDrop,
    maxParseMissRatio,
    maxFetchFailureRatio,
    maxCoverageDrop,
  });
  if (!guard.ok) {
    return { shouldWrite: false, reasons: guard.reasons, stats, detail };
  }
  return {
    shouldWrite: true,
    reasons: [],
    stats,
    detail,
    payload: buildPayload(merged, now),
  };
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

  // Strict read: any anomaly → refuse to write, so a corrupt overlay cannot
  // silently be re-serialised with entries dropped.
  let existingOverlay;
  try {
    existingOverlay = readOverlayStrict(OUT_FILE);
  } catch (err) {
    console.error(`[bloom] Existing overlay is invalid (${err.message}). Fix or delete ${OUT_FILE} before re-running. Aborting WITHOUT writing.`);
    process.exit(1);
  }

  const targets = collectHolomenTargets({ only });
  const inScope = new Set(targets.keys());
  const pending = [];
  for (const [cn, meta] of targets) {
    if (!force && existingOverlay.byCardNumber[cn]) continue;
    pending.push({ cardNumber: cn, ...meta });
  }
  console.log(`[bloom] scope only=${only ?? '(all)'} force=${force} targets=${targets.size} cached=${Object.keys(existingOverlay.byCardNumber).length} pending=${pending.length}`);

  const fresh = new Map();
  let done = 0, parseHits = 0, parseMisses = 0, fetchFailures = 0;
  const tasks = pending.map((item) => async () => {
    const url = `https://hololive-official-cardgame.com/cardlist/?id=${item.id}&expansion=${item.expansion}`;
    try {
      const html = await fetchHtml(url);
      const level = parseBloomLevel(html);
      fresh.set(item.cardNumber, { level });
      if (level) parseHits++; else parseMisses++;
    } catch (err) {
      fresh.set(item.cardNumber, { level: null, error: err.message });
      fetchFailures++;
      console.warn(`[bloom] fetch failed ${item.cardNumber}: ${err.message}`);
    } finally {
      done++;
      if (done % 20 === 0) {
        console.log(`[bloom] progress ${done}/${pending.length} (parseHits=${parseHits}, parseMisses=${parseMisses}, fetchFailures=${fetchFailures})`);
      }
    }
  });

  await limitedAll(tasks, concurrency, delayMs);

  const decision = decidePublication({
    only,
    existingOverlay,
    inScope,
    fresh,
    parseHits,
    parseMisses,
    fetchFailures,
    allowCoverageDrop,
  });

  if (decision.stats) console.log(`[bloom] merge stats ${JSON.stringify(decision.stats)}`);
  if (decision.detail?.overwritten?.length) {
    console.log(`[bloom] overwritten ${decision.detail.overwritten.length}: ${JSON.stringify(decision.detail.overwritten.slice(0, 5))}${decision.detail.overwritten.length > 5 ? '…' : ''}`);
  }
  if (decision.detail?.preservedOnFailure?.length) {
    console.log(`[bloom] preserved-on-failure ${decision.detail.preservedOnFailure.length}: ${decision.detail.preservedOnFailure.slice(0, 5).join(',')}${decision.detail.preservedOnFailure.length > 5 ? '…' : ''}`);
  }

  if (!decision.shouldWrite) {
    console.error('[bloom] refusing to write — abnormal batch:');
    for (const r of decision.reasons) console.error(`  - ${r}`);
    console.error('[bloom] fix the abnormality (or re-run with --allow-coverage-drop if the drop is intentional).');
    process.exit(2);
  }

  writeOverlayAtomically(OUT_FILE, decision.payload);
  console.log(`[bloom] wrote ${OUT_FILE} (total=${decision.stats.mergedCount})`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  mainCli().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
