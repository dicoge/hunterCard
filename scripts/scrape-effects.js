#!/usr/bin/env node
/**
 * scripts/scrape-effects.js
 *
 * Scrapes card skill/effect text from the official hololive card game website.
 * Reads card entries from data/official/*.json, dedupes by cardNumber, and
 * fetches each card's detail page. Outputs data/effects-jp.json with a clean,
 * structured skill schema:
 *
 *   {
 *     "hBP04-001": {
 *       "cardNumber": "hBP04-001",
 *       "name": "博衣こより",
 *       "cardType": "推しホロメン",
 *       "color": "白",
 *       "oshiSkill":   { "name": "...", "cost": "-2", "effect": "..." },
 *       "spOshiSkill": { "name": "...", "cost": "-2", "effect": "..." },
 *       "arts":     [ { "name": "...", "cost": "◇", "damage": "30", "effect": "" } ],
 *       "keywords": [ { "label": "エクストラ", "effect": "..." } ],
 *       "abilityText": "..."   // support cards
 *     }
 *   }
 *
 * The run is resumable: cardNumbers already present in the output file are
 * skipped, and progress is flushed to disk every FLUSH_EVERY cards. Uses only
 * built-in Node.js modules (https, http, fs, path).
 */

import https from 'https';
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://hololive-official-cardgame.com/cardlist/?id=';
const OFFICIAL_DIR = path.join(__dirname, '..', 'data', 'official');
const OUTPUT_FILE = path.join(__dirname, '..', 'data', 'effects-jp.json');
const RATE_LIMIT_MS = 150;
const MAX_RETRIES = 3;
const FLUSH_EVERY = 25;

// ─── HTTP ────────────────────────────────────────────────
function fetchUrl(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith('https') ? https : http;
    const req = requester.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; hunterCard/1.0)',
        'Accept': 'text/html,application/xhtml+xml',
      },
      timeout: 15000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(data);
        } else if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          fetchUrl(res.headers.location, retries).then(resolve, reject);
        } else {
          reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
      });
    });
    req.on('error', (err) => {
      if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve, reject), 1000);
      else reject(err);
    });
    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve, reject), 1000);
      else reject(new Error(`Timeout for ${url}`));
    });
  });
}

// ─── HTML helpers ────────────────────────────────────────
function stripTags(text) {
  return text.replace(/<[^>]+>/g, '');
}
function cleanText(text) {
  return text.replace(/\s+/g, ' ').replace(/　+/g, '　').trim();
}
// Convert <br> to newline, strip remaining tags, collapse blank lines.
function htmlToText(html) {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .split('\n').map((l) => l.replace(/[ \t　]+/g, (m) => (m.includes('　') ? '　' : ' ')).trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Return inner HTML of the first <div class="...className..."> and its end index.
function extractDivByClass(html, className) {
  const regex = new RegExp(`<div[^>]*class="[^"]*\\b${className}\\b[^"]*"[^>]*>`);
  const match = html.match(regex);
  if (!match) return null;
  const startIdx = match.index;
  const contentStart = html.indexOf('>', startIdx) + 1;
  let depth = 1;
  let i = contentStart;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<div', i);
    const nextClose = html.indexOf('</div>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 4; }
    else { depth--; i = nextClose + 6; }
  }
  return html.substring(contentStart, i - 6);
}

// Inner text of the first <span> in html, span-nesting aware.
function firstSpanInner(html) {
  const startIdx = html.indexOf('<span');
  if (startIdx === -1) return null;
  const contentStart = html.indexOf('>', startIdx) + 1;
  let depth = 1;
  let i = contentStart;
  while (i < html.length && depth > 0) {
    const nextOpen = html.indexOf('<span', i);
    const nextClose = html.indexOf('</span>', i);
    if (nextClose === -1) break;
    if (nextOpen !== -1 && nextOpen < nextClose) { depth++; i = nextOpen + 5; }
    else { depth--; i = nextClose + 7; }
  }
  return { inner: html.substring(contentStart, i - 7), end: i };
}

function imgAlts(html) {
  const alts = [];
  const re = /<img[^>]*alt="([^"]*)"[^>]*>/g;
  let m;
  while ((m = re.exec(html)) !== null) if (m[1]) alts.push(m[1]);
  return alts;
}

// ─── Section parsers ─────────────────────────────────────
// oshi / sp oshi skill: <div class="oshi skill"><p>推しスキル</p><p>[ホロパワー:-2]<span>name</span>effect</p></div>
function parseSkillDiv(html, className) {
  const div = extractDivByClass(html, className);
  if (!div) return null;
  const ps = [];
  const re = /<p>([\s\S]*?)<\/p>/g;
  let m;
  while ((m = re.exec(div)) !== null) ps.push(m[1]);
  if (ps.length < 2) return null;
  const body = ps[ps.length - 1];
  const costMatch = body.match(/\[ホロパワー[:：]\s*(-?\d+)\]/);
  const cost = costMatch ? costMatch[1] : '';
  const span = firstSpanInner(body);
  const name = span ? cleanText(stripTags(span.inner)) : '';
  const effect = cleanText(stripTags(
    body.replace(/\[ホロパワー[:：][^\]]*\]/, '').replace(/<span>[\s\S]*?<\/span>/, '')
  ));
  if (!name && !effect) return null;
  return { name, cost, effect };
}

// arts: <div class="... arts"><p>アーツ</p><p><span><img alt="◇"/>name　damage<span class="tokkou"></span></span>effect</p></div>
function parseArts(html) {
  const arts = [];
  const re = /<div[^>]*class="[^"]*\barts\b[^"]*"[^>]*>([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const div = m[1];
    // Body <p> is the one that is not the "アーツ" label.
    const ps = [];
    const pre = /<p>([\s\S]*?)<\/p>/g;
    let pm;
    while ((pm = pre.exec(div)) !== null) ps.push(pm[1]);
    const body = ps.find((p) => !/^\s*アーツ\s*$/.test(stripTags(p))) || ps[ps.length - 1];
    if (!body) continue;
    const span = firstSpanInner(body);
    const headHtml = span ? span.inner : body;
    const cost = imgAlts(headHtml).join('');
    // Remove imgs + nested tokkou span, keep "name　damage".
    let headText = cleanText(stripTags(
      headHtml.replace(/<span[^>]*class="tokkou"[^>]*>[\s\S]*?<\/span>/g, '')
    ));
    let name = headText;
    let damage = '';
    const dmgMatch = headText.match(/[　\s]+(\+?\d+\+?)\s*$/);
    if (dmgMatch) {
      damage = dmgMatch[1];
      name = headText.slice(0, dmgMatch.index).trim();
    }
    const effect = span ? cleanText(stripTags(body.slice(span.end))) : '';
    if (name || damage || effect) arts.push({ name, cost, damage, effect });
  }
  return arts;
}

// keyword blocks: <div class="extra"><p>エクストラ</p><p>effect</p></div> and similar.
function parseKeywords(html) {
  const kws = [];
  const re = /<div class="(extra|gift|buzz|collabo?|bloomEffect|baton|keyword)">([\s\S]*?)<\/div>/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const ps = [];
    const pre = /<p>([\s\S]*?)<\/p>/g;
    let pm;
    while ((pm = pre.exec(m[2])) !== null) ps.push(pm[1]);
    if (!ps.length) continue;
    const label = cleanText(stripTags(ps[0]));
    const effect = htmlToText(ps.slice(1).join('\n'));
    if (label && (effect || ps.length === 1)) kws.push({ label, effect });
  }
  return kws;
}

// support ability text from info dl: <dt>能力テキスト</dt><dd>...</dd>
function parseAbilityText(html) {
  const box = extractDivByClass(html, 'info');
  const src = box || html;
  const m = src.match(/<dt>\s*能力テキスト\s*<\/dt>\s*<dd>([\s\S]*?)<\/dd>/);
  return m ? htmlToText(m[1]) : '';
}

function parseColor(html) {
  const box = extractDivByClass(html, 'info');
  const src = box || html;
  const m = src.match(/<dt>\s*色\s*<\/dt>\s*<dd>[\s\S]*?<img[^>]*alt="([^"]+)"/);
  return m ? cleanText(m[1]) : '';
}

function parseCardType(html) {
  const box = extractDivByClass(html, 'info');
  const src = box || html;
  const m = src.match(/<dt>\s*カードタイプ\s*<\/dt>\s*<dd>([^<]+)<\/dd>/);
  return m ? cleanText(m[1]) : '';
}

function parseCardPage(html, card) {
  const result = {
    cardNumber: card.cardNumber || '',
    name: card.name || '',
    cardType: parseCardType(html) || card.cardType || '',
    color: parseColor(html),
  };

  const oshi = parseSkillDiv(html, 'oshi skill');
  if (oshi) result.oshiSkill = oshi;
  const sp = parseSkillDiv(html, 'sp skill');
  if (sp) result.spOshiSkill = sp;

  const arts = parseArts(html);
  if (arts.length) result.arts = arts;

  const keywords = parseKeywords(html);
  if (keywords.length) result.keywords = keywords;

  const ability = parseAbilityText(html);
  if (ability) result.abilityText = ability;

  return result;
}

function hasContent(parsed) {
  return !!(parsed.oshiSkill || parsed.spOshiSkill ||
    (parsed.arts && parsed.arts.length) ||
    (parsed.keywords && parsed.keywords.length) ||
    parsed.abilityText);
}

// ─── Main ────────────────────────────────────────────────
function loadExisting() {
  try {
    return JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  } catch (e) {
    return {};
  }
}

function writeOutput(results) {
  const sorted = {};
  for (const k of Object.keys(results).sort()) sorted[k] = results[k];
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(sorted, null, 2), 'utf8');
}

async function main() {
  console.log('=== hololive OCG Card Effects Scraper ===');
  console.log(`Output: ${OUTPUT_FILE}`);

  let allFiles;
  try {
    allFiles = fs.readdirSync(OFFICIAL_DIR);
  } catch (err) {
    console.error(`Error reading ${OFFICIAL_DIR}: ${err.message}`);
    process.exit(1);
  }

  const jsonFiles = allFiles.filter((f) =>
    f.endsWith('.json') && !f.startsWith('_') &&
    f !== 'all-cards.json' && f !== 'all-new-cards.json');

  // Collect one representative entry per cardNumber (prefer entries that carry a cardType).
  const byCardNum = new Map();
  for (const file of jsonFiles) {
    let data;
    try { data = JSON.parse(fs.readFileSync(path.join(OFFICIAL_DIR, file), 'utf8')); }
    catch (err) { console.error(`  Warning: ${file}: ${err.message}`); continue; }
    if (!Array.isArray(data)) continue;
    for (const c of data) {
      if (!c.id || !c.cardNumber) continue;
      const prev = byCardNum.get(c.cardNumber);
      if (!prev || (!prev.cardType && c.cardType)) {
        byCardNum.set(c.cardNumber, { id: c.id, cardNumber: c.cardNumber, cardType: c.cardType || '', name: c.name || (prev && prev.name) || '' });
      }
    }
  }

  const cards = Array.from(byCardNum.values());
  console.log(`Unique cardNumbers to consider: ${cards.length}`);

  const results = loadExisting();
  const alreadyDone = new Set(Object.keys(results));
  const todo = cards.filter((c) => !alreadyDone.has(c.cardNumber));
  console.log(`Already have: ${alreadyDone.size} | Remaining: ${todo.length}\n`);

  let processed = 0, ok = 0, errors = 0, empty = 0;
  const total = todo.length;

  for (const card of todo) {
    processed++;
    const url = BASE_URL + card.id;
    process.stdout.write(`  [${processed}/${total}] ${card.cardNumber} ${card.name} ... `);
    try {
      const html = await fetchUrl(url);
      if (!html || html.length < 500) { process.stdout.write('SKIP (empty)\n'); empty++; }
      else {
        const parsed = parseCardPage(html, card);
        results[card.cardNumber] = parsed;
        if (hasContent(parsed)) { process.stdout.write('OK\n'); ok++; }
        else { process.stdout.write('OK (no skills)\n'); empty++; }
      }
    } catch (err) {
      process.stdout.write(`ERROR: ${err.message}\n`);
      errors++;
    }
    if (processed % FLUSH_EVERY === 0) writeOutput(results);
    if (processed < total) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
  }

  writeOutput(results);
  console.log('\n=== Results ===');
  console.log(`  Processed this run: ${processed}`);
  console.log(`  With skills: ${ok} | No skills: ${empty} | Errors: ${errors}`);
  console.log(`  Total in file: ${Object.keys(results).length}`);
  console.log(`  File size: ${(fs.statSync(OUTPUT_FILE).size / 1024).toFixed(1)} KB`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}

export { parseCardPage, parseArts, parseSkillDiv, parseKeywords, parseAbilityText };
