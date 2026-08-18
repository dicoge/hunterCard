#!/usr/bin/env node
// DIC-1085 production-build UI verification. Drives the real exported app at
// desktop and 390px, switches languages through Settings, reloads to prove
// persistence, and checks representative screens plus the live monthly summary.
//
//   npm run build && npm run verify:i18n-ui
//   BASE_URL=https://preview.example npm run verify:i18n-ui

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const LOCAL_PORT = 4178;
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/dic1085-evidence';
const T = Number(process.env.UI_TIMEOUT_MS || 30_000);
let server = null;

if (!BASE_URL) {
  const dist = path.resolve('dist');
  if (!fs.existsSync(dist)) throw new Error('dist is missing; run npm run build first');
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.ico': 'image/x-icon', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml',
  };
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dist, url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((resolve) => server.listen(LOCAL_PORT, resolve));
}

fs.mkdirSync(SHOT_DIR, { recursive: true });
const ORIGIN = BASE_URL || `http://localhost:${LOCAL_PORT}`;
const failures = [];
const evidence = [];

function check(label, ok, detail = '') {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
}

const index = await (await fetch(`${ORIGIN}/data/tournaments/index.json`)).json();
const reports = await Promise.all(index.months.map(async ({ month }) =>
  (await fetch(`${ORIGIN}/data/tournaments/${month}.json`)).json()));
const colorId = { 白: 'white', 青: 'blue', 藍: 'blue', 緑: 'green', 綠: 'green', 赤: 'red', 紅: 'red', 紫: 'purple', 黄: 'yellow', 黃: 'yellow', '◇': 'colorless' };
const decks = [...new Map(reports.flatMap((r) => r.events.flatMap((e) => e.decks))
  .filter((d) => d.cardsVerified === true).map((d) => [d.deckId, d])).values()];
const expectedColors = new Map();
for (const deck of decks) for (const raw of deck.colors || []) {
  const color = colorId[raw] || raw.toLowerCase();
  expectedColors.set(color, (expectedColors.get(color) || 0) + 1);
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

async function run(label, viewport) {
  console.log(`\n[${label} ${viewport.width}x${viewport.height} @ ${ORIGIN}]`);
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });

  const text = () => page.evaluate(() => document.body.innerText);
  const hasText = (value) => page.evaluate((needle) => document.body.innerText.includes(needle), value);
  const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);
  const clickText = async (value) => {
    const clicked = await page.evaluate((needle) => {
      const node = [...document.querySelectorAll('div,span,button')]
        .reverse().find((item) => item.textContent.trim() === needle);
      if (!node) return false;
      const target = node.closest('a,button,[role="button"]') || node;
      target.click();
      return true;
    }, value);
    if (!clicked) throw new Error(`No clickable text: ${value}`);
  };
  const waitText = (value) => page.waitForFunction(
    (needle) => document.body.innerText.includes(needle), { timeout: T }, value);
  const shot = async (name) => {
    const file = path.resolve(SHOT_DIR, `dic1085-${label}-${name}.png`);
    await page.screenshot({ path: file, fullPage: true });
    evidence.push(file);
  };

  await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await page.evaluate(() => {
    localStorage.clear();
  });
  await page.goto('about:blank');
  await page.goto(ORIGIN, { waitUntil: 'networkidle0' });
  await waitText('以訪客身份進入');
  await clickText('以訪客身份進入');
  await waitText('設定');

  await clickText('設定');
  await waitText('🌐 顯示語言');
  await clickText('日本語');
  await waitText('🌐 表示言語');
  check(`${label}: current Settings screen switches immediately`,
    await hasText('👤 アカウント') && !(await hasText('👤 帳號')));
  check(`${label}: Japanese Settings has no horizontal overflow`, await noOverflow());
  await shot('ja-settings');

  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('大会月報');
  await clickText('設定');
  await waitText('🌐 表示言語');
  const storedJapanese = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hunterCard-settings')).state.preferredLanguage);
  check(`${label}: Japanese preference survives reload`, storedJapanese === 'ja', storedJapanese);

  await clickText('検索');
  await waitText('🔍 カード検索');
  check(`${label}: Search chrome is Japanese`,
    (await hasText('人気の検索')) && !(await hasText('搜尋功能')));
  check(`${label}: Search has no horizontal overflow`, await noOverflow());

  await clickText('デッキエディタ');
  await waitText('この端末だけに保存されるデッキです');
  check(`${label}: Deck Editor chrome is Japanese`,
    (await hasText('この端末だけに保存されるデッキです')) && !(await hasText('本地牌組')));
  check(`${label}: Deck Editor has no horizontal overflow`, await noOverflow());

  await clickText('ルールチュートリアル');
  await waitText('「共に創り、共に競う」');
  check(`${label}: Tutorial landing is Japanese`, !(await hasText('共同創造、共同競爭')));
  check(`${label}: Tutorial has no horizontal overflow`, await noOverflow());

  await page.click('[data-testid="tutorial-section-intro"]');
  await waitText('プレイヤーはファンとなり');
  check(`${label}: Tutorial detail content is Japanese`,
    (await hasText('自分だけのステージを作ります')) && !(await hasText('這是一款')));
  check(`${label}: Tutorial detail has no horizontal overflow`, await noOverflow());
  await shot('ja-tutorial-detail');

  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('大会月報');
  await clickText('ルールチュートリアル');
  await waitText('「共に創り、共に競う」');
  await page.click('[data-testid="tutorial-simulation-entry"]');
  await waitText('手順に沿って対戦を体験しましょう');
  await waitText('推しホロメンを選ぶ');
  check(`${label}: Tutorial simulation content and controls are Japanese`,
    (await hasText('推しホロメンを置く')) && !(await hasText('選擇主推')) && !(await hasText('上一步')));
  check(`${label}: Tutorial simulation has no horizontal overflow`, await noOverflow());
  await shot('ja-tutorial-simulation');

  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('大会月報');
  await clickText('大会月報');
  await page.waitForSelector('[data-testid="tournament-monthly-summary"]', { timeout: T });
  await waitText('人気色');
  const expectedColorIds = [...expectedColors.keys()];
  await page.waitForFunction(
    (colors) => colors.every((color) => document.querySelector(`[data-testid="summary-color-${color}"]`)),
    { timeout: T },
    expectedColorIds,
  ).catch(() => {});
  const renderedColors = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="summary-color-"]')]
      .map((node) => node.getAttribute('data-testid').replace('summary-color-', '')));
  check(`${label}: monthly summary renders every live top color`,
    expectedColorIds.every((color) => renderedColors.includes(color)),
    renderedColors.join(','));
  check(`${label}: monthly summary uses Japanese chrome`,
    (await hasText('データソースと収録範囲')) && !(await hasText('資料來源與涵蓋率')));

  const firstColor = renderedColors[0];
  if (firstColor) {
    await page.click(`[data-testid="summary-color-${firstColor}"]`);
    const visibleDeckIds = await page.evaluate(() =>
      [...document.querySelectorAll('[data-testid^="deck-decklog:"]')]
        .map((node) => node.getAttribute('data-testid').replace(/^deck-/, '')));
    const expectedDeckIds = decks
      .filter((deck) => (deck.colors || []).some((raw) => (colorId[raw] || raw.toLowerCase()) === firstColor))
      .map((deck) => deck.deckId).sort();
    check(`${label}: top-color chip filters relevant live decks`,
      JSON.stringify(visibleDeckIds.sort()) === JSON.stringify(expectedDeckIds),
      `${firstColor}: ${visibleDeckIds.join(',')}`);
  }
  check(`${label}: Tournament report has no horizontal overflow`, await noOverflow());
  await shot('ja-tournament');

  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('大会月報');
  await clickText('設定');
  await waitText('🌐 表示言語');
  await clickText('中文');
  await waitText('🌐 顯示語言');
  check(`${label}: current Settings screen switches back immediately`,
    (await hasText('👤 帳號')) && !(await hasText('👤 アカウント')));
  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('賽事月報');
  await clickText('設定');
  await waitText('🌐 顯示語言');
  const storedChinese = await page.evaluate(() =>
    JSON.parse(localStorage.getItem('hunterCard-settings')).state.preferredLanguage);
  check(`${label}: Chinese preference survives reload`, storedChinese === 'zh', storedChinese);

  await clickText('賽事月報');
  await page.waitForSelector('[data-testid="tournament-monthly-summary"]', { timeout: T });
  await waitText('熱門顏色');
  check(`${label}: Chinese monthly summary remains available`,
    (await hasText('資料來源與涵蓋率')) && !(await hasText('データソースと収録範囲')));
  check(`${label}: Chinese report has no horizontal overflow`, await noOverflow());
  await shot('zh-tournament');

  check(`${label}: no uncaught browser errors`, errors.length === 0, errors.join(' | '));
  await page.close();
}

try {
  await run('desktop', { width: 1440, height: 1000 });
  await run('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
} finally {
  await browser.close();
  if (server) await new Promise((resolve) => server.close(resolve));
}

console.log(`\nEvidence: ${evidence.join(', ')}`);
if (failures.length) {
  console.error(`\nverify-dic1085-ui: FAIL (${failures.length})\n${failures.join('\n')}`);
  process.exit(1);
}
console.log('verify-dic1085-ui: PASS');
