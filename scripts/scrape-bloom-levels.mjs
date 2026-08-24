#!/usr/bin/env node
// Fetches Bloomレベル (Bloom Level: Debut / 1st / 2nd / Buzz / Spot) for every
// Holomen card seen in data/official/*.json and writes the canonical map to
// data/bloom-levels.json. Non-holomen cards (Oshi/Support/Yell/Mascot) are
// skipped because Bloom Level does not apply to them (DIC-1141).
//
// Field source: <dt>Bloomレベル</dt><dd>{{value}}</dd> inside
// .cardlist-Detail_Box_Inner on https://hololive-official-cardgame.com/cardlist/?id={{id}}&expansion={{expansion}}
//
// The scraper is idempotent: existing entries in bloom-levels.json are kept as
// canonical unless --force is passed, so re-runs converge without re-hitting the
// origin. To fully re-scrape, pass --force. To limit to a series, pass --only=hBP04.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OFFICIAL_DIR = path.join(REPO, 'data', 'official');
const OUT_FILE = path.join(REPO, 'data', 'bloom-levels.json');

const args = new Set(process.argv.slice(2));
const only = process.argv.slice(2).find((a) => a.startsWith('--only='))?.split('=')[1] || null;
const force = args.has('--force');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';
const CONCURRENCY = Number(process.env.BLOOM_CONCURRENCY || 6);
const REQUEST_DELAY_MS = Number(process.env.BLOOM_DELAY_MS || 120);

const VALID_LEVELS = new Set(['Debut', '1st', '2nd', 'Buzz', 'Spot']);

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.text();
}

function parseBloomLevel(html) {
  // Match <dt>Bloomレベル</dt> then the next <dd>value</dd>
  const m = html.match(/<dt>\s*Bloom(?:レベル|Level)\s*<\/dt>\s*<dd>([^<]+)<\/dd>/);
  if (!m) return null;
  const raw = m[1].trim();
  return VALID_LEVELS.has(raw) ? raw : null;
}

function loadExisting() {
  try {
    const j = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
    return j?.byCardNumber || {};
  } catch {
    return {};
  }
}

function saveResults(byCardNumber) {
  const sorted = Object.fromEntries(
    Object.keys(byCardNumber)
      .sort()
      .map((k) => [k, byCardNumber[k]]),
  );
  const payload = {
    lastUpdated: new Date().toISOString(),
    source: 'https://hololive-official-cardgame.com/cardlist/',
    field: 'Bloomレベル',
    totalCards: Object.keys(sorted).length,
    byCardNumber: sorted,
  };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
}

function collectHolomenCards() {
  const seen = new Map(); // cardNumber -> { id, expansion }
  const files = fs.readdirSync(OFFICIAL_DIR).filter((f) => {
    if (!f.endsWith('.json')) return false;
    if (f.startsWith('_') || f.startsWith('all-') || f.startsWith('cardList_')) return false;
    if (only && f !== `${only}.json`) return false;
    return true;
  });
  for (const fn of files) {
    let cards;
    try {
      cards = JSON.parse(fs.readFileSync(path.join(OFFICIAL_DIR, fn), 'utf8'));
    } catch {
      continue;
    }
    if (!Array.isArray(cards)) continue;
    for (const c of cards) {
      const cn = c?.cardNumber;
      const id = c?.id;
      const exp = c?.expansion;
      // Only ホロメン (excluding 推しホロメン, サポート, マスコット, エール).
      if (!cn || !id || !exp) continue;
      if (c.cardType !== 'ホロメン') continue;
      if (!seen.has(cn)) seen.set(cn, { id, expansion: exp });
    }
  }
  return seen;
}

async function limitedAll(tasks, limit) {
  const results = new Array(tasks.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= tasks.length) return;
      try {
        results[i] = await tasks[i]();
      } catch (err) {
        results[i] = { error: err };
      }
      if (REQUEST_DELAY_MS) await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  if (!fs.existsSync(OFFICIAL_DIR)) {
    console.error('No data/official directory found');
    process.exit(1);
  }
  const targets = collectHolomenCards();
  const existing = force ? {} : loadExisting();
  const pending = [];
  for (const [cn, meta] of targets) {
    if (existing[cn]) continue;
    pending.push({ cardNumber: cn, ...meta });
  }
  console.log(`[bloom] targets: ${targets.size}, cached: ${Object.keys(existing).length}, pending: ${pending.length}`);

  const result = { ...existing };
  let done = 0;
  let hit = 0;
  let miss = 0;

  const tasks = pending.map((item) => async () => {
    const url = `https://hololive-official-cardgame.com/cardlist/?id=${item.id}&expansion=${item.expansion}`;
    try {
      const html = await fetchHtml(url);
      const level = parseBloomLevel(html);
      done++;
      if (level) {
        result[item.cardNumber] = level;
        hit++;
      } else {
        miss++;
      }
      if (done % 20 === 0) {
        console.log(`[bloom] progress ${done}/${pending.length} (hit=${hit}, miss=${miss})`);
        // Checkpoint every 20
        saveResults(result);
      }
      return level;
    } catch (err) {
      miss++;
      console.warn(`[bloom] fetch failed ${item.cardNumber}: ${err.message}`);
      return null;
    }
  });

  await limitedAll(tasks, CONCURRENCY);
  saveResults(result);
  console.log(`[bloom] done: total=${Object.keys(result).length}, added=${hit}, missing=${miss}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
