#!/usr/bin/env node
import assert from 'node:assert/strict';
import puppeteer from 'puppeteer';

const ORIGIN = process.env.DIC1086_URL || 'https://holohunter.dicoge.com';
const TIMEOUT = 90_000;
const CARD_NUMBER = 'hBP04-005';
const PRINTING = 'BASE';
const OWNERSHIP_KEY = `${CARD_NUMBER}|${PRINTING}`;

const browser = await puppeteer.launch({
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
});

async function clickText(page, text) {
  const found = await page.evaluate((target) => {
    const matches = [...document.querySelectorAll('div,span,button')]
      .filter((candidate) => candidate.textContent?.trim() === target);
    const node = matches.find((candidate) => {
      const rect = candidate.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }) || matches.at(-1);
    if (!node) return false;
    node.click();
    return true;
  }, text);
  assert.ok(found, `missing clickable text: ${text}`);
}

async function clickTestId(page, testID) {
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-testid="${id}"]`),
    { timeout: TIMEOUT },
    testID,
  );
  await page.evaluate((id) => {
    document.querySelector(`[data-testid="${id}"]`)?.click();
  }, testID);
}

async function enterGuest(page) {
  await page.waitForFunction(
    () => document.body.innerText.includes('以訪客身份進入') || document.body.innerText.includes('首頁'),
    { timeout: TIMEOUT },
  );
  if ((await page.evaluate(() => document.body.innerText)).includes('以訪客身份進入')) {
    await clickText(page, '以訪客身份進入');
  }
}

async function navigate(page, label) {
  const menu = await page.$('[aria-label="Open navigation menu"]');
  if (menu) await menu.click();
  await page.waitForFunction((text) => document.body.innerText.includes(text), { timeout: TIMEOUT }, label);
  await clickText(page, label);
}

async function addCollectionCard(page) {
  await navigate(page, '收藏');
  await page.waitForSelector('[data-testid="collection-search"]', { timeout: TIMEOUT });
  await page.type('[data-testid="collection-search"]', CARD_NUMBER);
  await clickTestId(page, `collection-inc-${OWNERSHIP_KEY}`);
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="collection-qty-${id}"]`)?.textContent?.trim() === '1',
    { timeout: TIMEOUT },
    OWNERSHIP_KEY,
  );
}

async function seedImportedDeck(page) {
  await page.evaluate(({ cardNumber, printing, ownershipKey }) => {
    const raw = localStorage.getItem('hunterCard-decks');
    const persisted = raw ? JSON.parse(raw) : { state: {}, version: 1 };
    persisted.version = 1;
    persisted.state = {
      ...(persisted.state || {}),
      activeDeckId: 'dic1086-e2e',
      collection: { ...((persisted.state || {}).collection || {}), [ownershipKey]: 1 },
      decks: [{
        id: 'dic1086-e2e',
        name: 'DIC-1086 E2E',
        updatedAt: new Date().toISOString(),
        oshi: [],
        main: [{
          qty: 2,
          card: {
            id: `${cardNumber}#${printing}`,
            cardNumber,
            name: cardNumber,
            printing,
            printingLabel: printing,
            series: 'hBP04',
            cardTypeJp: 'ホロメン',
          },
        }],
        yell: [],
        origin: {
          kind: 'tournament',
          eventId: 'dic1086',
          eventName: 'DIC-1086 E2E',
          sourceDeckId: 'dic1086',
          decklogCode: null,
          sourceUrl: 'https://example.invalid/dic1086',
          importedAt: new Date().toISOString(),
        },
      }],
    };
    localStorage.setItem('hunterCard-decks', JSON.stringify(persisted));
  }, { cardNumber: CARD_NUMBER, printing: PRINTING, ownershipKey: OWNERSHIP_KEY });
}

async function assertCollectionPersists(page) {
  await navigate(page, '收藏');
  await page.waitForSelector('[data-testid="collection-search"]', { timeout: TIMEOUT });
  await page.type('[data-testid="collection-search"]', CARD_NUMBER);
  await page.waitForFunction(
    (id) => document.querySelector(`[data-testid="collection-qty-${id}"]`)?.textContent?.trim() === '1',
    { timeout: TIMEOUT },
    OWNERSHIP_KEY,
  );
}

async function waitDeckEditorReady(page, phone) {
  if (phone) {
    await page.waitForSelector('[data-testid="deck-mobile-panel-switch"]', { visible: true, timeout: TIMEOUT });
    await page.waitForSelector('[data-testid="deck-phone-progress"]', { visible: true, timeout: TIMEOUT });
    return;
  }
  await page.waitForSelector('[data-testid="deck-zone-tabs"]', { visible: true, timeout: TIMEOUT });
}

async function run(viewport, phone) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.goto(ORIGIN, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await enterGuest(page);
  await addCollectionCard(page);
  await seedImportedDeck(page);
  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await enterGuest(page);
  await navigate(page, '牌組編輯器');
  try {
    await waitDeckEditorReady(page, phone);
  } catch (error) {
    const diagnostic = await page.evaluate(() => ({
      body: document.body.innerText.slice(0, 1500),
      persisted: localStorage.getItem('hunterCard-decks'),
    }));
    console.error(JSON.stringify(diagnostic, null, 2));
    throw error;
  }

  if (phone) {
    await page.waitForSelector('[data-testid="deck-mobile-panel-switch"]', { timeout: TIMEOUT });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `390px layout overflows horizontally by ${overflow}px`);
    const panelTargets = await page.evaluate(() => (
      ['picker', 'oshi', 'main', 'yell', 'shortage'].map((panel) => {
        const node = document.querySelector(`[data-testid="deck-mobile-panel-${panel}"]`);
        if (!node) return { panel, width: 0, height: 0 };
        const rect = node.getBoundingClientRect();
        return { panel, width: rect.width, height: rect.height };
      })
    ));
    assert.equal(panelTargets.length, 5, 'all five phone panel targets must render');
    for (const target of panelTargets) {
      assert.ok(target.width > 0, `${target.panel} panel target must have rendered width`);
      assert.ok(target.height >= 44, `${target.panel} panel target is ${target.height}px high; expected >=44px`);
    }
    await clickTestId(page, 'deck-mobile-panel-shortage');
    await page.waitForFunction(() => document.body.innerText.includes('缺卡預估'), { timeout: TIMEOUT });
    assert.ok((await page.$('[data-testid="card-picker-grid"]')) === null, 'phone must render one major panel');
    await clickTestId(page, 'deck-mobile-panel-main');
    await clickTestId(page, 'deck-mobile-panel-picker');
    await page.waitForSelector('[data-testid="card-picker-grid"]', { timeout: TIMEOUT });
  } else {
    assert.ok((await page.$('[data-testid="deck-mobile-panel-switch"]')) === null, 'desktop keeps multi-column layout');
  }

  await clickTestId(page, phone ? 'deck-mobile-panel-shortage' : 'deck-zone-tab-main').catch(() => {});
  const editorText = await page.evaluate(() => document.body.innerText);
  assert.ok(editorText.includes('缺 1'), 'one owned copy must reduce a two-copy shortage to one');
  assert.ok(!editorText.includes('收藏擁有數量'), 'editor must not duplicate Collection');
  assert.ok(!editorText.includes('有 1'), 'shortage rows must not expose owned controls');
  assert.equal((await page.$$('[data-testid^="collection-inc-"]')).length, 0, 'editor must not expose inventory increment controls');

  await page.reload({ waitUntil: 'domcontentloaded', timeout: TIMEOUT });
  await enterGuest(page);
  await assertCollectionPersists(page);
  await page.close();
}

try {
  const completed = [];
  if (process.env.DIC1086_ONLY !== 'mobile') {
    await run({ width: 1280, height: 900 }, false);
    completed.push('desktop');
  }
  if (process.env.DIC1086_ONLY !== 'desktop') {
    await run({ width: 390, height: 844, isMobile: true, hasTouch: true }, true);
    completed.push('mobile');
  }
  console.log(`DIC-1086 E2E passed at ${completed.join(' + ')}: ${ORIGIN}`);
} finally {
  await browser.close();
}
