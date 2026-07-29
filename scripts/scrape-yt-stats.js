/**
 * scrape-yt-stats.js
 *
 * 每日抓取 hololive 成員 YouTube 頻道的「訂閱數 + 累計觀看數」快照，
 * append 到 data/yt-stats-history.json（歷史累計，不覆蓋舊資料）。
 * 每筆快照同時存入 1/7/15/30 天的訂閱/觀看成長量（delta），由 lib/yt-growth.js
 * 從歷史反查計算；無 N 天前資料則存 null（不填 0，以免誤判）。新聞情緒欄位
 * （newsCount/newsPositive/newsNegative）由 scrape-news-sentiment.js 另外寫入
 * 同一天的快照，本 scraper 重跑時會保留既有值。
 *
 * 用法：
 *   node scrape-yt-stats.js
 *
 * ── 資料來源與方法 ──
 * 從 YouTube 頻道 About 分頁的伺服器端 HTML 取 window.ytInitialData，
 * 解析其中的 aboutChannelViewModel（含 subscriberCountText / viewCountText /
 * channelId）。實測 About 分頁的 SSR HTML 一次就帶完整資料，用一般 HTTP
 * fetch 即可取得，比 Puppeteer 更穩定：headless Chrome 對頻道頁常被降級
 * 成「This channel does not exist.」或只回傳未 hydrate 的空殼 header，而純
 * fetch 直接拿到完整 ytInitialData。因此本 scraper 用 fetch 而非 Puppeteer。
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { computeGrowthDeltas } from './lib/yt-growth.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const MEMBERS_PATH = path.join(DATA_DIR, 'yt-members.json');
const HISTORY_PATH = path.join(DATA_DIR, 'yt-stats-history.json');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const DELAY_MS = 2000;

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// "1.33M subscribers" → 1330000 ; "293,854,971 views" → 293854971 ; "543 subs" → 543
function parseCount(text) {
  if (!text) return null;
  const cleaned = String(text).replace(/,/g, '');
  const m = cleaned.match(/([\d.]+)\s*([KMB]?)/i);
  if (!m) return null;
  let n = parseFloat(m[1]);
  if (!Number.isFinite(n)) return null;
  const suffix = (m[2] || '').toUpperCase();
  if (suffix === 'K') n *= 1e3;
  else if (suffix === 'M') n *= 1e6;
  else if (suffix === 'B') n *= 1e9;
  return Math.round(n);
}

// Depth-limited search for the first object carrying a given key.
function deepFind(obj, key, depth = 0) {
  if (depth > 40 || !obj || typeof obj !== 'object') return null;
  if (obj[key] !== undefined) return obj[key];
  for (const k of Object.keys(obj)) {
    const r = deepFind(obj[k], key, depth + 1);
    if (r !== null) return r;
  }
  return null;
}

function extractYtInitialData(html) {
  // The ytInitialData block is a dedicated <script>; any literal </script> in
  // string values is escaped as <\/script>, so the first "};</script>" is the
  // real end of the JSON.
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

async function fetchAbout(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (res.status === 404) return { error: 'channel_not_found' };
  if (!res.ok) return { error: `http_${res.status}` };
  const html = await res.text();
  const yt = extractYtInitialData(html);
  if (!yt) return { error: 'no_ytinitialdata' };
  // Presence of aboutChannelViewModel is the real signal. We do NOT treat the
  // literal "This channel does not exist" string as authoritative: YouTube's
  // /channel/UCxxx/about endpoint injects that alert for many live channels
  // (no aboutChannelViewModel) while /@handle/about serves the real data — the
  // string caused 27/57 channels to be dropped as false channel_not_found (DIC-264).
  const about = deepFind(yt, 'aboutChannelViewModel');
  if (!about) return { error: 'no_about_viewmodel' };
  return { about };
}

async function fetchChannelStats(channelId, handle = null) {
  // Prefer the handle URL when known: it is the reliable source. Fall back to
  // the /channel/UCxxx endpoint so members without a handle still resolve.
  const candidates = [];
  if (handle) candidates.push(`https://www.youtube.com/${handle}/about?hl=en&gl=US`);
  candidates.push(`https://www.youtube.com/channel/${channelId}/about?hl=en&gl=US`);

  let lastError = 'channel_not_found';
  for (const url of candidates) {
    const r = await fetchAbout(url);
    if (!r.about) {
      lastError = r.error;
      continue;
    }
    const subscriberCount = parseCount(r.about.subscriberCountText);
    const totalViewCount = parseCount(r.about.viewCountText);
    if (subscriberCount == null && totalViewCount == null) {
      lastError = 'no_counts';
      continue;
    }
    const canonicalChannelId = r.about.channelId || null;
    // Validate canonical here, inside the candidate loop: a handle that resolves
    // to a different channel (stale/wrong id or hijacked handle) must not abort
    // the member — remember the mismatch and let the next candidate (the
    // /channel/UCxxx/about fallback) be tried before giving up (DIC-340).
    if (canonicalChannelId && canonicalChannelId !== channelId) {
      lastError = `canonical_mismatch:${canonicalChannelId}`;
      continue;
    }
    return {
      subscriberCount,
      totalViewCount,
      canonicalChannelId,
    };
  }
  return { error: lastError };
}

function loadMembers() {
  const data = JSON.parse(fs.readFileSync(MEMBERS_PATH, 'utf-8'));
  const members = (data.members || []).filter((m) => m.channelId && m.active !== false);
  // Dedupe by channelId (e.g. Marine appears twice); keep first occurrence.
  const seen = new Set();
  const unique = [];
  for (const m of members) {
    if (seen.has(m.channelId)) continue;
    seen.add(m.channelId);
    unique.push(m);
  }
  return unique;
}

function loadHistory() {
  try {
    return JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf-8'));
  } catch (err) {
    // Only a genuinely-missing file means "start fresh". Any other failure
    // (corrupt/half-written JSON, permissions) must abort — returning {} here
    // would make the run overwrite the file and wipe every prior snapshot,
    // resetting all growth deltas (DIC-250 review finding).
    if (err.code === 'ENOENT') return {};
    throw new Error(`Refusing to reset history — cannot read ${HISTORY_PATH}: ${err.message}`);
  }
}

async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════');
  console.log('  YouTube Channel Stats Tracker');
  console.log('═══════════════════════════════════════\n');

  const members = loadMembers();
  console.log(`[yt-stats] Loaded ${members.length} channels`);

  const history = loadHistory();
  const today = new Date().toISOString().split('T')[0];

  let ok = 0;
  let failed = 0;
  const failures = [];

  for (const member of members) {
    const { channelId, name, handle } = member;
    try {
      const stats = await fetchChannelStats(channelId, handle);
      if (stats.error) {
        // Includes canonical_mismatch:<id> when every candidate resolved to a
        // different channel — fetchChannelStats already exhausted the fallback.
        failed++;
        failures.push({ name, channelId, error: stats.error });
        console.warn(`  ✗ ${name} (${channelId}): ${stats.error}`);
      } else {
        if (!history[channelId]) history[channelId] = { name, history: [] };
        history[channelId].name = name; // keep name fresh
        const arr = history[channelId].history;
        const existingIdx = arr.findIndex((s) => s.date === today);
        // Preserve news stats already written into today's snapshot by
        // scrape-news-sentiment.js — an idempotent re-run of this scraper must
        // not wipe them (they live only in the snapshot).
        const prev = existingIdx >= 0 ? arr[existingIdx] : null;
        const snapshot = {
          date: today,
          subscriberCount: stats.subscriberCount,
          totalViewCount: stats.totalViewCount,
          subscriberGrowth_1d: null,
          subscriberGrowth_7d: null,
          subscriberGrowth_15d: null,
          subscriberGrowth_30d: null,
          viewCount_1d: null,
          viewCount_7d: null,
          viewCount_15d: null,
          viewCount_30d: null,
          newsCount: prev?.newsCount ?? null,
          newsPositive: prev?.newsPositive ?? null,
          newsNegative: prev?.newsNegative ?? null,
        };
        if (existingIdx >= 0) arr[existingIdx] = snapshot; // idempotent re-run
        else arr.push(snapshot);
        arr.sort((a, b) => a.date.localeCompare(b.date));
        // Stamp growth deltas now that the full (sorted) history is in place.
        Object.assign(snapshot, computeGrowthDeltas(arr));
        ok++;
        console.log(
          `  ✓ ${name}: ${stats.subscriberCount?.toLocaleString() ?? '?'} subs, ` +
            `${stats.totalViewCount?.toLocaleString() ?? '?'} total views`
        );
      }
    } catch (err) {
      failed++;
      failures.push({ name, channelId, error: err.message });
      console.error(`  ✗ ${name} (${channelId}): ${err.message}`);
    }
    await sleep(DELAY_MS);
  }

  fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(
    `\n[yt-stats] Saved snapshot for ${today}: ${ok} ok, ${failed} failed — ${HISTORY_PATH}`
  );
  if (failures.length) {
    console.log(`[yt-stats] Failed channels (${failures.length}):`);
    for (const f of failures) console.log(`    - ${f.name} (${f.channelId}): ${f.error}`);
  }
  console.log(`\n✅ Done in ${duration}s`);

  // Non-fatal: a partial run still persists what it collected.
  if (ok === 0) {
    console.error('[yt-stats] ❌ No channels collected — check network / channel IDs');
    process.exit(1);
  }
}

main().catch((err) => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
