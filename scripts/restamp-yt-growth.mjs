#!/usr/bin/env node
/**
 * restamp-yt-growth.mjs — recompute the stamped growth deltas on every
 * snapshot in data/yt-stats-history.json using the current lib/yt-growth.js
 * algorithm (DIC-1139).
 *
 * scrape-yt-stats.js stamps the deltas at write-time, so historical snapshots
 * were stamped by whichever version of the algorithm was live on the day
 * they landed. This one-shot rewrite backfills every snapshot with the
 * current rules — null instead of `0` for stale-snapshot view deltas and
 * for subscriber deltas below the source's rounding step — so the DB-facing
 * assertion for "no synthetic zero daily metrics" holds against the whole
 * historical dataset, not only new snapshots.
 *
 * Idempotent: re-running produces the same output. Pure rewrite of the
 * stamped delta fields; raw subscriberCount/totalViewCount snapshots are
 * left untouched.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeGrowthDeltas } from './lib/yt-growth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HISTORY_PATH = path.resolve(__dirname, '../data/yt-stats-history.json');

const DELTA_FIELDS = [
  'subscriberGrowth_1d', 'subscriberGrowth_7d',
  'subscriberGrowth_15d', 'subscriberGrowth_30d',
  'viewCount_1d', 'viewCount_7d', 'viewCount_15d', 'viewCount_30d',
];

function restampChannel(history) {
  if (!Array.isArray(history) || history.length === 0) return { changed: 0 };
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  let changed = 0;
  // Compute deltas as of EACH snapshot's own date. The shared algorithm
  // walks a sorted history and reports deltas for the trailing snapshot, so
  // recomputing per-snapshot means feeding in the history slice ending on
  // that snapshot's date — the snapshot's own row is the "latest".
  for (let i = 0; i < sorted.length; i += 1) {
    const slice = sorted.slice(0, i + 1);
    const deltas = computeGrowthDeltas(slice);
    const target = sorted[i];
    for (const key of DELTA_FIELDS) {
      const next = deltas[key] ?? null;
      const prev = target[key] ?? null;
      if (prev !== next) {
        changed += 1;
        target[key] = next;
      }
    }
  }
  return { changed };
}

function main() {
  const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  let totalChanged = 0;
  let channels = 0;
  for (const [channelId, entry] of Object.entries(raw)) {
    if (!entry || !Array.isArray(entry.history)) continue;
    channels += 1;
    const { changed } = restampChannel(entry.history);
    totalChanged += changed;
  }
  fs.writeFileSync(HISTORY_PATH, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
  console.log(
    `[restamp-yt-growth] Rewrote ${totalChanged} delta fields across ${channels} channels.`
  );
}

main();
