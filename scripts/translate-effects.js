#!/usr/bin/env node
/**
 * scripts/translate-effects.js
 *
 * Reads data/effects-jp.json, translates every skill/effect string to
 * Traditional Chinese, and writes data/effects-zh.json (same structure).
 *
 * - Deduplicates strings before translating (many effects repeat across cards).
 * - Caches translations in data/_translation-cache.json so runs are resumable.
 * - Batches requests to the OpenRouter chat-completions endpoint.
 *
 * API key: providers[0].api_key from ~/.claude-code-router/config.json
 * (OpenRouter). Model: deepseek/deepseek-v4-flash (Claude Haiku is not exposed
 * on this key). Override with TRANSLATE_MODEL env var.
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const IN_FILE = path.join(DATA_DIR, 'effects-jp.json');
const OUT_FILE = path.join(DATA_DIR, 'effects-zh.json');
const CACHE_FILE = path.join(DATA_DIR, '_translation-cache.json');

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODEL = process.env.TRANSLATE_MODEL || 'deepseek/deepseek-v4-flash';
const BATCH_SIZE = 20;
const CONCURRENCY = 6;
const NL = '⏎'; // newline placeholder for line-based transport

const SYSTEM_PROMPT = `你是專業的桌遊翻譯，將 hololive OFFICIAL CARD GAME 的日文卡牌技能文字翻譯成繁體中文（台灣用語）。規則：
1. 以下專有名詞保留日文原文，不要翻譯：ホロメン、推しスキル、SP推しスキル、アーツ、ホロパワー、エール、コラボ、バトンタッチ、ブルーム、センター、Buzz、ギフト、LIMITED、ダウン、Debut。
2. 一般遊戲詞彙照此翻譯：デッキ→牌組、手札→手牌、ステージ→場上、ライフ→生命、ダメージ→傷害、相手→對手、自分→自己、選ぶ→選擇、公開→展示、引く→抽。
3. 保留所有數字、+、-、括號與符號結構，例如 [ターンに1回]→[每回合1次]、[ゲームに1回]→[每場遊戲1次]。
4. 保留換行符號 ⏎，位置與原文一致。
5. 只輸出翻譯結果，不要加任何解釋、引號、標題或 Markdown 標記（例如 **翻譯**：）。
6. 必須使用繁體中文（台灣用語），絕對不可使用簡體字。`;

function getKey() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude-code-router', 'config.json'), 'utf8'));
  const p = (cfg.Providers || cfg.providers)[0];
  return p.api_key;
}

async function chat(messages, retries = 4) {
  const KEY = getKey();
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);
    try {
      const r = await fetch(API_URL, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: MODEL, messages, temperature: 0 }),
        signal: ctrl.signal,
      });
      if (r.status === 429 || r.status >= 500) throw new Error('HTTP ' + r.status);
      const j = await r.json();
      const content = j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
      if (!content) throw new Error('empty response: ' + JSON.stringify(j).slice(0, 200));
      return content;
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise((res) => setTimeout(res, 1500 * (attempt + 1)));
    } finally {
      clearTimeout(timer);
    }
  }
}

// Strip a model's optional <think>…</think> preamble.
function cleanContent(text) {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

// Strip stray markdown labels the model sometimes prepends (e.g. "**翻譯**：").
function stripPrefix(s) {
  return s.replace(/^\**\s*(翻譯|翻译|譯文|译文|Translation)\s*\**\s*[:：]?\s*/i, '').trim();
}

async function translateBatch(strings) {
  const numbered = strings.map((s, i) => `${i + 1}\t${s.replace(/\n/g, NL)}`).join('\n');
  const user = `翻譯下列 ${strings.length} 行日文，逐行對應輸出，格式必須是「編號<TAB>譯文」，不可合併、省略或新增行：\n${numbered}`;
  const content = cleanContent(await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: user },
  ]));

  const out = new Array(strings.length).fill(null);
  for (const line of content.split('\n')) {
    const m = line.match(/^\s*(\d+)[\t\.\)、:：]\s*(.*)$/);
    if (!m) continue;
    const idx = parseInt(m[1], 10) - 1;
    if (idx >= 0 && idx < strings.length && out[idx] === null) {
      out[idx] = stripPrefix(m[2].replace(new RegExp(NL, 'g'), '\n').trim());
    }
  }
  return out;
}

async function translateOne(s) {
  const content = cleanContent(await chat([
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: '翻譯成繁體中文，只輸出譯文：\n' + s.replace(/\n/g, NL) },
  ]));
  return stripPrefix(content.replace(new RegExp(NL, 'g'), '\n').trim());
}

function collectStrings(data) {
  const set = new Set();
  const add = (s) => { if (s && typeof s === 'string' && s.trim()) set.add(s); };
  for (const k in data) {
    const c = data[k];
    for (const sk of ['oshiSkill', 'spOshiSkill']) if (c[sk]) { add(c[sk].name); add(c[sk].effect); }
    if (c.arts) for (const a of c.arts) { add(a.name); add(a.effect); }
    if (c.keywords) for (const kw of c.keywords) { add(kw.label); add(kw.effect); }
    add(c.abilityText);
  }
  return Array.from(set);
}

function reconstruct(data, cache) {
  const tr = (s) => (s && cache[s]) ? cache[s] : s;
  const out = {};
  for (const k in data) {
    const c = data[k];
    const z = { cardNumber: c.cardNumber, name: c.name, cardType: c.cardType, color: c.color };
    for (const sk of ['oshiSkill', 'spOshiSkill']) {
      if (c[sk]) z[sk] = { name: tr(c[sk].name), cost: c[sk].cost, effect: tr(c[sk].effect) };
    }
    if (c.arts) z.arts = c.arts.map((a) => ({ name: tr(a.name), cost: a.cost, damage: a.damage, effect: tr(a.effect) }));
    if (c.keywords) z.keywords = c.keywords.map((kw) => ({ label: tr(kw.label), effect: tr(kw.effect) }));
    if (c.abilityText) z.abilityText = tr(c.abilityText);
    out[k] = z;
  }
  return out;
}

async function main() {
  const data = JSON.parse(fs.readFileSync(IN_FILE, 'utf8'));
  let cache = {};
  try { cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8')); } catch (e) {}

  const all = collectStrings(data);
  const todo = all.filter((s) => !(s in cache));
  console.log(`Unique strings: ${all.length} | cached: ${all.length - todo.length} | to translate: ${todo.length}`);

  // Split into batches, process CONCURRENCY batches in parallel.
  const batches = [];
  for (let i = 0; i < todo.length; i += BATCH_SIZE) batches.push(todo.slice(i, i + BATCH_SIZE));

  let done = 0;
  async function runBatch(batch) {
    let results;
    try { results = await translateBatch(batch); }
    catch (err) { results = new Array(batch.length).fill(null); }
    const missing = results.filter((r) => !r).length;
    if (missing >= batch.length / 2) { try { results = await translateBatch(batch); } catch (e) {} }
    for (let j = 0; j < batch.length; j++) {
      if (!results[j]) {
        try { results[j] = await translateOne(batch[j]); }
        catch (e) { console.log(`\n  single failed: ${batch[j].slice(0, 16)}… ${e.message}`); }
      }
      if (results[j]) cache[batch[j]] = results[j];
    }
    done += batch.length;
  }

  let next = 0;
  async function worker() {
    while (next < batches.length) {
      const idx = next++;
      await runBatch(batches[idx]);
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf8');
      process.stdout.write(`\r  translated ${Math.min(done, todo.length)}/${todo.length}   `);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  console.log('');

  const untranslated = all.filter((s) => !(s in cache));
  if (untranslated.length) console.log(`WARN: ${untranslated.length} strings still untranslated`);

  const zh = reconstruct(data, cache);
  fs.writeFileSync(OUT_FILE, JSON.stringify(zh, null, 2), 'utf8');
  console.log(`Wrote ${OUT_FILE} (${Object.keys(zh).length} cards, ${(fs.statSync(OUT_FILE).size / 1024).toFixed(1)} KB)`);
}

main().catch((err) => { console.error('Fatal:', err); process.exit(1); });
