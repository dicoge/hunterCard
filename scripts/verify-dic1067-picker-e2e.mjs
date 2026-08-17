#!/usr/bin/env node
// DIC-1067 browser E2E — drives a real build of the visual card picker at both
// the desktop and the 390px mobile viewport.
//
// The acceptance this asserts end to end:
//   • a deck is built by LOOKING at cards: the card-number search mode is never
//     selected and the search box is never typed into
//   • zone tabs stay visible with live progress while the grid scrolls
//   • clicking a card adds one copy; the grid badge and the zone progress agree
//   • the deck saves, survives a reload, and reopens with the same contents
//   • 390px renders at least two columns, keeps tap targets >= 44px and does not
//     overflow horizontally
//   • the copy retired by DIC-1067 §9 appears nowhere
//
// Usage: npm run build && node scripts/verify-dic1067-picker-e2e.mjs
// Against a deployed origin: E2E_ORIGIN=https://holohunter.dicoge.com node ...
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const PORT = 4179;
const ORIGIN = process.env.E2E_ORIGIN || `http://localhost:${PORT}`;
const OUT = process.env.SHOT_DIR || path.resolve('e2e-shots');
const DB_TIMEOUT = 180000;

// The retired explanatory copy of DIC-1067 §9. A player building a deck by
// looking at cards must never be lectured about how a printing was chosen.
const RETIRED_COPY = [
  '來源未指定版本，已使用最低普通版本估價',
  '每個卡號只顯示一列',
  '預設低配版本',
  '編輯中不中斷提示',
  '不使用「店家收購價」估算缺卡成本',
  '不採用店家收購價',
  '張未指定版本',
];

let server = null;
if (!process.env.E2E_ORIGIN) {
  const dist = path.resolve('dist');
  assert.ok(fs.existsSync(dist), 'run `npm run build` before this script');
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json',
  };
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dist, url);
    if (!file.startsWith(dist)) file = path.join(dist, 'index.html');
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(PORT, r));
}

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
});

// Production sits behind Vercel's bot challenge, which interposes its own page
// before the app ever mounts. Every navigation has to ride that out.
const settle = (page) => page.waitForFunction(
  () => !document.title.includes('Security Checkpoint'), { timeout: 120000 },
);

let passed = 0;
const failures = [];
function check(label, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (e) {
    failures.push(`${label}: ${e.message}`);
    console.log(`  ✗ ${label}\n      ${e.message}`);
  }
}

async function run(label, viewport) {
  console.log(`\n[${label}] ${viewport.width}x${viewport.height}`);
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const shot = (n) => page.screenshot({ path: path.join(OUT, `dic1067-${label}-${n}.png`), fullPage: false });
  const text = () => page.evaluate(() => document.body.innerText);
  const sel = (s) => page.$(s);
  const tap = async (s) => {
    const el = await page.waitForSelector(s, { timeout: DB_TIMEOUT });
    await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
    try {
      await el.click();
    } catch {
      await el.evaluate((n) => n.click());
    }
  };
  const clickText = async (t) => {
    const handle = await page.evaluateHandle((x) => {
      const el = [...document.querySelectorAll('div,span,button')]
        .reverse().find((n) => n.textContent.trim() === x) || null;
      el?.scrollIntoView({ block: 'center' });
      return el;
    }, t);
    const el = handle.asElement();
    if (!el) throw new Error(`no clickable element with text "${t}"`);
    try {
      await el.click();
    } catch {
      await el.evaluate((n) => n.click());
    }
  };
  const progress = (zone) => page.$eval(`[data-testid="deck-zone-progress-${zone}"]`, (n) => n.innerText.trim());
  const readDeck = () => page.evaluate(() => {
    const raw = localStorage.getItem('hunterCard-decks');
    if (!raw) return null;
    const { state } = JSON.parse(raw);
    const d = state.decks[0];
    if (!d) return null;
    const zone = (z) => (d[z] ?? []).map((s) => [s.card.id, s.qty]);
    return { name: d.name, oshi: zone('oshi'), main: zone('main'), yell: zone('yell') };
  });

  async function enterEditor() {
    await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
      || document.body.innerText.includes('牌組編輯器'), { timeout: DB_TIMEOUT });
    if ((await text()).includes('以訪客身份進入')) await clickText('以訪客身份進入');
    await page.waitForFunction(() => document.body.innerText.includes('牌組編輯器'), { timeout: DB_TIMEOUT });
    await clickText('牌組編輯器');
    await page.waitForFunction(() => document.body.innerText.includes('本地牌組')
      || document.body.innerText.includes('完成組牌'), { timeout: DB_TIMEOUT });
  }
  // The editor mounts long before the ~10MB catalog streams in; the grid is only
  // meaningful once the estimate panel (which needs the price index) exists.
  const waitForCatalog = () => page.waitForSelector('[data-testid="card-picker-grid"] [data-testid^="card-cell-"]', { timeout: DB_TIMEOUT });

  // ── Fresh session ────────────────────────────────────────────────────────
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: DB_TIMEOUT });
  await settle(page);
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: DB_TIMEOUT });
  await settle(page);
  await enterEditor();
  await page.type('input[placeholder="新牌組名稱"]', `DIC-1067 ${label}`);
  await clickText('建立');
  await page.waitForSelector('[data-testid="deck-zone-tabs"]', { timeout: DB_TIMEOUT });
  await waitForCatalog();
  await shot('01-oshi-tab');

  // ── 1. Zone tabs with live progress ──────────────────────────────────────
  const tabsPresent = await page.evaluate(() => ['oshi', 'main', 'yell']
    .every((z) => !!document.querySelector(`[data-testid="deck-zone-tab-${z}"]`)));
  check('三個區域分頁都在畫面上', () => assert.ok(tabsPresent));
  const oshi0 = await progress('oshi');
  const main0 = await progress('main');
  const yell0 = await progress('yell');
  check('分頁進度顯示 0/目標', () => {
    assert.equal(oshi0, '0/1');
    assert.equal(main0, '0/50');
    assert.equal(yell0, '0/20');
  });

  // ── 2. Build a deck by LOOKING at cards only ─────────────────────────────
  // Nothing is ever typed into the search box and the 卡號 mode is never chosen.
  const firstCell = () => page.evaluate(() => {
    const cell = document.querySelector('[data-testid="card-picker-grid"] [data-testid^="card-cell-"]');
    return cell ? cell.getAttribute('data-testid').replace('card-cell-', '') : null;
  });

  const oshiNumber = await firstCell();
  await tap(`[data-testid="card-cell-${oshiNumber}"]`);
  const oshiAdded = await page.waitForFunction(() => document.querySelector('[data-testid="deck-zone-progress-oshi"]')?.innerText.trim() === '1/1', { timeout: 20000 }).then(() => true, () => false);
  check('點一張推し卡圖就加入牌組，進度變 1/1', () => assert.ok(oshiAdded));
  const oshiBadge = await page.$eval(`[data-testid="card-qty-${oshiNumber}"]`, (n) => n.innerText.trim());
  check('選取的卡片顯示張數徽章', () => assert.equal(oshiBadge, '1'));
  await shot('02-oshi-selected');

  // 主牌組: fill 50 by clicking card art. The rules engine caps a card number at
  // 4 copies, so this walks across cells exactly the way a player would.
  await tap('[data-testid="deck-zone-tab-main"]');
  await waitForCatalog();
  const mainNumbers = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card-picker-grid"] [data-testid^="card-cell-"]')]
    .map((n) => n.getAttribute('data-testid').replace('card-cell-', '')));
  check('主牌組分頁提供多張可點選的卡片', () => assert.ok(mainNumbers.length >= 13, `only ${mainNumbers.length} cells`));

  let added = 0;
  for (const n of mainNumbers) {
    if (added >= 50) break;
    for (let i = 0; i < 4 && added < 50; i += 1) {
      await tap(`[data-testid="card-cell-${n}"]`);
      const now = await progress('main');
      const value = Number(now.split('/')[0]);
      if (value === added) break; // the 4-copy limit rejected this click
      added = value;
    }
  }
  const mainProgress = await progress('main');
  check('只用點卡圖就把主牌組填到 50 張', () => assert.equal(mainProgress, '50/50'));
  await shot('03-main-filled');

  // エール
  await tap('[data-testid="deck-zone-tab-yell"]');
  await waitForCatalog();
  const yellNumbers = await page.evaluate(() => [...document.querySelectorAll('[data-testid="card-picker-grid"] [data-testid^="card-cell-"]')]
    .map((n) => n.getAttribute('data-testid').replace('card-cell-', '')));
  let yellAdded = 0;
  for (const n of yellNumbers) {
    if (yellAdded >= 20) break;
    for (let i = 0; i < 20 && yellAdded < 20; i += 1) {
      await tap(`[data-testid="card-cell-${n}"]`);
      const value = Number((await progress('yell')).split('/')[0]);
      if (value === yellAdded) break;
      yellAdded = value;
    }
  }
  const yellProgress = await progress('yell');
  check('只用點卡圖就把エール填到 20 張', () => assert.equal(yellProgress, '20/20'));
  await shot('04-yell-filled');

  // ── 3. The search box was never used ─────────────────────────────────────
  const searchState = await page.evaluate(() => {
    const input = document.querySelector('[data-testid="card-search-input"]');
    const numberMode = document.querySelector('[data-testid="search-mode-number"]');
    return {
      query: input ? input.value : null,
      numberSelected: numberMode ? numberMode.getAttribute('aria-selected') === 'true' : null,
    };
  });
  check('全程沒有輸入卡號，也沒有切到卡號搜尋模式', () => {
    if (searchState.query !== null) assert.equal(searchState.query, '');
    if (searchState.numberSelected !== null) assert.equal(searchState.numberSelected, false);
  });

  // ── 4. Selected-card controls: increment, decrement, remove ──────────────
  const slotNumber = await page.evaluate(() => {
    const row = document.querySelector('[data-testid^="deck-slot-"]');
    return row ? row.getAttribute('data-testid').replace('deck-slot-', '') : null;
  });
  check('已選卡片區列出這個分頁的卡片', () => assert.ok(slotNumber, 'no deck slot rendered'));
  if (slotNumber) {
    await tap(`[data-testid="deck-slot-dec-${slotNumber}"]`);
    const afterDec = Number((await progress('yell')).split('/')[0]);
    check('－ 會減少一張', () => assert.equal(afterDec, 19));
    await tap(`[data-testid="deck-slot-inc-${slotNumber}"]`);
    const afterInc = Number((await progress('yell')).split('/')[0]);
    check('＋ 會加回一張', () => assert.equal(afterInc, 20));
  }

  // ── 5. Filters narrow the grid and the count follows ─────────────────────
  await tap('[data-testid="deck-zone-tab-main"]');
  await waitForCatalog();
  if (await sel('[data-testid="open-filters"]')) await tap('[data-testid="open-filters"]');

  // Every search surface must be reachable at this viewport — on a phone that
  // means inside the drawer, with 卡片名稱 the default and 卡號 merely available.
  const searchUi = await page.evaluate(() => {
    const box = (s) => {
      const n = document.querySelector(s);
      if (!n) return null;
      const r = n.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), selected: n.getAttribute('aria-selected') };
    };
    return {
      input: box('[data-testid="card-search-input"]'),
      name: box('[data-testid="search-mode-name"]'),
      text: box('[data-testid="search-mode-text"]'),
      number: box('[data-testid="search-mode-number"]'),
      categories: [...document.querySelectorAll('[data-testid^="filter-category-"]')]
        .map((n) => n.getAttribute('data-testid')),
    };
  });
  check('搜尋框與三種搜尋模式在這個視窗都取得到', () => {
    for (const [k, v] of Object.entries(searchUi)) {
      if (k === 'categories') continue;
      assert.ok(v && v.w > 0 && v.h >= 44, `${k} is missing or under 44px: ${JSON.stringify(v)}`);
    }
  });
  check('主牌組提供 ホロメン／サポート 卡片種類篩選', () => assert.deepEqual(
    searchUi.categories.sort(), ['filter-category-holomen', 'filter-category-support'],
  ));

  await shot('05a-filters-top');
  const countBefore = await page.$eval('[data-testid="card-result-count"]', (n) => parseInt(n.innerText, 10));
  const colorChip = await page.evaluate(() => {
    const chip = document.querySelector('[data-testid^="filter-color-"]');
    return chip ? chip.getAttribute('data-testid') : null;
  });
  check('顏色篩選有真實的選項', () => assert.ok(colorChip, 'no colour filter offered'));
  if (colorChip) {
    await tap(`[data-testid="${colorChip}"]`);
    const countAfter = await page.$eval('[data-testid="card-result-count"]', (n) => parseInt(n.innerText, 10));
    check('篩選後結果數量下降且仍有卡片', () => {
      assert.ok(countAfter > 0, 'colour filter produced an empty grid');
      assert.ok(countAfter < countBefore, `count did not narrow (${countBefore} → ${countAfter})`);
    });
    await tap('[data-testid="filter-reset"]');
    const countReset = await page.$eval('[data-testid="card-result-count"]', (n) => parseInt(n.innerText, 10));
    check('清除全部還原結果數量', () => assert.equal(countReset, countBefore));
  }
  await shot('05-filters');
  if (await sel('[data-testid="close-filters"]')) await tap('[data-testid="close-filters"]');

  // ── 6. Layout at this viewport ───────────────────────────────────────────
  const layout = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('[data-testid="card-picker-grid"] [data-testid^="card-cell-"]')];
    const tops = new Map();
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      const key = Math.round(r.top);
      tops.set(key, (tops.get(key) ?? 0) + 1);
    }
    const columns = Math.max(0, ...tops.values());
    const tabs = document.querySelector('[data-testid="deck-zone-tabs"]');
    const tabRect = tabs ? tabs.getBoundingClientRect() : null;
    const targets = [...document.querySelectorAll('[data-testid^="deck-zone-tab-"],[data-testid^="search-mode-"],[data-testid^="deck-slot-inc-"],[data-testid^="deck-slot-dec-"],[data-testid="open-filters"]')]
      .map((n) => ({ id: n.getAttribute('data-testid'), h: Math.round(n.getBoundingClientRect().height) }))
      .filter((t) => t.h > 0);
    return {
      columns,
      cells: cells.length,
      tabsVisible: !!tabRect && tabRect.top < window.innerHeight && tabRect.bottom > 0,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      smallTargets: targets.filter((t) => t.h < 44),
    };
  });
  check('卡片格線至少兩欄', () => assert.ok(layout.columns >= 2, `only ${layout.columns} column(s)`));
  check('區域分頁與進度保持可見', () => assert.ok(layout.tabsVisible));
  check('沒有水平溢出', () => assert.ok(layout.overflow <= 1, `scrollWidth exceeds viewport by ${layout.overflow}px`));
  check('主要點擊目標至少 44px', () => assert.deepEqual(layout.smallTargets, []));
  check('格線沒有一次渲染整個卡表', () => assert.ok(layout.cells <= 120, `${layout.cells} cells rendered at once`));

  // ── 7. Retired copy is gone ──────────────────────────────────────────────
  const body = await text();
  for (const copy of RETIRED_COPY) {
    check(`已下架文案不再出現：${copy}`, () => assert.ok(!body.includes(copy)));
  }

  // ── 8. Save, reload, reopen ──────────────────────────────────────────────
  const before = await readDeck();
  check('牌組已寫入本機儲存', () => {
    assert.ok(before, 'nothing persisted');
    assert.equal(before.oshi.reduce((a, [, q]) => a + q, 0), 1);
    assert.equal(before.main.reduce((a, [, q]) => a + q, 0), 50);
    assert.equal(before.yell.reduce((a, [, q]) => a + q, 0), 20);
  });

  await page.reload({ waitUntil: 'domcontentloaded', timeout: DB_TIMEOUT });
  await settle(page);
  await enterEditor();
  await page.waitForSelector('[data-testid="deck-zone-tabs"]', { timeout: DB_TIMEOUT });
  await waitForCatalog();
  const after = await readDeck();
  check('重新載入後牌組內容一字不差', () => assert.deepEqual(after, before));
  const reloadProgress = {
    oshi: await progress('oshi'), main: await progress('main'), yell: await progress('yell'),
  };
  check('重新開啟後進度顯示完成的牌組', () => assert.deepEqual(reloadProgress, { oshi: '1/1', main: '50/50', yell: '20/20' }));
  await shot('06-reloaded');

  // ── 9. Validation only happens on 完成組牌 ────────────────────────────────
  const sheetBeforeFinalize = await sel('[data-testid="deck-finalize-sheet"]');
  check('編輯過程沒有跳出完整規則視窗', () => assert.equal(sheetBeforeFinalize, null));
  await clickText('完成組牌');
  await page.waitForSelector('[data-testid="deck-finalize-sheet"]', { timeout: 20000 });
  const finalizeText = await page.$eval('[data-testid="deck-finalize-sheet"]', (n) => n.innerText);
  check('完成組牌才做集中驗證，且這副牌合法', () => assert.ok(
    finalizeText.includes('組牌完成'), `finalize said: ${finalizeText.replace(/\n/g, ' | ')}`,
  ));
  await shot('07-finalize');

  check('沒有未預期的 JavaScript 錯誤', () => assert.deepEqual(
    pageErrors.filter((e) => !/ResizeObserver/.test(e)), [],
  ));

  await page.close();
}

try {
  await run('desktop', { width: 1280, height: 900 });
  await run('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
} finally {
  await browser.close();
  if (server) server.close();
}

console.log(`\nDIC-1067 picker E2E: ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
