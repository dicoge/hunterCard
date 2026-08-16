#!/usr/bin/env node
/**
 * DIC-979 monthly tournament-report collector (+ DIC-1024 live Deck Log import).
 *
 * Reads human-verified source records under data/tournaments/sources/*.json
 * (each tagged with the month it covers) and produces per-month normalized
 * reports plus an index, written to both data/tournaments/ and
 * public/data/tournaments/ (the app fetches from /data/... i.e. public/).
 *
 * Design goals:
 *   • Incremental & idempotent: re-runs merge with last-known-good, never
 *     duplicate events/decks (dedupe by eventId / deckId in the shared core).
 *   • Change detection: only rewrites a month when its stable content changed,
 *     so a scheduled run that finds nothing new is a no-op (no churn commit).
 *   • Silent preservation + explicit alert: a source that fails to read/parse
 *     does NOT clobber the existing good report for its month; the failure is
 *     collected into an alert report printed at the end (and to
 *     data/tournaments/collector-alerts.json).
 *   • Honest by construction: all normalization goes through the shared pure
 *     core (src/utils/tournamentReport.ts) which preserves unknowns.
 *   • Strict on every run (DIC-1029): committed card arrays are revalidated
 *     against 1/50/20 totals, duplicate zone slots and catalog membership on
 *     every offline AND live run — being already committed is not evidence.
 *     Data that fails is reported, marked unverified, and never overwrites a
 *     report already on disk.
 *
 * Live mode (--live, DIC-1024): only source files that opt in with
 * `"liveDecklog": true` are fetched. For each of their decks that has a
 * decklogCode and either no committed cards yet or a committed list that fails
 * revalidation, the collector:
 *   1. POSTs the public Deck Log view API (/system/app/api/view/{code}) with
 *      same-origin headers, one request per deck, sequential, ≥500ms apart,
 *      bounded retries with backoff (no auth, no CAPTCHA, no pagination — the
 *      response is a single JSON body). The exact endpoint was verified against
 *      live public decks (game_title_id 9 = hOCG).
 *   2. Maps the three Deck Log lists to zones (p_list→oshi, list→main,
 *      sub_list→yell) with the shared pure core, then validates 1/50/20 totals,
 *      no duplicate slots within a zone, and every cardNumber against the local
 *      official catalog (data/database.json). Only the normalized
 *      {zone, cardNumber, version, count} fields survive — Deck Log's raw
 *      response fields and official images are never stored or republished.
 *   3. On verification failure: the single failing slot is reported, cards stay
 *      unverified (cardsVerified:false) — never guessed.
 *   4. Persists the fetched, validated cards back into the committed source
 *      file (the last-known-good store), so a later OFFLINE run is
 *      byte-identical (no churn, deterministic).
 * Freshness discovery (--live): checks the official WordPress news feed
 * (post_news, category 16 = イチ推し！デッキ紹介) and confirms each committed
 * result tweet still resolves via fxtwitter. A strictly newer official
 * publication is an ALERT, never an auto-collect; when discovery is
 * unavailable the last-known-good data is preserved.
 *
 *  Run:
 *   # offline (deterministic, from committed sources — CI/manual default):
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/collect-tournament-reports.mjs [--dry-run] [--now <iso>]
 *   # live (fetch Deck Log card data + freshness discovery):
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/collect-tournament-reports.mjs --live [--skip-discovery] [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeEvent,
  normalizeCards,
  mergeMonthlyReport,
  reportContentKey,
  cardsFromDecklog,
  verifyDeckCards,
  classifyFreshness,
  HOCG_DECKLOG_GAME_TITLE_ID,
} from '../src/utils/tournamentReport.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const LIVE = args.includes('--live');
// Skip the external freshness probes (official news feed + tweet liveness) in
// --live mode. Used in sandboxed CI / offline runners where those hosts are
// unreachable; Deck Log collection itself still runs.
const SKIP_DISCOVERY = args.includes('--skip-discovery');
const nowFlagIdx = args.indexOf('--now');
const NOW = nowFlagIdx >= 0 ? args[nowFlagIdx + 1] : new Date().toISOString();

// --sources-dir / --out-dir keep the collector runnable against a throwaway
// fixture tree, so the failure branches can be regression-tested for real
// without touching the committed data.
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}

const SOURCES_DIR = flagValue('--sources-dir')
  ? path.resolve(flagValue('--sources-dir'))
  : path.join(ROOT, 'data', 'tournaments', 'sources');
const OUT_DIRS = flagValue('--out-dir')
  ? [path.resolve(flagValue('--out-dir'))]
  : [
      path.join(ROOT, 'data', 'tournaments'),
      path.join(ROOT, 'public', 'data', 'tournaments'),
    ];
// First out dir is canonical: it is the one read back for last-known-good and
// change detection.
const CANONICAL_DIR = OUT_DIRS[0];

const alerts = [];
function alert(level, message, extra = {}) {
  alerts.push({ level, message, ...extra });
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : 'ℹ️ ';
  console.error(`${tag} ${message}`);
}

// Bounded-retry helper shared by the live paths. Retries with backoff, never
// bypasses auth/CAPTCHA/rate limits — it simply re-issues the SAME public
// request a browser would make, with a small delay between attempts.
export async function fetchWithRetry(url, { retries = 3, backoffMs = 800 } = {}) {
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.text();
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }
  throw lastErr;
}

// JSON POST variant used by the Deck Log view API. The endpoint requires the
// same-origin headers a browser would send (Origin/Referer/X-Requested-With)
// and returns a single JSON body. One request per deck, sequential.
export async function fetchDecklogView(code, { retries = 3, backoffMs = 800 } = {}) {
  const url = `https://decklog.bushiroad.com/system/app/api/view/${encodeURIComponent(code)}`;
  const headers = {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
    Accept: 'application/json, text/plain, */*',
    'Content-Type': 'application/x-www-form-urlencoded',
    Origin: 'https://decklog.bushiroad.com',
    Referer: `https://decklog.bushiroad.com/view/${encodeURIComponent(code)}`,
    'X-Requested-With': 'XMLHttpRequest',
  };
  let lastErr;
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers,
        signal: AbortSignal.timeout(15000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        throw new Error(`unexpected Deck Log response shape for ${code}`);
      }
      return data;
    } catch (err) {
      lastErr = err;
      if (attempt < retries) {
        await new Promise((r) => setTimeout(r, backoffMs * attempt));
      }
    }
  }
  throw lastErr;
}

function readJsonSafe(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function loadExistingReport(month) {
  const file = path.join(CANONICAL_DIR, `${month}.json`);
  if (!fs.existsSync(file)) return null;
  const r = readJsonSafe(file);
  return r.ok ? r.data : null;
}

// Months that already have a good report on disk. Used to keep the index
// pointing at last-known-good data even when this run's source for that month
// failed — dropping the entry would hide an existing report from the UI.
function existingMonthsOnDisk() {
  if (!fs.existsSync(CANONICAL_DIR)) return [];
  return fs
    .readdirSync(CANONICAL_DIR)
    .filter((f) => /^\d{4}-\d{2}\.json$/.test(f))
    .map((f) => f.slice(0, -'.json'.length))
    .sort();
}

function writeJson(fileName, obj) {
  const json = JSON.stringify(obj, null, 2) + '\n';
  for (const dir of OUT_DIRS) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), json);
  }
}

// Write only when the stable portion changed, preserving the prior generatedAt
// so an unchanged scheduled run produces no diff (no churn commit).
function writeStable(fileName, obj, stableFn) {
  const canonical = path.join(CANONICAL_DIR, fileName);
  let toWrite = obj;
  let changed = true;
  if (fs.existsSync(canonical)) {
    const prev = readJsonSafe(canonical);
    if (prev.ok && stableFn(prev.data) === stableFn(obj)) {
      changed = false;
      toWrite = { ...obj, generatedAt: prev.data.generatedAt };
    }
  }
  if (changed && !DRY_RUN) writeJson(fileName, toWrite);
  return changed;
}

// ── Live Deck Log import (DIC-1024) ──────────────────────────────────────────
// Load the local official card catalog once; only card NUMBERS are kept, so the
// verification is exact identity, never name or price fallback.
function loadCatalogCardNumbers() {
  const dbFile = path.join(ROOT, 'data', 'database.json');
  const r = readJsonSafe(dbFile);
  if (!r.ok) throw new Error(`cannot read local card catalog: ${r.error.message}`);
  const cards = r.data?.cards;
  if (!cards || typeof cards !== 'object') {
    throw new Error('local card catalog has no cards map');
  }
  return new Set(Object.values(cards).map((c) => String(c.cardNumber ?? '').trim()));
}

// Catalog for the whole run. An unreadable catalog is an alert, not a crash:
// with no catalog nothing can pass verification, so every card list is marked
// unverified and the preserve rule below keeps the last valid report on disk.
function loadCatalogOrAlert() {
  try {
    return loadCatalogCardNumbers();
  } catch (err) {
    alert('error', `${err.message}; no deck can be verified this run.`);
    return null;
  }
}

// Strict revalidation of a committed (last-known-good) card array. Committed
// data is an input like any other: it is re-checked against 1/50/20 totals,
// duplicate zone slots and catalog membership on EVERY run (DIC-1029).
function revalidateCommittedCards(cards, catalogNumbers) {
  try {
    const { failure } = normalizeCards(cards, catalogNumbers);
    return { ok: failure === null, failure };
  } catch (err) {
    return { ok: false, failure: err.message };
  }
}

function listSourceFiles() {
  if (!fs.existsSync(SOURCES_DIR)) return [];
  return fs
    .readdirSync(SOURCES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort();
}

// Fetch + validate + persist card data for every opt-in deck that has a
// decklogCode and no card list that currently passes verification. Writes back
// into the source files (the last-known-good store) when data changed.
async function liveCollectDecklogCards(catalogNumbers) {
  const files = listSourceFiles();
  let changedAny = false;
  for (const file of files) {
    const full = path.join(SOURCES_DIR, file);
    const r = readJsonSafe(full);
    if (!r.ok) continue;
    const src = r.data;
    if (src.liveDecklog !== true) continue; // only opt-in sources are fetched
    if (!Array.isArray(src.events)) continue;

    let fileChanged = false;
    for (const evt of src.events) {
      for (const deck of evt.decks ?? []) {
        if (!deck?.decklogCode || !Array.isArray(deck.cards)) continue;
        const code = deck.decklogCode;
        if (deck.cards.length > 0) {
          // Committed cards are trusted only while they still pass the strict
          // gate. Valid → skip (no request, no churn). Invalid → report it and
          // re-fetch, so a corrupted last-known-good list is repaired from the
          // source instead of being republished as verified.
          const { ok, failure } = revalidateCommittedCards(deck.cards, catalogNumbers);
          if (ok) continue;
          alert(
            'error',
            `Committed cards for ${code} failed revalidation: ${failure}; re-fetching.`,
            { file, decklogCode: code, failure },
          );
        }
        let fetched;
        try {
          fetched = await fetchDecklogView(code);
        } catch (err) {
          alert(
            'error',
            `Deck Log fetch failed for ${code}: ${err.message}`,
            { file, decklogCode: code },
          );
          continue;
        }
        if (fetched.game_title_id !== HOCG_DECKLOG_GAME_TITLE_ID) {
          alert(
            'error',
            `Deck Log ${code} is not an hOCG deck (game_title_id=${fetched.game_title_id})`,
            { file, decklogCode: code },
          );
          continue;
        }
        try {
          const cards = cardsFromDecklog(fetched);
          const { cardsVerified, totals, failure } = verifyDeckCards(cards, catalogNumbers);
          if (!cardsVerified) {
            // Fail validation, report the single slot, and do NOT persist the
            // cards: the deck stays unverified and a later run retries instead
            // of trusting a half-parsed list.
            alert(
              'error',
              `Deck Log ${code} failed validation: ${failure}`,
              { file, decklogCode: code, failure },
            );
            continue;
          }
          deck.cards = cards;
          deck.cardsVerified = true;
          deck.fetchedAt = new Date().toISOString();
          alert(
            'info',
            `Deck Log ${code}: verified ${totals.oshi}/${totals.main}/${totals.yell}`,
            { file, decklogCode: code },
          );
          fileChanged = true;
        } catch (err) {
          alert(
            'error',
            `Deck Log ${code} could not be parsed: ${err.message}`,
            { file, decklogCode: code },
          );
        }
        // Sequential, polite rate limiting: ≥500ms between Deck Log requests.
        await new Promise((r) => setTimeout(r, 500));
      }
    }
    if (fileChanged && !DRY_RUN) {
      fs.writeFileSync(full, JSON.stringify(src, null, 2) + '\n');
      changedAny = true;
    }
  }
  return changedAny;
}

// Freshness discovery (issue requirement 6). Newest official publication found
// vs newest committed source publication; an unavailable source just warns and
// preserves last-known-good.
async function discoverFreshness() {
  const knownDates = listSourceFiles()
    .map((f) => readJsonSafe(path.join(SOURCES_DIR, f)))
    .filter((r) => r.ok && r.data?.publishedDate)
    .map((r) => String(r.data.publishedDate).trim())
    .sort();
  const knownNewest = knownDates[knownDates.length - 1] ?? null;

  // 1) Official WordPress news feed: category 16 = イチ推し！デッキ紹介 column.
  try {
    const body = await fetchWithRetry(
      'https://hololive-official-cardgame.com/wp-json/wp/v2/post_news' +
        '?cat_news=16&per_page=10&_fields=date,link,title',
    );
    const posts = JSON.parse(body);
    const newest = Array.isArray(posts)
      ? posts.map((p) => String(p.date ?? '').trim()).filter(Boolean).sort().pop() ?? null
      : null;
    const verdict = classifyFreshness(newest, knownNewest);
    if (verdict === 'newer') {
      alert(
        'warn',
        `A newer official deck-showcase column was published (${newest}); it has not ` +
          'been parsed yet — last-known-good is preserved.',
        { discovered: newest, known: knownNewest },
      );
    } else {
      alert('info', `Official column freshness: ${verdict} (newest ${newest ?? 'n/a'})`, {
        discovered: newest,
        known: knownNewest,
      });
    }
  } catch (err) {
    alert('warn', `Official news feed unreachable (${err.message}); last-known-good preserved.`);
  }

  // 2) Result-tweet liveness via fxtwitter (source-discovery only).
  const tweetCodes = [];
  for (const f of listSourceFiles()) {
    const r = readJsonSafe(path.join(SOURCES_DIR, f));
    if (!r.ok) continue;
    for (const t of r.data?.resultTweets ?? []) {
      if (t?.code) tweetCodes.push({ file: f, code: String(t.code) });
    }
  }
  for (const { file, code } of tweetCodes) {
    try {
      const body = await fetchWithRetry(`https://api.fxtwitter.com/status/${code}`);
      const j = JSON.parse(body);
      const ok = j?.code === 200 && j?.tweet?.id;
      if (ok) {
        alert('info', `Result tweet ${code} resolves (${j.tweet.date ?? 'date unknown'})`, { file });
      } else {
        alert('warn', `Result tweet ${code} no longer resolves; last-known-good preserved.`, {
          file,
          code,
        });
      }
    } catch (err) {
      alert('warn', `Result tweet ${code} check failed (${err.message}); last-known-good preserved.`, {
        file,
        code,
      });
    }
    await new Promise((r) => setTimeout(r, 400));
  }
}

function main() {
  mainAsync().catch((err) => {
    alert('error', err.message);
    finish(1);
  });
}

async function mainAsync() {
  // Loaded in BOTH modes: offline runs revalidate committed card arrays against
  // it just as live runs do.
  const catalogNumbers = loadCatalogOrAlert();

  if (LIVE) {
    if (!fs.existsSync(SOURCES_DIR)) {
      alert('error', `No sources directory at ${path.relative(ROOT, SOURCES_DIR)}`);
      finish(1);
      return;
    }
    if (!SKIP_DISCOVERY) await discoverFreshness();
    await liveCollectDecklogCards(catalogNumbers);
  }

  if (!fs.existsSync(SOURCES_DIR)) {
    alert('error', `No sources directory at ${path.relative(ROOT, SOURCES_DIR)}`);
    finish(1);
    return;
  }

  const sourceFiles = listSourceFiles();

  if (sourceFiles.length === 0) {
    alert('warn', 'No source files found; nothing to collect.');
  }

  // Group verified source events by their declared month. A per-file failure is
  // recorded as an alert and skipped — it must not drop other files' data.
  const byMonth = new Map(); // month -> { events: TournamentEvent[], source }
  // Months whose source carries a card list that failed strict revalidation.
  // Their existing report must not be overwritten with the degraded data.
  const invalidMonths = new Set();
  for (const file of sourceFiles) {
    const full = path.join(SOURCES_DIR, file);
    const r = readJsonSafe(full);
    if (!r.ok) {
      alert('error', `Failed to parse source ${file}: ${r.error.message}`, {
        file,
      });
      continue;
    }
    const src = r.data;
    if (!src.month || !Array.isArray(src.events)) {
      alert('error', `Source ${file} missing "month" or "events[]"; skipped.`, {
        file,
      });
      continue;
    }
    const bucket = byMonth.get(src.month) ?? { events: [], source: src.source };
    for (const rawEvent of src.events) {
      try {
        const event = normalizeEvent(rawEvent, NOW, catalogNumbers);
        // A deck that ships cards but does not come out verified means the
        // committed array failed the strict gate. Name the exact slot and mark
        // the month so the degraded data cannot replace a valid report.
        for (const deck of event.decks) {
          if (deck.cards.length === 0 || deck.cardsVerified) continue;
          const { failure } = revalidateCommittedCards(deck.cards, catalogNumbers);
          alert(
            'error',
            `Committed cards for ${deck.deckId} in ${file} failed revalidation: ${failure}`,
            { file, month: src.month, deckId: deck.deckId, failure },
          );
          invalidMonths.add(src.month);
        }
        bucket.events.push(event);
      } catch (err) {
        alert('error', `Bad event in ${file}: ${err.message}`, { file });
      }
    }
    if (src.source) bucket.source = src.source;
    byMonth.set(src.month, bucket);
  }

  const summary = [];
  const months = [...byMonth.keys()].sort();

  for (const month of months) {
    const { events, source } = byMonth.get(month);
    const existing = loadExistingReport(month);

    // Invalid committed data never overwrites a report that is already on disk:
    // the last genuinely valid generated output is kept byte-identical and the
    // run exits non-zero. With no prior report there is nothing to preserve, so
    // the month is still written — with the offending decks marked unverified.
    if (invalidMonths.has(month) && existing) {
      summary.push({
        month,
        events: existing.events?.length ?? 0,
        observedDecks: existing.observedSampleSize ?? 0,
        changed: false,
        preserved: true,
      });
      alert('warn', `Invalid committed card data for ${month}; preserving last-known-good report.`, {
        month,
      });
      continue;
    }

    // Merge with last-known-good so a partial re-run never drops prior events.
    const merged = mergeMonthlyReport(existing, events, {
      month,
      generatedAt: NOW,
      source,
    });

    const changed =
      !existing || reportContentKey(existing) !== reportContentKey(merged);

    // Preserve the prior generatedAt when nothing changed → stable, no churn.
    const report =
      changed || !existing
        ? merged
        : { ...merged, generatedAt: existing.generatedAt };

    summary.push({
      month,
      events: report.events.length,
      observedDecks: report.observedSampleSize,
      changed,
    });

    if (changed && !DRY_RUN) {
      writeJson(`${month}.json`, report);
    }
  }

  // Rebuild the month index from the (post-merge) reports on disk / in memory.
  // A month whose only source failed this run has no entry in `summary`, but its
  // last-known-good report is still on disk — carry it into the index from disk
  // so the failure never hides an existing report from the UI.
  const collected = new Set(summary.map((s) => s.month));
  for (const month of existingMonthsOnDisk()) {
    if (collected.has(month)) continue;
    const prev = loadExistingReport(month);
    if (!prev) continue;
    summary.push({
      month,
      events: prev.events?.length ?? 0,
      observedDecks: prev.observedSampleSize ?? 0,
      changed: false,
      preserved: true,
    });
    alert('warn', `No usable source for ${month}; preserving last-known-good report.`, {
      month,
    });
  }
  summary.sort((a, b) => a.month.localeCompare(b.month));

  const indexMonths = summary
    .map((s) => ({
      month: s.month,
      events: s.events,
      observedDecks: s.observedDecks,
    }))
    .sort((a, b) => b.month.localeCompare(a.month));
  const index = {
    schemaVersion: 1,
    generatedAt: NOW,
    months: indexMonths,
  };
  writeStable('index.json', index, (o) => JSON.stringify(o.months));

  // ── Report ────────────────────────────────────────────────────────────────
  console.log('\n=== Tournament report collection ===');
  console.log(`mode: ${LIVE ? 'LIVE (Deck Log fetch on)' : 'offline'}${
    DRY_RUN ? ' · DRY-RUN (no files written)' : ''
  }`);
  console.log(`sources: ${sourceFiles.length} file(s)`);
  for (const s of summary) {
    console.log(
      `  ${s.month}: ${s.events} event(s), ${s.observedDecks} observed deck(s)` +
        `${s.preserved ? '  [preserved]' : s.changed ? '  [changed]' : '  [unchanged]'}`,
    );
  }
  console.log(`alerts: ${alerts.length}`);

  writeStable(
    'collector-alerts.json',
    { generatedAt: NOW, alerts },
    (o) => JSON.stringify(o.alerts),
  );

  // A source failure preserves last-known-good (above) but still surfaces as a
  // non-zero exit so a scheduler treats it as an incident, not a clean run.
  const hasError = alerts.some((a) => a.level === 'error');
  finish(hasError ? 1 : 0);
}

function finish(code) {
  if (alerts.length > 0) {
    console.log('\n--- alert detail ---');
    console.log(JSON.stringify(alerts, null, 2));
  }
  process.exit(code);
}

main();
