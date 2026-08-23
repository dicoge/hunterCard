#!/usr/bin/env node
/**
 * DIC-1117 production E2E — the deck picker's 卡號系列 filter, in a real browser.
 *
 * Reproduces the production report exactly: open the deck editor, select the
 * hBP04 series chip, and read back the rendered grid. The regression showed 101
 * results led by hBP04-088 / hBP02-084 / hSD01-017 / hBP04-096; this asserts the
 * grid now contains ONLY hBP04-### card numbers, in ascending numeric order,
 * with the displayed count equal to the unique card-number count.
 *
 * Runs at the desktop viewport and the canonical 390px phone viewport, and
 * writes a screenshot per viewport as the completion evidence.
 *
 * Usage: node scripts/verify-dic1117-production-e2e.mjs
 * Against a local build: E2E_ORIGIN=http://localhost:4179 node scripts/...
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const ORIGIN = process.env.E2E_ORIGIN || 'https://holohunter.dicoge.com';
const OUT = process.env.SHOT_DIR || path.resolve('e2e-shots');
const TIMEOUT = 180000;
const SERIES = process.env.DIC1117_SERIES || 'hBP04';

fs.mkdirSync(OUT, { recursive: true });
const browser = await puppeteer.launch({
  headless: 'new',
  args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
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
  console.log(`\n[${label}] ${viewport.width}x${viewport.height} — ${ORIGIN}`);
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  const shot = (n) => page.screenshot({ path: path.join(OUT, `dic1117-${label}-${n}.png`), fullPage: false });
  const text = () => page.evaluate(() => document.body.innerText);
  const tap = async (selector) => {
    const el = await page.waitForSelector(selector, { timeout: TIMEOUT });
    await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
    try {
      await el.click();
    } catch {
      await el.evaluate((n) => n.click());
    }
  };
  const clickText = async (target) => {
    const handle = await page.evaluateHandle((x) => {
      const el = [...document.querySelectorAll('div,span,button')]
        .reverse().find((n) => n.textContent.trim() === x) || null;
      el?.scrollIntoView({ block: 'center' });
      return el;
    }, target);
    const el = handle.asElement();
    if (!el) throw new Error(`no clickable element with text "${target}"`);
    try {
      await el.click();
    } catch {
      await el.evaluate((n) => n.click());
    }
  };

  async function enterEditor() {
    await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
      || document.body.innerText.includes('牌組編輯器'), { timeout: TIMEOUT });
    if ((await text()).includes('以訪客身份進入')) await clickText('以訪客身份進入');
    await page.waitForFunction(
      () => document.body.innerText.includes('牌組編輯器'), { timeout: TIMEOUT },
    );
    await clickText('牌組編輯器');
    await page.waitForFunction(() => document.body.innerText.includes('本地牌組')
      || document.body.innerText.includes('完成組牌'), { timeout: TIMEOUT });
  }

  // The editor mounts long before the ~10MB catalog streams in; the grid is only
  // meaningful once real card cells exist.
  const waitForCatalog = () => page.waitForSelector(
    '[data-testid="card-picker-grid"] [data-testid^="card-cell-"]', { timeout: TIMEOUT },
  );

  // The grid is virtualized AND paged: cells outside the window are unmounted and
  // only 60 results are mounted per page, so no single DOM read sees the whole
  // result. This rewinds to the top and walks down in overlapping steps, keeping
  // every batch that was mounted along the way. Each batch is ordered on its own
  // and the union must add up to the displayed count — a card number the player
  // can scroll to but that the first page hid still gets audited.
  async function scanGrid() {
    const batches = [];
    const seen = new Set();
    let total = null;

    const read = () => page.evaluate(() => {
      const grid = document.querySelector('[data-testid="card-picker-grid"]');
      const cells = [...(grid?.querySelectorAll('[data-testid^="card-cell-"]') ?? [])];
      const footer = grid?.innerText.match(/（(\d+)\s*\/\s*(\d+)）/);
      return {
        numbers: cells.map((n) => n.getAttribute('data-testid').replace('card-cell-', '')),
        loaded: footer ? Number(footer[1]) : null,
        total: footer ? Number(footer[2]) : null,
        atEnd: grid ? grid.scrollTop + grid.clientHeight >= grid.scrollHeight - 2 : true,
      };
    });

    // Earlier taps scroll elements into view, so the grid may already be part
    // way down. Every scan starts from the real first result.
    await page.evaluate(() => {
      const grid = document.querySelector('[data-testid="card-picker-grid"]');
      if (grid) grid.scrollTop = 0;
      window.scrollTo(0, 0);
    });
    await new Promise((r) => setTimeout(r, 600));

    for (let i = 0; i < 120; i += 1) {
      const step = await read();
      if (step.numbers.length > 0) {
        batches.push(step.numbers);
        for (const n of step.numbers) seen.add(n);
      }
      if (step.total !== null) total = step.total;
      const complete = total !== null && seen.size >= total;
      if (complete && step.atEnd) break;
      // Overlapping steps: never jump a whole window, or a row that mounts and
      // unmounts between two reads would go unaudited.
      await page.evaluate(() => {
        const grid = document.querySelector('[data-testid="card-picker-grid"]');
        if (grid) grid.scrollTop += Math.max(120, grid.clientHeight * 0.6);
      });
      await new Promise((r) => setTimeout(r, 320));
    }
    return { batches, seen: [...seen], total };
  }

  const displayedCount = () => page.evaluate(() => {
    const node = document.querySelector('[data-testid="card-result-count"]')
      || document.querySelector('[data-testid="card-result-count-mobile"]');
    return Number(node?.innerText.match(/\d+/)?.[0] ?? -1);
  });

  // ── Fresh session, new deck ──────────────────────────────────────────────
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await settle(page);
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await settle(page);
  await enterEditor();
  await page.type('input[placeholder="新牌組名稱"]', `DIC-1117 ${label}`);
  await clickText('建立');
  // The phone layout swaps the desktop zone tabs for its own panel switch.
  const isPhone = viewport.width <= 480;
  await page.waitForSelector(
    isPhone ? '[data-testid="deck-mobile-panel-switch"]' : '[data-testid="deck-zone-tabs"]',
    { timeout: TIMEOUT },
  );
  await waitForCatalog();

  // The regression was reported on 主牌組, the tab with the most card numbers.
  await tap(isPhone ? '[data-testid="deck-mobile-panel-main"]' : '[data-testid="deck-zone-tab-main"]');
  if (isPhone) await tap('[data-testid="deck-mobile-panel-picker"]');
  await waitForCatalog();

  // ── 1. The series filter is labelled as a card-number filter ─────────────
  const openFilters = await page.$('[data-testid="open-filters"]');
  if (openFilters) {
    await tap('[data-testid="open-filters"]');
    await page.waitForSelector('[data-testid="filter-sheet"]', { timeout: TIMEOUT });
  }
  const panelText = await page.evaluate(() => (
    document.querySelector('[data-testid="filter-sheet"]')
    || document.querySelector('[data-testid="card-filter-panel"]')
  )?.innerText ?? '');
  check('篩選標籤說明這是卡號系列，而不是商品／來源', () => {
    assert.ok(panelText.includes('卡號系列'), `panel said: ${panelText.split('\n').slice(0, 12).join(' | ')}`);
    assert.ok(!panelText.includes('商品／系列'), '舊的商品／系列標籤仍然出現');
  });
  await shot('01-filters');

  // ── 2. Select the series chip ────────────────────────────────────────────
  const chip = `[data-testid="filter-series-${SERIES}"]`;
  const chipExists = await page.$(chip);
  // A missing chip means the deployed build predates the card-number series
  // filter; fail here rather than burning the selector timeout on every check.
  if (!chipExists) {
    failures.push(`${SERIES} 系列 chip 不存在（部署的版本沒有卡號系列篩選）: ${chip}`);
    console.log(`  ✗ ${SERIES} 系列 chip 存在\n      missing ${chip}`);
    await page.close();
    return;
  }
  passed += 1;
  console.log(`  ✓ ${SERIES} 系列 chip 存在`);
  await tap(chip);
  const shown = await displayedCount();
  if (openFilters) {
    await tap('[data-testid="close-filters"]');
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="filter-sheet"]'), { timeout: 20000 },
    );
  }
  await waitForCatalog();
  await shot('02-series-selected');

  // ── 3. Only this series' card numbers are rendered ───────────────────────
  const { batches, seen: rendered, total } = await scanGrid();
  const exact = new RegExp(`^${SERIES}-\\d+$`, 'i');
  check(`格線只有 ${SERIES}-### 卡號`, () => {
    assert.ok(rendered.length > 0, 'grid rendered no cards');
    const strays = rendered.filter((n) => !exact.test(n));
    assert.deepEqual(strays, [], `混入了非 ${SERIES} 卡號：${strays.join(', ')}`);
  });
  check('production 報告的混入卡號都不在格線裡', () => {
    for (const stray of ['hBP02-084', 'hSD01-017', 'hY01-006']) {
      assert.ok(!rendered.includes(stray), `${stray} 仍出現在 ${SERIES} 選擇中`);
    }
  });

  // ── 4. Ascending numeric order ───────────────────────────────────────────
  const suffix = (n) => Number(n.split('-')[1]);
  check('每一批渲染出來的卡號都依數字遞增', () => {
    for (const batch of batches) {
      for (let i = 1; i < batch.length; i += 1) {
        assert.ok(
          suffix(batch[i]) > suffix(batch[i - 1]),
          `順序在 ${batch[i - 1]} → ${batch[i]} 處不是遞增`,
        );
      }
    }
  });
  check('整份結果串起來也是嚴格遞增', () => {
    const all = rendered.map(suffix);
    for (let i = 1; i < all.length; i += 1) {
      assert.ok(all[i] > all[i - 1], `順序在 ${rendered[i - 1]} → ${rendered[i]} 處不是遞增`);
    }
  });
  // The open tab is 主牌組, so this series' oshi card numbers (hBP04-001…007)
  // are legitimately absent; the first tile must be the smallest number the tab
  // actually offers, which is what the regression got wrong by leading with -088.
  check('首張是這個分頁裡編號最小的卡', () => assert.equal(
    batches[0][0], rendered.reduce((a, b) => (suffix(b) < suffix(a) ? b : a)),
    `首張是 ${batches[0][0]}`,
  ));
  check('首張不是回歸報告中的 hBP04-088', () => assert.notEqual(batches[0][0], 'hBP04-088'));

  // ── 5. No duplicate tile, and the count is the truth ─────────────────────
  check('同一卡號在任何一批裡都只有一個格子', () => {
    for (const batch of batches) {
      assert.equal(
        new Set(batch).size, batch.length,
        `重複卡號：${batch.filter((n, i) => batch.indexOf(n) !== i).join(', ')}`,
      );
    }
  });
  check('顯示的張數等於格線宣告的結果總數', () => {
    assert.ok(total !== null, '格線沒有回報結果總數');
    assert.equal(shown, total, `篩選面板顯示 ${shown} 張，格線總數為 ${total}`);
  });
  check('捲到底後看過的唯一卡號數等於顯示的張數', () => assert.equal(
    rendered.length, shown,
    `捲動看過 ${rendered.length} 個唯一卡號，但顯示 ${shown} 張`,
  ));
  check('張數不再是回歸時的 101', () => assert.notEqual(
    shown, 101, '張數仍是回歸報告中被轉載列膨脹的 101',
  ));

  if (isPhone) {
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    check('390px 沒有水平溢出', () => assert.ok(overflow <= 1, `overflow ${overflow}px`));
  }

  check('沒有未預期的 JavaScript 錯誤', () => assert.deepEqual(
    pageErrors.filter((e) => !/ResizeObserver/.test(e)), [],
  ));

  console.log(`  → ${SERIES}: ${rendered.length} cards, ${rendered.slice(0, 6).join(' ')} … ${rendered.slice(-3).join(' ')}`);
  await page.close();
}

try {
  await run('desktop', { width: 1280, height: 900 });
  await run('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
} finally {
  await browser.close();
}

console.log(`\nDIC-1117 production E2E: ${passed} checks passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.log(`  ✗ ${f}`);
  process.exit(1);
}
