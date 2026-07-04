/**
 * scrape-yt-subscribers.js
 *
 * 每日爬取 hololive 成員的 YouTube 頻道訂閱數
 * 儲存到 data/yt-subscribers/{date}.json
 *
 * 使用 YouTube Data API v3（若有 API key）
 * 或從公開頁面解析（降級方案）
 *
 * 用法：
 *   node scripts/scrape-yt-subscribers.js
 *   YT_API_KEY=xxx node scripts/scrape-yt-subscribers.js  # 使用 API
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_DIR = path.resolve(__dirname, '..');
const DATA_DIR = path.join(PROJECT_DIR, 'data');
const YT_SUB_DIR = path.join(DATA_DIR, 'yt-subscribers');

// ── 載入成員清單 ──
function loadMembers() {
  const filePath = path.join(DATA_DIR, 'yt-members.json');
  const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  // Only include active members
  return data.members.filter(m => m.active !== false);
}

// ── 方式 1：YouTube Data API v3 ──
async function scrapeWithAPI(members, apiKey) {
  console.log(`[yt-subscribers] Using YouTube Data API v3 (${members.length} members)...`);

  const results = {};
  const batchSize = 50; // Max per API call

  for (let i = 0; i < members.length; i += batchSize) {
    const batch = members.slice(i, i + batchSize);
    const ids = batch.map(m => m.channelId).join(',');

    const url = `https://www.googleapis.com/youtube/v3/channels?part=statistics,snippet&id=${ids}&key=${apiKey}`;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText.slice(0, 200)}`);
      }

      const data = await response.json();

      if (!data.items) {
        console.warn(`  [yt-subscribers] No items returned for batch ${i}-${i + batchSize}`);
        continue;
      }

      for (const item of data.items) {
        const channelId = item.id;
        const subscriberCount = parseInt(item.statistics?.subscriberCount || '0', 10);
        const channelName = item.snippet?.title || '';

        // Find matching member
        const member = batch.find(m => m.channelId === channelId);
        if (member) {
          results[member.nameJp] = {
            channelId,
            channelName,
            nameJp: member.nameJp,
            nameZh: member.nameZh,
            subscribers: subscriberCount,
            lastUpdated: new Date().toISOString(),
          };
        }
      }

      console.log(`  [yt-subscribers] Batch ${i}-${i + batchSize}: ${data.items.length} channels fetched`);

      // Rate limit: 1 request per second
      await new Promise(r => setTimeout(r, 1000));

    } catch (err) {
      console.error(`  [yt-subscribers] Error fetching batch ${i}: ${err.message}`);
    }
  }

  return results;
}

// ── 方式 2：Social Blade 爬蟲（降級方案） ──
async function scrapeWithSocialBlade(members) {
  console.log('[yt-subscribers] Using Social Blade fallback...');
  const results = {};

  for (const member of members) {
    try {
      const url = `https://socialblade.com/youtube/channel/${member.channelId}`;
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });

      if (!response.ok) {
        console.warn(`  [yt-subscribers] Social Blade failed for ${member.nameJp} (HTTP ${response.status})`);
        continue;
      }

      const html = await response.text();

      // Extract subscriber count from Social Blade page
      // Format: "**X,XXX,XXX** Subscribers"
      const match = html.match(/([\d,]+)\s*Subscribers/);
      if (match) {
        const count = parseInt(match[1].replace(/,/g, ''), 10);
        results[member.nameJp] = {
          channelId: member.channelId,
          nameJp: member.nameJp,
          nameZh: member.nameZh,
          subscribers: count,
          source: 'socialblade',
          lastUpdated: new Date().toISOString(),
        };
        console.log(`  ${member.nameJp}: ${count.toLocaleString()} subs`);
      } else {
        console.warn(`  [yt-subscribers] Could not parse subscriber count for ${member.nameJp}`);
      }
    } catch (err) {
      console.error(`  [yt-subscribers] Error scraping ${member.nameJp}: ${err.message}`);
    }

    // Rate limiting: 2-3s between requests
    await new Promise(r => setTimeout(r, 2000 + Math.random() * 1000));
  }

  return results;
}

// ── 儲存結果 ──
function saveResults(results) {
  fs.mkdirSync(YT_SUB_DIR, { recursive: true });

  const today = new Date().toISOString().split('T')[0];
  const filePath = path.join(YT_SUB_DIR, `${today}.json`);

  const output = {
    date: today,
    lastUpdated: new Date().toISOString(),
    totalMembers: Object.keys(results).length,
    members: results,
  };

  fs.writeFileSync(filePath, JSON.stringify(output, null, 2));

  // Update index
  const indexFile = path.join(YT_SUB_DIR, 'index.json');
  let index = { dates: [], totalRecords: 0 };
  try {
    index = JSON.parse(fs.readFileSync(indexFile, 'utf-8'));
  } catch {
    // new file
  }

  if (!index.dates.includes(today)) {
    index.dates.push(today);
    index.dates.sort();
  }
  index.totalRecords = index.dates.length;
  index.lastUpdated = new Date().toISOString();
  fs.writeFileSync(indexFile, JSON.stringify(index, null, 2));

  console.log(`[yt-subscribers] Saved ${Object.keys(results).length} members to ${filePath}`);
  return output;
}

// ── 主流程 ──
async function main() {
  const startTime = Date.now();
  console.log('═══════════════════════════════════════');
  console.log('  YouTube Subscriber Tracker');
  console.log('═══════════════════════════════════════\n');

  const members = loadMembers();
  console.log(`[yt-subscribers] Loaded ${members.length} members`);

  let results = {};

  // Try YouTube Data API first
  const apiKey = process.env.YT_API_KEY;
  if (apiKey) {
    results = await scrapeWithAPI(members, apiKey);
  } else {
    console.log('[yt-subscribers] No YT_API_KEY set, using Social Blade fallback');
    results = await scrapeWithSocialBlade(members);
  }

  if (Object.keys(results).length === 0) {
    console.error('[yt-subscribers] ❌ No subscriber data collected');
    process.exit(1);
  }

  saveResults(results);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n✅ Done in ${duration}s — ${Object.keys(results).length} members tracked`);
}

// Run
main().catch(err => {
  console.error('\n❌ Failed:', err.message);
  process.exit(1);
});
