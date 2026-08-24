#!/usr/bin/env node
/**
 * refresh-yt-stats.mjs — recompute the ytStats block on every card in
 * data/database.json from the current data/yt-stats-history.json (DIC-1139).
 *
 * scrape-yt-stats.js and build-database.js normally stamp ytStats during a
 * full scrape run. When the growth-delta algorithm changes (as it did for
 * DIC-1139's stale-snapshot / rounding-precision fixes) we need the merged
 * ytStats to reflect the new rules without re-scraping every card page.
 *
 * This script mirrors build-database.js `mergeYtStats` exactly — the only
 * difference is that it operates on the existing database and history files
 * instead of the in-memory build. It does NOT modify raw snapshots
 * (restamp-yt-growth.mjs does that separately).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeGrowthDeltas } from './lib/yt-growth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.resolve(__dirname, '../data/database.json');
const HISTORY_PATH = path.resolve(__dirname, '../data/yt-stats-history.json');
const MEMBERS_PATH = path.resolve(__dirname, '../data/yt-members.json');

// Mirrors build-database.js:computeYtGrowth exactly, including the legacy
// aliases the UI still reads.
function computeYtGrowth(history) {
  if (!Array.isArray(history) || history.length === 0) return null;
  const sorted = [...history].sort((a, b) => a.date.localeCompare(b.date));
  const withStats = sorted.filter((s) => s.subscriberCount != null || s.totalViewCount != null);
  const latestStats = withStats.length ? withStats[withStats.length - 1] : null;
  const latestSubs = [...withStats].reverse().find((s) => s.subscriberCount != null) ?? null;
  const latestViews = [...withStats].reverse().find((s) => s.totalViewCount != null) ?? null;
  const d = computeGrowthDeltas(withStats);
  const withNews = sorted.filter((s) => s.newsCount != null);
  const latestNews = withNews.length ? withNews[withNews.length - 1] : null;

  return {
    subscriberCount: latestSubs?.subscriberCount ?? null,
    totalViewCount: latestViews?.totalViewCount ?? null,
    date: (latestStats ?? sorted[sorted.length - 1]).date,
    channelId: latestSubs?.channelId ?? null,
    source: latestSubs?.source ?? null,
    parser: latestSubs?.parser ?? null,
    fetchedAt: latestSubs?.fetchedAt ?? null,
    subscriberDate: latestSubs?.date ?? null,
    viewChannelId: latestViews?.channelId ?? null,
    viewSource: latestViews?.source ?? null,
    viewParser: latestViews?.parser ?? null,
    viewFetchedAt: latestViews?.fetchedAt ?? null,

    subscriberGrowth_1d: d.subscriberGrowth_1d,
    subscriberGrowth_7d: d.subscriberGrowth_7d,
    subscriberGrowth_15d: d.subscriberGrowth_15d,
    subscriberGrowth_30d: d.subscriberGrowth_30d,
    viewCount_1d: d.viewCount_1d,
    viewCount_7d: d.viewCount_7d,
    viewCount_15d: d.viewCount_15d,
    viewCount_30d: d.viewCount_30d,

    newsCount: latestNews?.newsCount ?? null,
    newsPositive: latestNews?.newsPositive ?? null,
    newsNegative: latestNews?.newsNegative ?? null,

    growth_1d: d.subscriberGrowth_1d,
    growth_7d: d.subscriberGrowth_7d,
    growth_15d: d.subscriberGrowth_15d,
    growth_30d: d.subscriberGrowth_30d,
    viewCount_daily: d.viewCount_1d,
    viewCount_weekly: d.viewCount_7d,
    viewCount_monthly: d.viewCount_30d,
  };
}

function main() {
  const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
  const history = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  const membersRaw = JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf-8'));
  const members = membersRaw.members || [];

  const statsByChannel = {};
  for (const [channelId, entry] of Object.entries(history)) {
    if (!entry || !Array.isArray(entry.history)) continue;
    const s = computeYtGrowth(entry.history);
    if (s) statsByChannel[channelId] = s;
  }

  const statsByNameJp = {};
  const statsByNameZh = {};
  for (const m of members) {
    const stats = m.channelId && statsByChannel[m.channelId];
    if (!stats) continue;
    if (m.nameJp && !statsByNameJp[m.nameJp]) statsByNameJp[m.nameJp] = stats;
    if (m.nameZh && !statsByNameZh[m.nameZh]) statsByNameZh[m.nameZh] = stats;
    for (const alt of m.altNamesJp || []) if (alt && !statsByNameJp[alt]) statsByNameJp[alt] = stats;
    for (const alt of m.altNamesZh || []) if (alt && !statsByNameZh[alt]) statsByNameZh[alt] = stats;
  }

  let merged = 0;
  for (const card of Object.values(db.cards || {})) {
    const stats =
      (card.name && statsByNameJp[card.name.trim()]) ||
      (card.nameZh && statsByNameZh[card.nameZh.trim()]) ||
      null;
    if (stats) {
      card.ytStats = stats;
      merged += 1;
    }
  }
  fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');
  console.log(
    `[refresh-yt-stats] Refreshed ytStats on ${merged} cards (${Object.keys(statsByChannel).length} channels).`
  );
}

main();
