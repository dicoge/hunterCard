#!/usr/bin/env node
// DIC-1085 production-build UI verification. Drives the real exported app at
// desktop and 390px, switches languages through Settings, reloads to prove
// persistence, and checks representative screens plus the live monthly summary.
//
//   npm run build && npm run verify:i18n-ui
//   BASE_URL=https://preview.example npm run verify:i18n-ui

import http from 'node:http';
import { createHash } from 'node:crypto';
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

const TUTORIAL_DETAILS = [
  { id: 'intro', title: 'ゲーム紹介', digest: '3d3230fe7ca9228dd77ce53adce86b7ec90d64a9095f66f7df4c62ee09297475' },
  { id: 'cards', title: 'カード紹介', digest: 'b28c83b103875efa75d932eee5dd78178c924e5141f4f348949ee64a137f5a76' },
  { id: 'field', title: 'プレイエリア', digest: '092c6048444c7e1d07b54a70828eb6cf51582b4fd822c68b620bca2aade75eb4' },
  { id: 'preparation', title: 'ゲームの準備', digest: '6e6b655d47da800b378032e40eef2ae670c1a70e2e674d8091eb1b52ea93c092' },
  { id: 'victory', title: '勝利条件', digest: '47f5a9fd62876789c350a316b08ee48d7f9bbe3ac91b6b3314410b330ddb9bd3' },
  { id: 'states', title: 'カードの状態', digest: '5962d6880443013fe65a8191d1c3437ac2c5047ad9351af2649151a5a26cf4db' },
  { id: 'flow', title: 'ゲームの流れ', digest: '33d92ba0dad6eb8be9cdf83ed1872b9e1294f2507520aeed155bc07ad90250e2' },
  { id: 'references', title: '参考資料', digest: 'b60e7479764822f6c5c274ddb5ca9499d1bf78ebac20128b54522f06de25007f' },
];

const SIMULATION_STEPS = [
  { id: 'setup-1', title: '推しホロメンを選ぶ', digest: 'aee431b5ad69da5130a5d1b0124eda40a9ce47818cf7c704e75934e620b0c049' },
  { id: 'setup-2', title: 'デッキを用意する', digest: '3d3c2d538ab520fc23872916161ceaddd0ed6315eb610671a718db4d7cc7cc5d' },
  { id: 'setup-3', title: 'じゃんけんで先攻・後攻を決める', digest: '11ba0d93c5d4e4ba563a76be8b0dba7a8da9eefcac594f44c2dd58a875595409' },
  { id: 'reset-1', title: 'アクティブ状態に戻す', digest: 'eb2d2d9ddbdaf357023a9d447322fd9200f56d29d912f20c1c8701b519010041' },
  { id: 'draw-1', title: 'カードを1枚引く', digest: 'cb28825d42eac315000453d3fc35ad69834376ff677fa8dce1bd53806a094926' },
  { id: 'cheer-1', title: 'エールカードを公開する', digest: '1b32733db0bded617f4586c91398402e9de7cdba40e3bde4fbcbd9262edc7c54' },
  { id: 'main-1', title: 'ホロメンを登場させる', digest: '40055b32b4d567016daaeba414b2440731a29d47ef5b910387bbd52f8a2a8913' },
  { id: 'main-2', title: 'ブルームする', digest: '15ab9becf6ebde9beb225fe49e08bdd7dc75fa84af2f6ece639df132a6e8a5d3' },
  { id: 'main-3', title: 'サポートカードを使う', digest: '9d5b5c409ac439dbca29acc9bda25892a62dfb80e8872492baac9d32b6a38f0c' },
  { id: 'main-4', title: '推しスキルを使う', digest: 'f783cf6d3a1238cd364edeffe504fff8964e0bcd3c7388cdabebefeda7b96cf4' },
  { id: 'main-5', title: 'コラボする', digest: '3a8ea32cbe003ae0874d1bc4c8d0970e2f4e79691c543abe4337cd251ab82644' },
  { id: 'main-6', title: 'バトンタッチする', digest: '28ce71cc5f287b04cfc54fa8d9a4cda795b83fc17813c670eda4c3ec85f784df' },
  { id: 'performance-1', title: '攻撃対象を選ぶ', digest: '83c1e15bfc01f356df437b199968902ca8fa9ebdc5f86e46a32567f609ab54b1' },
  { id: 'performance-2', title: 'アーツを使う', digest: '1e4ca12e6e77b75930a631518e4af41bf4559ffb1ec463eed68818b5ce017217' },
  { id: 'performance-3', title: 'ダメージとダウンを確認する', digest: '4cf033419548949cb24f06fa0680c22f2006cc41f1dc56ad2a8bf5712c787a50' },
  { id: 'end-1', title: 'ターンを終える', digest: '0a887085f9888ea78ecf459b8c8aa036ea48408404a1d3639a6e632883d5e4d0' },
];

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
  const waitCollectionReady = () => page.waitForSelector(
    '[data-testid="collection-search"]', { visible: true, timeout: T });
  const localeDigest = async (selector) => {
    const snapshot = await page.$eval(selector, (node) => JSON.stringify({
      text: node.innerText.replace(/\s+/g, ' ').trim(),
      alts: [...node.querySelectorAll('[alt]')].map((item) => item.getAttribute('alt')),
      labels: [...node.querySelectorAll('[aria-label]')].map((item) => item.getAttribute('aria-label')),
    }));
    return createHash('sha256').update(snapshot).digest('hex');
  };
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

  await clickText('お気に入り');
  await waitCollectionReady();
  const japaneseCollectionSearch = await page.$eval('[data-testid="collection-search"]', (input) => ({
    placeholder: input.getAttribute('placeholder'),
    label: input.getAttribute('aria-label'),
  }));
  check(`${label}: Collection chrome is Japanese`,
    (await hasText('所持済み')) && japaneseCollectionSearch.placeholder === 'カード名・カード番号・版を検索'
      && japaneseCollectionSearch.label === 'コレクションのカードを検索' && !(await hasText('已擁有')),
    JSON.stringify(japaneseCollectionSearch));
  check(`${label}: Collection has no horizontal overflow`, await noOverflow());
  await shot('ja-collection');

  await clickText('デッキエディタ');
  await waitText('この端末だけに保存されるデッキです');
  check(`${label}: Deck Editor chrome is Japanese`,
    (await hasText('この端末だけに保存されるデッキです')) && !(await hasText('本地牌組')));
  check(`${label}: Deck Editor has no horizontal overflow`, await noOverflow());

  await clickText('ルールチュートリアル');
  await waitText('「共に創り、共に競う」');
  check(`${label}: Tutorial landing is Japanese`, !(await hasText('共同創造、共同競爭')));
  check(`${label}: Tutorial has no horizontal overflow`, await noOverflow());

  for (let index = 0; index < TUTORIAL_DETAILS.length; index += 1) {
    const detail = TUTORIAL_DETAILS[index];
    if (index > 0) {
      await page.reload({ waitUntil: 'networkidle0' });
      await waitText('大会月報');
      await clickText('ルールチュートリアル');
      await waitText('「共に創り、共に競う」');
    }
    await page.click(`[data-testid="tutorial-section-${detail.id}"]`);
    const selector = `[data-testid="tutorial-detail-content-${detail.id}"]`;
    await page.waitForSelector(selector, { timeout: T });
    await waitText(detail.title);
    const digest = await localeDigest(selector);
    check(`${label}: Japanese detail ${detail.id} matches the approved localized content`,
      digest === detail.digest, digest);
    check(`${label}: Japanese detail ${detail.id} has no horizontal overflow`, await noOverflow());
    if (detail.id === 'intro') await shot('ja-tutorial-detail');
    if (detail.id === 'references') await shot('ja-tutorial-detail-last');
  }

  await page.reload({ waitUntil: 'networkidle0' });
  await waitText('大会月報');
  await clickText('ルールチュートリアル');
  await waitText('「共に創り、共に競う」');
  await page.click('[data-testid="tutorial-simulation-entry"]');
  await waitText('手順に沿って対戦を体験しましょう');
  await page.waitForSelector('[data-testid="tutorial-simulation-content"]', { timeout: T });
  for (let index = 0; index < SIMULATION_STEPS.length; index += 1) {
    const step = SIMULATION_STEPS[index];
    const selector = `[data-testid="tutorial-simulation-step-${step.id}"]`;
    await page.waitForSelector(selector, { timeout: T });
    await waitText(step.title);
    const digest = await localeDigest('[data-testid="tutorial-simulation-content"]');
    check(`${label}: Japanese simulation ${step.id} matches the approved localized content`,
      digest === step.digest, digest);
    check(`${label}: Japanese simulation ${step.id} has no horizontal overflow`, await noOverflow());
    if (index === 0) await shot('ja-tutorial-simulation');
    if (index === SIMULATION_STEPS.length - 1) await shot('ja-tutorial-simulation-last');
    if (index < SIMULATION_STEPS.length - 1) await clickText('次へ →');
  }

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

  // DIC-1142: mobile shows a bar chart, desktop shows a donut. Assert the
  // right one is mounted for this viewport and the wrong one is absent.
  const chartPresence = await page.evaluate(() => ({
    bar: !!document.querySelector('[data-testid="observed-share-bar"]'),
    donut: !!document.querySelector('[data-testid="donut-chart"]'),
    barBadge: !!document.querySelector('[data-testid="chart-view-mobile"]'),
    donutBadge: !!document.querySelector('[data-testid="chart-view-desktop"]'),
  }));
  if (label === 'mobile') {
    check(`${label}: distribution renders the mobile bar chart (no donut)`,
      chartPresence.bar && !chartPresence.donut && chartPresence.barBadge,
      JSON.stringify(chartPresence));
  } else {
    check(`${label}: distribution renders the desktop donut (no bar)`,
      chartPresence.donut && !chartPresence.bar && chartPresence.donutBadge,
      JSON.stringify(chartPresence));
  }

  // DIC-1142: representative cards block is present with a testID row per card.
  const representativeCardCount = await page.evaluate(() =>
    document.querySelectorAll('[data-testid^="representative-"]').length);
  check(`${label}: representative-cards block renders at least one card`,
    representativeCardCount >= 1, `count=${representativeCardCount}`);

  // DIC-1142 CR §1: representative cards must display a card name, not just the
  // raw cardNumber. Every row's first line must be non-empty and different from
  // the cardNumber pattern (`hBP…-###`).
  const representativeNames = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="representative-"]')].map((row) => {
      const number = row.getAttribute('data-testid').replace('representative-', '');
      const texts = [...row.querySelectorAll('div, span')]
        .map((n) => (n.textContent || '').trim()).filter(Boolean);
      // The name is the first text that is not the cardNumber and not the raw zone label.
      const name = texts.find((tx) => tx && !tx.startsWith(number)) || null;
      return { number, name };
    }));
  check(`${label}: every representative-card row shows a real name (not just cardNumber)`,
    representativeNames.length > 0 && representativeNames.every((r) => r.name && r.name !== r.number),
    JSON.stringify(representativeNames.slice(0, 3)));

  // DIC-1142 CR §2: at least one 熱門牌型 chip must expose a champion/top-placement
  // tag once the fixture has published ranks. Chip text should contain the
  // language-appropriate champion marker or 上位 count.
  const archetypeChipTexts = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="summary-archetype-"]')].map((chip) => chip.textContent.trim()));
  const jaChampion = /優勝\s*\d+/;
  const zhChampion = /冠軍\s*\d+/;
  const topPlace = /上位\s*\d+/;
  const hasPlacement = archetypeChipTexts.some((tx) => jaChampion.test(tx) || zhChampion.test(tx) || topPlace.test(tx));
  check(`${label}: at least one archetype chip shows champion or top-placement count`,
    hasPlacement, JSON.stringify(archetypeChipTexts));

  // DIC-1142 CR §3: ja mode must not carry the CN runtime coverage/source
  // strings that live in the fixture JSON. This is language-dependent — the
  // JA block runs before the language switch, and the ZH block runs after.
  const CN_MARKERS = ['資料僅來自', '本月僅收錄', '官方於 X 公布', '牌組卡表已透過'];
  const bodyText = await text();
  const leaked = CN_MARKERS.filter((m) => bodyText.includes(m));
  check(`${label}: ja Tournament report body carries no CN coverage/source strings`,
    leaked.length === 0, leaked.join(','));

  // DIC-1142: at least one event card has a highlights block.
  const highlightCount = await page.evaluate(() =>
    document.querySelectorAll('[data-testid^="event-highlights-"]').length);
  check(`${label}: at least one event exposes a highlights block`,
    highlightCount >= 1, `count=${highlightCount}`);

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

  await clickText('收藏');
  await waitCollectionReady();
  const chineseCollectionSearch = await page.$eval('[data-testid="collection-search"]', (input) => ({
    placeholder: input.getAttribute('placeholder'),
    label: input.getAttribute('aria-label'),
  }));
  check(`${label}: Chinese Collection remains available`,
    (await hasText('已擁有')) && chineseCollectionSearch.placeholder === '搜尋卡名、卡號或版本'
      && chineseCollectionSearch.label === '搜尋收藏卡片' && !(await hasText('所持済み')),
    JSON.stringify(chineseCollectionSearch));
  check(`${label}: Chinese Collection has no horizontal overflow`, await noOverflow());
  await shot('zh-collection');

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
