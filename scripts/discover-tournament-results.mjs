#!/usr/bin/env node
/**
 * DIC-1232 — Sustainable official-X tournament-result discovery + diff + run log.
 *
 * Prior to this, "discovery" meant a human hand-authoring a source JSON for each
 * month. This script turns the official X result feed into a durable,
 * idempotent discovery/diff so new tournaments surface without manual source
 * JSON creation, and repeats never re-add what is already known.
 *
 * What it does each run:
 *   1. Scans the official discovery feed for candidate result records
 *      (WGP finals, Extreamer Cup area-qualifier block announcements, ...). The
 *      feed is a pluggable catalyst: a manifest of official X status codes
 *      (probe frontier) plus the official WordPress news feed. Every candidate
 *      is normalized into a DiscoveryRecord keyed by its stable identity
 *      (eventId + block), independent of how it was discovered.
 *   2. Diffs candidates against the committed known registry
 *      (data/tournaments/discovery/known-results.json) so:
 *        • discovered = total candidates seen this run
 *        • known      = candidates already in the registry (idempotent repeat)
 *        • new        = candidates not yet known → appended to the "new" queue
 *      Aggregating blocks (A/B/C/D of the same event) into one event is the
 *      collector's job; here blocks are distinct discovery records that share
 *      an eventId so they are naturally de-duplicated downstream.
 *   3. Writes the run log (data/tournaments/discovery/run-log.jsonl) and a
 *      diff snapshot. If per-record verification is impossible the record is
 *      still kept but flagged unverified — an event never vanishes, data is
 *      never guessed (source-failure preserves last-known-good).
 *   4. The scheduler manifest (data/tournaments/discovery/schedule.json) records
 *      the next run so operators can see "next run" without parsing crons.
 *
 * Exit semantics (req 4): exit 0 means the run completed; it still reports
 * discovered/known/new/failed counts in machine-readable form on stdout and in
 * the diff snapshot. Any source-level failure surfaces as an alert and, for a
 * probe that already has a verified record, preserves that record instead of
 * clobbering it with degraded data. Presence of new records is NOT an error —
 * it is the signal that invites backfill.
 *
 * Discovery data is a staging/diff layer, NOT a publication: it never writes
 * months, deck lists or the UI-facing index. It only maintains the known/new
 * registry + run log that feed backfill and the collector.
 *
 * Run:
 *   node --experimental-strip-types --import ./scripts/register-ts.mjs \
 *     scripts/discover-tournament-results.mjs [--dry-run] [--now <iso>] \
 *       [--fixture <path-to-feed-json>] [--registry-dir <dir>]
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const nowIdx = args.indexOf('--now');
const NOW = nowIdx >= 0 ? args[nowIdx + 1] : new Date().toISOString();
function flagValue(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
}
const FIXTURE = flagValue('--fixture');
const REGISTRY_DIR = flagValue('--registry-dir')
  ? path.resolve(flagValue('--registry-dir'))
  : path.join(ROOT, 'data', 'tournaments', 'discovery');

// ── Scheduler manifest ───────────────────────────────────────────────────────
// Where/how often the discovery job is meant to run. Kept here AND mirrored in
// .github/workflows + vercel.json crons; this file is the human/script-readable
// answer to "when is the next run?".
export const SCHEDULE = {
  cron: '0 */6 * * *', // every 6 hours (UTC): tournaments are announced and
  // results posted throughout the day; a 6h cadence keeps latency low without
  // hammering the feed.
  timezone: 'UTC',
  note: '官方 X 賽果與官方 news feed 的例行探測；結果寫入 known-results registry 與 run-log，不直接改動月報。',
};

// Registry files inside REGISTRY_DIR:
const KNOWN_FILE = 'known-results.json';
const NEW_FILE = 'new-results.json';
const DIFF_FILE = 'last-diff.json';
const LOG_FILE = 'run-log.jsonl';
const SCHED_FILE = 'schedule.json';

const PATH_TO_NEXT_MINUTES = 5;

function readJsonSafe(file) {
  try {
    return { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) };
  } catch (err) {
    return { ok: false, error: err };
  }
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// Normalized discovery record. `eventId` aggregates blocks (A/B/C/D) of the same
// tournament; `tweetCode`/`sourceUrl` give the verifiable official citation.
function normalizeRecord(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const date = raw.date?.trim?.() || null;
  const name = raw.name?.trim?.() || null;
  if (!name) return null;
  const eventId =
    raw.eventId?.trim?.() ||
    `${String(name).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-')}${
      date ? `_${date}` : ''
    }`;
  const region = raw.region?.trim?.() || null;
  const block = raw.block?.trim?.() || null;
  const tweetCode = String(raw.tweetCode ?? raw.code ?? '').trim() || null;
  return {
    eventId,
    name,
    nameZh: raw.nameZh?.trim?.() || null,
    date,
    region,
    block,
    // SourceType tells the collector which normalized event shape to expect.
    sourceType: raw.sourceType || 'official-x-result',
    tweetCode,
    sourceUrl: (raw.sourceUrl?.trim?.() ||
      (tweetCode
        ? `https://x.com/hololive_OCG/status/${tweetCode}`
        : null)) || null,
    media: Array.isArray(raw.media) ? raw.media.map((m) => String(m).trim()).filter(Boolean) : [],
    verified: raw.verified !== false,
    resolves: raw.resolves === true,
    blocks: Array.isArray(raw.blocks) ? raw.blocks.map(String) : [],
  };
}

// Initial (empty) registry shapes.
function emptyRegistry() {
  return { schemaVersion: 1, updatedAt: null, records: [] };
}
function emptyNewQueue() {
  return { schemaVersion: 1, updatedAt: null, records: [] };
}

function loadRegistry() {
  const known = readJsonSafe(path.join(REGISTRY_DIR, KNOWN_FILE));
  const newQ = readJsonSafe(path.join(REGISTRY_DIR, NEW_FILE));
  return {
    known: known.ok ? known.data : emptyRegistry(),
    new: newQ.ok ? newQ.data : emptyNewQueue(),
  };
}

// Identity key: eventId#block#tweetCode#sourceUrl — stable enough to survive a
// re-run without re-adding.
function recordKey(r) {
  return [r.eventId, r.block ?? '', r.tweetCode ?? '', r.sourceUrl ?? ''].join('#');
}

function upsert(list, rec) {
  const key = recordKey(rec);
  const idx = list.findIndex((x) => recordKey(x) === key);
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...rec };
    return false;
  }
  list.push(rec);
  return true;
}

// ── Discovery feed ───────────────────────────────────────────────────────────
// The feed returns raw candidate records. Production uses two catalysts:
//   1) the probe frontier (manifest of official X status codes), fetched via the
//      public fxtwitter endpoint; and
//   2) the official WordPress news feed.
// Network failures on a catalyst are alerts, never crashes: last-known-good is
// preserved and the environment reports how far discovery got.
async function fetchCandidateRecords() {
  const out = [];

  // 1) Probe frontier — the committed watch-route manifest. Each entry carries a
  // verifiable, curated event identity (eventId/name/region/blocks/date) keyed by
  // its official result tweet code. We do NOT regex-guess identity from tweet
  // text (that produced wrong regions); the manifest is the verifiable source
  // and the live fetch only confirms the tweet still resolves and enriches the
  // date/media. Growth is organic: a new tournament's announcement code is added
  // to the frontier when seen.
  let manifest = [];
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(REGISTRY_DIR, 'probe-frontier.json'), 'utf8'),
    )?.records ?? [];
  } catch (err) {
    alert('error', `Cannot read probe frontier: ${err.message}`);
    return [];
  }
  if (!Array.isArray(manifest)) manifest = [];

  for (const entry of manifest) {
    const code = String(entry?.code ?? '').trim();
    if (!code) continue;
    const rec = {
      eventId: (entry.eventId ?? '').trim(),
      name: (entry.name ?? '').trim(),
      nameZh: (entry.nameZh ?? (entry.name ?? '')).trim(),
      date: (entry.date ?? '').trim() || null,
      region: (entry.region ?? '').trim() || null,
      block: (entry.block ?? (Array.isArray(entry.blocks) ? entry.blocks[0] : null)) ?? null,
      blocks: Array.isArray(entry.blocks) ? entry.blocks : [],
      sourceType: entry.sourceType || 'official-x-result',
      tweetCode: code,
      sourceUrl: `https://x.com/hololive_OCG/status/${code}`,
      verified: entry.verified === true,
    };
    // Live confirmation + date/media enrichment only — identity never guessed.
    try {
      const body = await fetchWithTimeout(
        `https://api.fxtwitter.com/status/${encodeURIComponent(code)}`,
        15000,
      );
      const j = JSON.parse(body);
      const t = j?.tweet;
      if (t?.created_at) {
        const parsed = new Date(t.created_at);
        if (!Number.isNaN(parsed.getTime())) rec.date = parsed.toISOString().slice(0, 10);
      }
      rec.media = (t?.media?.all ?? [])
        .map((m) => m?.url || String(m))
        .filter(Boolean)
        .slice(0, 4);
      rec.resolves = true;
    } catch (err) {
      alert('warn', `Probe ${code} failed (${err.message}); last-known-good preserved.`, {
        tweetCode: code,
      });
      rec.resolves = false;
    }
    out.push(rec);
    await sleep(300);
  }

  // 2) Official WordPress news feed (category 16 = イチ推し！デッキ紹介). Not a
  // tournament-result source; surfaced as an informational alert only so a newer
  // showcase column can be noticed without polluting the new-results queue.
  try {
    const body = await fetchWithTimeout(
      'https://hololive-official-cardgame.com/wp-json/wp/v2/post_news' +
        '?cat_news=16&per_page=5&_fields=date,link,title',
      15000,
    );
    const posts = JSON.parse(body);
    if (Array.isArray(posts) && posts.length > 0) {
      const newest = posts.find((p) => p?.date)?.date ?? null;
      alert('info', `Official showcase column feed reachable (newest ${newest ?? 'n/a'}).`, {
        newest,
      });
    }
  } catch (err) {
    alert('warn', `Official news feed unreachable (${err.message}); last-known-good preserved.`);
  }

  return out;
}

async function fetchWithTimeout(url, ms) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Run log + diff ───────────────────────────────────────────────────────────
const alerts = [];
function alert(level, message, extra = {}) {
  alerts.push({ level, message, ...extra });
  const tag = level === 'error' ? '❌' : level === 'warn' ? '⚠️ ' : 'ℹ️ ';
  console.error(`${tag} ${message}`);
}

function main() {
  mainAsync().catch((err) => {
    alert('error', err.message);
    finish(1);
  });
}

async function mainAsync() {
  ensureDir(REGISTRY_DIR);
  const { known, new: newQueue } = loadRegistry();

  // ---- discover ----
  let candidates = [];
  if (FIXTURE) {
    candidates = (JSON.parse(fs.readFileSync(FIXTURE, 'utf8')) ?? []).map(normalizeRecord).filter(Boolean);
  } else {
    candidates = (await fetchCandidateRecords()).map(normalizeRecord).filter(Boolean);
  }

  // ---- diff ----
  const seenKeys = new Set(candidates.map(recordKey));
  const knownKeys = new Set(known.records.map(recordKey));
  const newKeys = new Set(newQueue.records.map(recordKey));

  let discovered = candidates.length;
  let knownCount = 0;
  let newCount = 0;
  const newRecords = [];

  const knownChanged = [];
  for (const rec of candidates) {
    const key = recordKey(rec);
    if (knownKeys.has(key)) {
      knownCount += 1;
      continue;
    }
    if (!newKeys.has(key)) {
      upsert(newQueue.records, rec);
      newRecords.push(rec);
      newCount += 1;
    }
    knownChanged.push(rec);
  }

  // A record that was fully verified in the probe (media present and it was
  // confirmed by a prior run) can be Promoted to known now.
  const promoted = [];
  for (const rec of newQueue.records) {
    if (rec.verified) {
      if (upsert(known.records, rec)) promoted.push(rec);
    }
  }

  // ---- persist ----
  const now = NOW;
  if (!DRY_RUN) {
    known.updatedAt = now;
    newQueue.updatedAt = now;
    fs.writeFileSync(path.join(REGISTRY_DIR, KNOWN_FILE), JSON.stringify(known, null, 2) + '\n');
    if (knownChanged.length > 0) {
      fs.writeFileSync(
        path.join(REGISTRY_DIR, NEW_FILE),
        JSON.stringify(newQueue, null, 2) + '\n',
      );
    }
    fs.writeFileSync(
      path.join(REGISTRY_DIR, DIFF_FILE),
      JSON.stringify(
        {
          schemaVersion: 1,
          generatedAt: now,
          counts: { discovered, known: knownCount, new: newCount, promoted: promoted.length, failed: alerts.filter((a) => a.level === 'error').length },
          newRecords,
        },
        null,
        2,
      ) + '\n',
    );
    const next = nextRunIso(now, SCHEDULE.cron);
    fs.writeFileSync(
      path.join(REGISTRY_DIR, SCHED_FILE),
      JSON.stringify({ ...SCHEDULE, generatedAt: now, nextRunIso: next }, null, 2) + '\n',
    );
    fs.appendFileSync(
      path.join(REGISTRY_DIR, LOG_FILE),
      JSON.stringify({
        at: now,
        mode: FIXTURE ? 'fixture' : 'live',
        counts: { discovered, known: knownCount, new: newCount, promoted: promoted.length },
        newRecords: newRecords.map((r) => ({ eventId: r.eventId, name: r.name, date: r.date })),
        alerts: alerts.length,
      }) + '\n',
    );
  }

  // ---- report (always printed; also what a scheduler greps) ----
  console.log(
    [
      `discovered=${discovered}`,
      `known=${knownCount}`,
      `new=${newCount}`,
      `promoted=${promoted.length}`,
      `failed=${alerts.filter((a) => a.level === 'error').length}`,
      `alerts=${alerts.length}`,
      `next=${DRY_RUN ? 'dry' : nextRunIso(now, SCHEDULE.cron)}`,
    ].join(' '),
  );
  for (const r of newRecords) {
    console.log(`  NEW ${r.eventId} · ${r.date ?? 'no-date'} · ${r.name} · ${r.sourceUrl ?? 'no-url'}`);
  }

  finish(alerts.some((a) => a.level === 'error') ? 1 : 0);
}

// Compute the next scheduled UTC run time from a 5-field cron expression
// (min hour dom mon dow). Supports "*", step "*\/n", a single value, and lists.
export function nextRunIso(fromIso, cron, tz = 'UTC') {
  const from = new Date(fromIso);
  const parseField = (spec, min, max) => {
    const vals = new Set();
    for (const part of String(spec).split(',')) {
      const m = part.trim();
      if (m === '*') {
        for (let i = min; i <= max; i++) vals.add(i);
      } else if (/^\*\/(\d+)$/.test(m)) {
        const step = Number(m.split('/')[1]);
        for (let i = min; i <= max; i += step) vals.add(i);
      } else if (/^(-?\d+)-(-?\d+)$/.test(m)) {
        const [a, b] = m.split('-').map(Number);
        for (let i = Math.max(min, Math.min(a, b)); i <= Math.min(max, Math.max(a, b)); i++) vals.add(i);
      } else if (/^\d+$/.test(m)) {
        const v = Number(m);
        if (v >= min && v <= max) vals.add(v);
      }
    }
    return vals;
  };
  const [minF, hourF, domF, monF, dowF] = cron.trim().split(/\s+/);
  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hourF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12);
  const domsWild = domF.trim() === '*';
  const dows = dowF.trim() === '*' ? null : parseField(dowF, 0, 6);
  const hoursArr = [...hours].sort((a, b) => a - b);
  const minutesArr = [...minutes].sort((a, b) => a - b);

  // Start from the next minute; scan up to 2 years of days.
  const fromDay = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  for (let day = 0; day < 366 * 2; day++) {
    const base = fromDay.getTime() + day * 86_400_000;
    const cand = new Date(base);
    const mo = cand.getUTCMonth() + 1;
    const d = cand.getUTCDate();
    if (!months.has(mo) || !doms.has(d)) continue;
    for (const h of hoursArr) {
      for (const mi of minutesArr) {
        const t = Date.UTC(cand.getUTCFullYear(), cand.getUTCMonth(), d, h, mi, 0, 0);
        if (t <= from.getTime()) continue;
        const dowC = new Date(t).getUTCDay();
        // Standard cron day-domain rule: if BOTH dom and dow are restricted,
        // either matching satisfies the day; if only one is restricted, that
        // one must match.
        const domRestricted = !domsWild;
        const dowRestricted = dows !== null;
        let dayOK;
        if (domRestricted && dowRestricted) {
          dayOK = doms.has(d) || dows.has(dowC);
        } else if (domRestricted) {
          dayOK = doms.has(d);
        } else if (dowRestricted) {
          dayOK = dows.has(dowC);
        } else {
          dayOK = true;
        }
        if (!dayOK) continue;
        return new Date(t).toISOString();
      }
    }
  }
  return null;
}

function finish(code) {
  if (alerts.length > 0) {
    console.error('\n--- discovery alerts ---\n' + JSON.stringify(alerts, null, 2));
  }
  // stdout (the counts) must be machine-parseable; alerts stay on stderr.
  process.exit(code);
}

// Guard the CLI entrypoint so importing this module (e.g. to unit-test the
// pure helpers) does not side-effect a live discovery run.
const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  main();
}
