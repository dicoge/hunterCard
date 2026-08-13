// Manual end-to-end check for DIC-1000 against a running web build:
//   npm run build && npx serve -s dist -l 4199
//   node scripts/e2e-tournament-import.mjs [baseUrl]
// Drives the real UI: guest entry → 賽事月報, and asserts the honest fail-closed
// state the shipped data produces — no licensed card list exists, so every
// import CTA is disabled, states its reason, and creates nothing when tapped.
// Not part of CI (needs a browser and a served build).
import puppeteer from 'puppeteer';
import assert from 'node:assert/strict';

const BASE = process.argv[2] || 'http://localhost:4199';
const NO_CARD_LIST_REASON = '此牌組卡表尚未取得，暫時無法匯入';
const shots = [];

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 1600 });
page.on('pageerror', (e) => console.log('  [pageerror]', e.message));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function shot(name) {
  const path = `e2e-${name}.png`;
  await page.screenshot({ path });
  shots.push(path);
  return path;
}

async function clickText(text, { exact = true } = {}) {
  const ok = await page.evaluate((t, ex) => {
    const els = [...document.querySelectorAll('div,span,a,button')].filter((e) => {
      const s = e.textContent.trim();
      return ex ? s === t : s.includes(t);
    });
    const el = els[els.length - 1];
    if (!el) return false;
    el.click();
    return true;
  }, text, exact);
  assert.ok(ok, `clickable element with text ${JSON.stringify(text)} exists`);
  await sleep(1200);
}

async function waitForText(text, timeout = 40000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text);
}

try {
  await page.goto(`${BASE}/`, { waitUntil: 'networkidle2', timeout: 60000 });
  await waitForText('以訪客身份進入');
  await clickText('以訪客身份進入');
  await sleep(3000);

  // Drawer → 賽事月報
  await page.evaluate(() => {
    const btn = document.querySelector('[aria-label="Show navigation menu"], [role="button"]');
    btn?.click();
  });
  await sleep(1200);
  await clickText('賽事月報');
  await waitForText('賽事與精選牌組');
  await sleep(1500);
  await shot('01-report');

  const ctas = await page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="tournament-import-"]')].map((b) => ({
      id: b.getAttribute('data-testid'),
      disabled: b.getAttribute('aria-disabled') === 'true',
      label: b.getAttribute('aria-label'),
    })));
  console.log('  import CTAs on report:', JSON.stringify(ctas));
  assert.ok(ctas.length > 0, 'the report renders an import CTA per observed deck');
  for (const cta of ctas) {
    assert.equal(cta.disabled, true, `${cta.id} must be disabled without a licensed card list`);
    assert.equal(cta.label, NO_CARD_LIST_REASON, `${cta.id} must state why it is disabled`);
  }

  const reasonsShown = await page.evaluate(
    (r) => document.body.innerText.split(r).length - 1,
    NO_CARD_LIST_REASON,
  );
  assert.equal(reasonsShown, ctas.length, 'every disabled CTA shows its reason in the page');

  // Tapping a disabled CTA must not create a deck.
  await page.evaluate((id) => document.querySelector(`[data-testid="${id}"]`).click(), ctas[0].id);
  await sleep(1500);
  const stored = await page.evaluate(() => localStorage.getItem('hunterCard-decks'));
  const deckCount = stored ? JSON.parse(stored).state.decks.length : 0;
  assert.equal(deckCount, 0, 'a disabled CTA must never create a deck');
  await shot('02-disabled-cta');

  console.log(`\nDIC-1000 e2e: PASS (screenshots: ${shots.join(', ')})`);
} catch (err) {
  await shot('99-failure');
  throw err;
} finally {
  await browser.close();
}
