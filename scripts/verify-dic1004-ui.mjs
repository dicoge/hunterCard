#!/usr/bin/env node
// Manual UI verification for DIC-1004 — drives the built web bundle in a real
// browser: grouped low-cost search rows, no permanent red rule blocks while
// drafting, validation only after 完成組牌, and the 套用低配版本 normalization of
// an existing premium draft. Requires `npm run build` first (serves ./dist).
// Not part of CI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const dist = path.resolve('dist');
const types = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(dist, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4173, r));

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1000 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

const clickText = async (text) => {
  const handle = await page.evaluateHandle((t) => {
    const nodes = [...document.querySelectorAll('div,span,button')];
    return nodes.reverse().find((n) => n.textContent.trim() === t) || null;
  }, text);
  const el = handle.asElement();
  if (!el) throw new Error(`no clickable element with text "${text}"`);
  await el.click();
};
const hasText = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
const shot = (n) => page.screenshot({ path: `/tmp/dic1004-${n}.png` });

async function enterDeckEditor() {
  await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
    || document.body.innerText.includes('牌組編輯器'), { timeout: 30000 });
  if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
  await page.waitForFunction(() => document.body.innerText.includes('牌組編輯器'), { timeout: 30000 });
  await clickText('牌組編輯器');
  await page.waitForFunction(() => document.body.innerText.includes('本地牌組')
    || document.body.innerText.includes('完成組牌'), { timeout: 30000 });
}

await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
await enterDeckEditor();

// Create a deck.
await page.type('input[placeholder="新牌組名稱"]', 'DIC-1004 驗證');
await clickText('建立');
await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: 15000 });

// A brand-new, obviously incomplete deck must NOT show red rule-error blocks.
const draftHasErrorBlock = await hasText('🚫 錯誤');
const draftShowsCounts = await hasText('主牌組');
await shot('draft');

// Grouped low-cost search row.
await page.type('input[placeholder="卡號 / 名稱 / 系列"]', 'hBP01-048');
await page.waitForFunction(() => document.body.innerText.includes('預設低配版本'), { timeout: 15000 });
const searchText = await page.evaluate(() => document.body.innerText);
const rowCount = (searchText.match(/hBP01-048/g) || []).length;
await shot('search');

// Finalize an incomplete deck → issues appear on demand, editor stays open.
await clickText('完成組牌');
await page.waitForFunction(() => document.body.innerText.includes('尚未完成'), { timeout: 15000 });
const sheetHasIssues = await hasText('主牌組張數必須恰好為 50 張');
await shot('finalize-invalid');
await clickText('回到編輯');
await page.waitForFunction(() => !document.body.innerText.includes('尚未完成'), { timeout: 15000 });

// Deck list wording.
await clickText('切換牌組');
await page.waitForFunction(() => document.body.innerText.includes('我的牌組'), { timeout: 15000 });
const listText = await page.evaluate(() => document.body.innerText);
await shot('deck-list');

// ── Seeded scenario: a draft built on premium printings (the screenshot case) ──
const seeded = {
  state: {
    activeDeckId: 'seed',
    collection: {},
    decks: [{
      id: 'seed',
      name: '舊草稿（高配版本）',
      oshi: [{ card: { id: 'hBP04-005_ent07', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス', rarity: 'SEC', series: 'ent07', cardTypeJp: '推しホロメン' }, qty: 1 }],
      main: [{ card: { id: 'hBP01-048_ent07', cardNumber: 'hBP01-048', name: '白上フブキ', rarity: 'HR', series: 'ent07', cardTypeJp: 'ホロメン' }, qty: 4 }],
      yell: [],
      updatedAt: '2026-08-01T00:00:00.000Z',
    }],
  },
  version: 1,
};
await page.evaluate((s) => localStorage.setItem('hunterCard-decks', JSON.stringify(s)), seeded);
await page.reload({ waitUntil: 'networkidle0' });
await enterDeckEditor();
await page.waitForFunction(() => document.body.innerText.includes('套用低配版本'), { timeout: 30000 });
await shot('drift-before');
const driftLabel = await page.evaluate(() => {
  const m = document.body.innerText.match(/套用低配版本（(\d+)）/);
  return m ? m[1] : null;
});
await clickText(`套用低配版本（${driftLabel}）`);
await page.waitForFunction(() => !document.body.innerText.includes('套用低配版本'), { timeout: 15000 });
await shot('drift-after');
const normalized = await page.evaluate(() => {
  const s = JSON.parse(localStorage.getItem('hunterCard-decks')).state.decks[0];
  return {
    oshi: s.oshi.map((x) => [x.card.id, x.qty]),
    main: s.main.map((x) => [x.card.id, x.qty]),
    yell: s.yell.length,
  };
});

console.log(JSON.stringify({
  draftShowsCounts,
  draftHasErrorBlock,
  searchRowsForCardNumber: rowCount,
  searchShowsLowCostTag: searchText.includes('預設低配版本'),
  finalizeSheetListsIssues: sheetHasIssues,
  deckListSaysDraft: listText.includes('草稿'),
  deckListSaysError: listText.includes('有錯誤'),
  driftLabel,
  normalizedSlots: normalized,
  pageErrors: errors,
}, null, 2));

await browser.close();
server.close();
