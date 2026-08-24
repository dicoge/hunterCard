#!/usr/bin/env node
/**
 * scrape-official-cards.js — official hololive card catalog sync.
 *
 * Dynamic flow:
 *   1. Discover product expansions from /cardlist/ <select name="expansion_name">.
 *   2. Exclude legality/selection labels such as selehGS26.
 *   3. Scrape every requested official expansion page, including lazy pages.
 *   4. Fail closed on 0 cards, count regressions, missing fields, or expected-count mismatches.
 *
 * Usage:
 *   node scripts/scrape-official-cards.js
 *   node scripts/scrape-official-cards.js --only=hEB01
 *   node scripts/scrape-official-cards.js --check-production=https://holohunter.dicoge.com/data/database.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const OFFICIAL_DIR = path.join(REPO, 'data', 'official');
const AUDIT_DIR = path.join(REPO, 'docs', 'audits');
const BASE = 'https://hololive-official-cardgame.com';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36';

const COLOR_MAP = {
  type_white: 'white',
  type_red: 'red',
  type_green: 'green',
  type_blue: 'blue',
  type_purple: 'purple',
  type_yellow: 'yellow',
  '白': 'white',
  '赤': 'red',
  '緑': 'green',
  '青': 'blue',
  '紫': 'purple',
  '黄': 'yellow',
  '無': 'colorless',
};

const TYPE_MAP = {
  'ホロメン': 'Holomen',
  '推しホロメン': 'OshiHolomen',
  'サポート': 'Support',
  'Buzzホロメン': 'BuzzHolomen',
  'エール': 'Yell',
  'LIMITED': 'Limited',
  'サポート・アイテム': 'SupportItem',
  'サポート・イベント': 'SupportEvent',
  'サポート・ツール': 'SupportTool',
  'サポート・マスコット': 'SupportMascot',
  'サポート・ファン': 'SupportFan',
  'サポート・スタッフ': 'SupportStaff',
};

function argValue(name) {
  const prefix = `${name}=`;
  const found = process.argv.find((a) => a.startsWith(prefix));
  return found ? found.slice(prefix.length) : '';
}

function decodeHtml(input = '') {
  return String(input)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function stripTags(input = '') {
  return decodeHtml(String(input)
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<img[^>]*alt="([^"]*)"[^>]*>/gi, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\r\f\v]+/g, ' ')
    .replace(/\n\s+/g, '\n')
    .trim();
}

function absUrl(src = '') {
  if (!src) return '';
  if (src.startsWith('http')) return src;
  return `${BASE}${src.startsWith('/') ? '' : '/'}${src}`;
}

async function fetchHtml(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'ja-JP,ja;q=0.9,en-US;q=0.8,en;q=0.7' } });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return await res.text();
}

function parseExpectedCount(html) {
  const text = stripTags(html);
  const m = text.match(/検索結果\s*([0-9,]+)\s*件/);
  return m ? Number.parseInt(m[1].replace(/,/g, ''), 10) : null;
}

function parseMaxPage(html) {
  const m = html.match(/var\s+max_page\s*=\s*(\d+)/);
  return m ? Number.parseInt(m[1], 10) : 1;
}

function isProductExpansion(code) {
  // The official select also contains legality labels (for example selehGS26).
  // Product expansions are the sourceProduct values that should become printings.
  return /^h(?:BP|SD|YS|PR|PC|CS|CO|WF|EB)\d*/i.test(code) || /^ent\d+$/i.test(code);
}

export function discoverExpansionsFromHtml(html) {
  const selectMatch = html.match(/<select[^>]*name="expansion_name"[^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) throw new Error('official expansion select not found');
  const expansions = [];
  const seen = new Set();
  const optionRe = /<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    const code = decodeHtml(m[1]).trim();
    const name = stripTags(m[2]);
    if (!code || seen.has(code)) continue;
    seen.add(code);
    if (!isProductExpansion(code)) continue;
    expansions.push({ code, name });
  }
  if (!expansions.length) throw new Error('official expansion discovery returned 0 product expansions');
  return expansions;
}

async function discoverExpansions() {
  const html = await fetchHtml(`${BASE}/cardlist/`);
  return discoverExpansionsFromHtml(html);
}

function parseInfo(block, className = '') {
  const info = {};
  const scopeRe = className
    ? new RegExp(`<dl[^>]*class="[^"]*${className}[^"]*"[^>]*>([\\s\\S]*?)<\\/dl>`, 'i')
    : /<dl[^>]*>([\s\S]*?)<\/dl>/gi;
  const scopes = [];
  if (className) {
    const m = block.match(scopeRe);
    if (m) scopes.push(m[1]);
  } else {
    let m;
    while ((m = scopeRe.exec(block)) !== null) scopes.push(m[1]);
  }
  for (const scope of scopes) {
    const pairRe = /<dt>([\s\S]*?)<\/dt>\s*<dd[^>]*>([\s\S]*?)<\/dd>/gi;
    let p;
    while ((p = pairRe.exec(scope)) !== null) {
      const key = stripTags(p[1]);
      const raw = p[2];
      const icon = raw.match(/type_(\w+)\.png/i);
      info[key] = icon ? (COLOR_MAP[`type_${icon[1]}`] || icon[1]) : stripTags(raw);
    }
  }
  return info;
}

function parseSections(block, selectorClass) {
  const re = new RegExp(`<div[^>]*class="[^"]*${selectorClass}[^"]*"[^>]*>([\\s\\S]*?)<\\/div>`, 'gi');
  const out = [];
  let m;
  while ((m = re.exec(block)) !== null) out.push(stripTags(m[1]));
  return out.filter(Boolean);
}

export function parseCardsFromHtml(html, fallbackExpansion) {
  const cards = [];
  const liRe = /<li[^>]*>\s*<a\s+href="\/cardlist\/\?id=(\d+)(?:&(?:amp;)?[^="]+=[^&"]*)*&(?:amp;)?expansion=([^&"]+)[^"]*"[\s\S]*?<\/li>/gi;
  let m;
  while ((m = liRe.exec(html)) !== null) {
    const block = m[0];
    const id = m[1];
    const expansion = decodeHtml(m[2] || fallbackExpansion);
    const img = block.match(/<img[^>]+src="([^"]+)"[^>]*>/i);
    const imageUrl = img ? absUrl(decodeHtml(img[1])) : '';
    const cardNumber = stripTags(block.match(/<p[^>]*class="number"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '')
      || (imageUrl.match(/\/([h][A-Za-z0-9]+-\d{3})(?:_[^/]*)?\.png/i)?.[1] || '');
    const name = stripTags(block.match(/<p[^>]*class="name"[^>]*>([\s\S]*?)<\/p>/i)?.[1] || '');
    const info = parseInfo(block);
    const detail = parseInfo(block, 'info_Detail');
    const cardTypeJp = info['カードタイプ'] || '';
    const sourceProductText = info['収録商品'] || '';
    cards.push({
      id,
      cardNumber,
      name,
      cardType: TYPE_MAP[cardTypeJp] || cardTypeJp,
      cardTypeJp,
      color: detail['色'] || 'colorless',
      rarity: info['レアリティ'] || '',
      expansion,
      series: expansion,
      sourceProduct: expansion,
      sourceProductName: sourceProductText.split('\n')[0]?.trim() || '',
      sourceProductText,
      imageUrl,
      hp: detail['HP'] || '',
      life: detail['LIFE'] || '',
      bloomLevel: detail['Bloomレベル'] || detail['BloomLevel'] || '',
      tags: info['タグ'] || '',
      arts: parseSections(block, 'arts').join('\n'),
      keywords: parseSections(block, 'keyword').join('\n'),
      extra: parseSections(block, 'extra').join('\n'),
    });
  }
  return cards;
}

async function scrapeExpansion(expansion) {
  const firstUrl = `${BASE}/cardlist/cardsearch/?expansion=${encodeURIComponent(expansion.code)}&view=text&sort=cardnum`;
  const firstHtml = await fetchHtml(firstUrl);
  const expected = parseExpectedCount(firstHtml);
  const maxPage = parseMaxPage(firstHtml);
  const cards = parseCardsFromHtml(firstHtml, expansion.code);
  for (let page = 2; page <= maxPage; page++) {
    const html = await fetchHtml(`${BASE}/cardlist/cardsearch_ex?expansion=${encodeURIComponent(expansion.code)}&view=text&page=${page}&t=${Date.now()}`);
    cards.push(...parseCardsFromHtml(html, expansion.code));
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  const byPrinting = new Map();
  for (const card of cards) {
    const imageSuffix = card.imageUrl.match(/\/([^/]+)\.png$/i)?.[1] || '';
    const key = `${card.cardNumber}|${card.expansion}|${imageSuffix}|${card.id}`;
    if (!byPrinting.has(key)) byPrinting.set(key, card);
  }
  const deduped = [...byPrinting.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.id.localeCompare(b.id));
  return { cards: deduped, expected, maxPage };
}

function auditExpansion(expansion, cards, expected) {
  const missing = [];
  const required = ['id', 'cardNumber', 'name', 'cardType', 'rarity', 'imageUrl', 'sourceProduct'];
  for (const card of cards) {
    for (const field of required) {
      if (!card[field]) missing.push({ cardNumber: card.cardNumber || card.id || '(unknown)', id: card.id || '', field });
    }
  }
  if (cards.length === 0) missing.push({ cardNumber: '(series)', id: '', field: 'cards' });
  if (expected != null && cards.length !== expected) missing.push({ cardNumber: '(series)', id: '', field: `expectedCount ${expected} != ingestedCount ${cards.length}` });
  return {
    code: expansion.code,
    name: expansion.name,
    expectedCount: expected,
    ingestedCount: cards.length,
    missingCount: missing.length,
    missing,
    lastSuccessfulSync: missing.length === 0 ? new Date().toISOString() : null,
  };
}

async function checkProductionLag(meta, productionUrl) {
  if (!productionUrl) return [];
  const res = await fetch(productionUrl, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`production check failed: HTTP ${res.status} for ${productionUrl}`);
  const db = await res.json();
  const cards = Object.values(db.cards || {});
  const missing = [];
  const now = Date.now();
  for (const s of meta.seriesStats || []) {
    if (!s.lastSuccessfulSync) continue;
    const ageHours = (now - Date.parse(s.lastSuccessfulSync)) / 36e5;
    const prodCount = cards.filter((c) => c.sourceProduct === s.code || c.expansion === s.code || c.series === s.code).length;
    if (ageHours >= 24 && prodCount < s.ingestedCount) {
      missing.push({ code: s.code, officialCount: s.ingestedCount, productionCount: prodCount, ageHours: Number(ageHours.toFixed(1)) });
    }
  }
  return missing;
}

function readPriorCount(code) {
  for (const filename of [`${code}.json`, `cardList_${code}.json`]) {
    const file = path.join(OFFICIAL_DIR, filename);
    if (!fs.existsSync(file)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(parsed)) return parsed.length;
    } catch {}
  }
  return 0;
}

async function main() {
  fs.mkdirSync(OFFICIAL_DIR, { recursive: true });
  fs.mkdirSync(AUDIT_DIR, { recursive: true });

  const onlyArg = argValue('--only');
  const only = onlyArg ? new Set(onlyArg.split(',').map((s) => s.trim()).filter(Boolean)) : null;
  const productionUrl = argValue('--check-production');

  const discovered = await discoverExpansions();
  const expansions = only ? discovered.filter((e) => only.has(e.code)) : discovered;
  if (only && expansions.length !== only.size) {
    const found = new Set(expansions.map((e) => e.code));
    throw new Error(`requested expansion(s) not discovered: ${[...only].filter((c) => !found.has(c)).join(', ')}`);
  }

  const allCards = [];
  const audits = [];
  let hasFailure = false;

  for (const expansion of expansions) {
    console.log(`[official] scraping ${expansion.code} ${expansion.name}`);
    const priorCount = readPriorCount(expansion.code);
    const { cards, expected } = await scrapeExpansion(expansion);
    if (priorCount > 0 && cards.length < priorCount) {
      throw new Error(`${expansion.code} count regression: prior=${priorCount} current=${cards.length}`);
    }
    const audit = auditExpansion(expansion, cards, expected);
    audits.push(audit);
    if (audit.missingCount > 0) hasFailure = true;
    fs.writeFileSync(path.join(OFFICIAL_DIR, `${expansion.code}.json`), `${JSON.stringify(cards, null, 2)}\n`, 'utf8');
    allCards.push(...cards);
    console.log(`  ${cards.length} cards${expected != null ? ` / expected ${expected}` : ''}`);
  }

  const meta = {
    updatedAt: new Date().toISOString(),
    discoveredSeries: discovered.map((e) => e.code),
    series: expansions.map((e) => e.code),
    totalCards: allCards.length,
    seriesStats: audits.map(({ missing, ...rest }) => rest),
  };
  if (!only) {
    fs.writeFileSync(path.join(OFFICIAL_DIR, 'all-cards.json'), `${JSON.stringify(allCards, null, 2)}\n`, 'utf8');
  }
  fs.writeFileSync(path.join(OFFICIAL_DIR, '_meta.json'), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');

  const auditReport = {
    generatedAt: meta.updatedAt,
    officialToNormalized: audits,
    summary: {
      totalExpansions: audits.length,
      totalCards: allCards.length,
      totalMissingFields: audits.reduce((sum, a) => sum + a.missingCount, 0),
    },
  };
  const auditPath = path.join(AUDIT_DIR, 'official-catalog-audit.json');
  fs.writeFileSync(auditPath, `${JSON.stringify(auditReport, null, 2)}\n`, 'utf8');

  const productionMissing = await checkProductionLag(meta, productionUrl);
  if (productionMissing.length) {
    fs.writeFileSync(path.join(AUDIT_DIR, 'official-production-lag.json'), `${JSON.stringify({ generatedAt: new Date().toISOString(), missing: productionMissing }, null, 2)}\n`, 'utf8');
    throw new Error(`official expansion(s) missing from production after 24h: ${productionMissing.map((m) => m.code).join(', ')}`);
  }

  if (hasFailure) throw new Error(`official catalog audit failed; see ${path.relative(REPO, auditPath)}`);
  console.log(`[official] complete: ${allCards.length} cards across ${expansions.length} expansions`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`[official] failed: ${err.message}`);
    process.exit(1);
  });
}
