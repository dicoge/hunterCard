// yt-stats-fanout.js — canonical name-based ytStats broadcast shared by the
// Official Catalog Sync writer (`sync-official-catalog-to-database.mjs`) and
// `restore-market-fields-post-canonicalization.mjs`. DIC-1153/1204 pin the
// full-dataset invariant behind it (`scripts/audit-card-data.mjs`): every card
// whose name (or nameZh) matches a tracked holomen MUST carry ytStats, and no
// card without such a name may. A second printing of the same member therefore
// inherits the member's ytStats; a first-only fan-out is a regression.
//
// Seeding uses ONLY the ytStats already present in the current or previous DB
// rows — no external channel/name mapping, no network, no guessed values — so
// the broadcast is deterministic and preserves the dataset's existing snapshot
// cohort (the audit reference time is the max ytStats.fetchedAt; copying an
// already-carried object cannot push that reference forward and make sibling
// printings non-displayable). Only objects that pass the same structural
// provenance shape the DIC-1084 audit checks (`hasDisplayableSubscriberStats`)
// are copied: integer subscriberCount, `UC`-prefixed channel id, authoritative
// YouTube SSR source/parser pair, and a parseable fetchedAt. Malformed or
// untracked names stay fail-closed — nothing invented is ever broadcast.
//
// This module is intentionally dependency-free (plain Node built-ins only):
// the scheduled Official Catalog Sync workflow runs
// `sync-official-catalog-to-database.mjs` without `npm ci`, so it cannot pull
// in build-database.js (cheerio) or a TS loader.

const UC_CHANNEL_RE = /^UC[\w-]{20,}$/;

export function hasProvenYtStatsShape(ytStats) {
  if (!ytStats || typeof ytStats !== 'object') return false;
  if (!Number.isInteger(ytStats.subscriberCount) || ytStats.subscriberCount < 0) return false;
  if (typeof ytStats.channelId !== 'string' || !UC_CHANNEL_RE.test(ytStats.channelId)) return false;
  if (ytStats.source !== 'youtube_about_ssr') return false;
  if (ytStats.parser !== 'ytInitialData.aboutChannelViewModel/v1') return false;
  if (!Number.isFinite(Date.parse(String(ytStats.fetchedAt ?? '')))) return false;
  return true;
}

/**
 * Broadcast the member's proven ytStats onto every printing that lacks it.
 *
 * Two-pass, name-based fan-out. Build the (name / nameZh -> ytStats) map from
 * whatever structurally proven ytStats survives in the current cards OR — as a
 * fallback — the previous DB. Current wins over previous so a freshly stamped
 * ytStats is never displaced by a stale one. Then fill every card that still
 * has no ytStats and whose trimmed name (or nameZh) maps to a proven object.
 * Fill-only by design: a preserved ytStats is never overwritten. Returns the
 * number of cards broadcast onto.
 *
 * @param {Record<string, any>} cards current cards map (mutated in place)
 * @param {Record<string, any>} [prevCards] previous DB cards map (fallback seed)
 */
export function broadcastYtStats(cards, prevCards = {}) {
  const byNameJp = new Map();
  const byNameZh = new Map();
  const seedFrom = (source) => {
    for (const card of Object.values(source || {})) {
      if (!hasProvenYtStatsShape(card?.ytStats)) continue;
      const nameJp = String(card.name ?? '').trim();
      const nameZh = String(card.nameZh ?? '').trim();
      if (nameJp && !byNameJp.has(nameJp)) byNameJp.set(nameJp, card.ytStats);
      if (nameZh && !byNameZh.has(nameZh)) byNameZh.set(nameZh, card.ytStats);
    }
  };
  seedFrom(cards);
  seedFrom(prevCards);
  let broadcast = 0;
  for (const card of Object.values(cards)) {
    if (card?.ytStats) continue;
    const nameJp = String(card?.name ?? '').trim();
    const nameZh = String(card?.nameZh ?? '').trim();
    const stats = (nameJp && byNameJp.get(nameJp)) || (nameZh && byNameZh.get(nameZh));
    if (stats) {
      card.ytStats = stats;
      broadcast++;
    }
  }
  return broadcast;
}