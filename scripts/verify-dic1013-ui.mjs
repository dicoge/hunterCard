#!/usr/bin/env node
// Manual UI verification for DIC-1013 (supersedes the DIC-1004 script) — drives
// the built web bundle in a real browser at two viewports.
//
// Acceptance it exercises end to end:
//   • search offers hBP04-005 as its PLAIN ¥980 printing, not the ¥69,800 signed one
//   • adding it persists to localStorage, survives a reload and shows under 我的牌組
//   • the missing-card estimate is the exact yuyu-tei SELL price (¥980 × missing)
//     and the ¥150 store BUY price appears nowhere in the subtotal
//   • a deliberately picked premium printing is priced at ITS listing, never the base
//   • a pre-DIC-1013 draft (rarity-keyed slot, no `printing`) migrates onto the
//     plain printing on load, keeping zone + quantity, without touching ownership
//   • the wording separates 參考售價／缺卡預估 from 店家收購價
//
// Requires `npm run build` first (serves ./dist). Not part of CI.
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

const OUT = process.env.SHOT_DIR || '/tmp';
const DB_TIMEOUT = 120000;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
const report = {};

const subtotal = (page) => page.evaluate(() => {
  const el = document.querySelector('[data-testid="gap-subtotal-JPY"]');
  return el ? el.innerText : null;
});

async function run(label, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const clickText = async (text) => {
    const handle = await page.evaluateHandle((t) => {
      const nodes = [...document.querySelectorAll('div,span,button')];
      const el = nodes.reverse().find((n) => n.textContent.trim() === t) || null;
      el?.scrollIntoView({ block: 'center' });
      return el;
    }, text);
    const el = handle.asElement();
    if (!el) throw new Error(`no clickable element with text "${text}"`);
    // A real mouse click when the node has a hit point; some rows sit under the
    // mobile layout's sticky panels, so fall back to a dispatched DOM click.
    try {
      await el.click();
    } catch {
      await el.evaluate((n) => n.click());
    }
  };
  const hasText = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
  const shot = (n) => page.screenshot({ path: path.join(OUT, `dic1013-${label}-${n}.png`), fullPage: true });
  const readDeck = () => page.evaluate(() => {
    const raw = localStorage.getItem('hunterCard-decks');
    if (!raw) return null;
    const { state } = JSON.parse(raw);
    const zone = (z) => (state.decks[0]?.[z] ?? []).map((s) => [s.card.id, s.qty, s.card.printingLabel ?? null]);
    return { oshi: zone('oshi'), main: zone('main'), yell: zone('yell'), collection: state.collection };
  });

  // Entering the editor only proves the screen mounted; the ~10MB card database
  // still has to stream in before the low-cost index (and therefore the legacy
  // migration and the gap estimate) exists.
  const waitForEditorReady = () => page.waitForFunction(
    () => document.body.innerText.includes('缺卡預估'), { timeout: DB_TIMEOUT },
  );

  async function enterDeckEditor() {
    await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
      || document.body.innerText.includes('牌組編輯器'), { timeout: DB_TIMEOUT });
    if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
    await page.waitForFunction(() => document.body.innerText.includes('牌組編輯器'), { timeout: DB_TIMEOUT });
    await clickText('牌組編輯器');
    await page.waitForFunction(() => document.body.innerText.includes('本地牌組')
      || document.body.innerText.includes('完成組牌'), { timeout: DB_TIMEOUT });
  }

  // ── 1. Fresh deck: search offers the plain printing ───────────────────────
  await page.goto('http://localhost:4173/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'networkidle0' });
  await enterDeckEditor();
  await page.type('input[placeholder="新牌組名稱"]', 'DIC-1013 驗證');
  await clickText('建立');
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: DB_TIMEOUT });

  // DIC-1067 replaced the single search box with zone tabs + a mode-switched
  // picker, so reaching hBP04-005 now means opening 主牌組 and switching to the
  // advanced card-number mode. The DIC-1013 acceptance below is unchanged.
  await page.click('[data-testid="deck-zone-tab-main"]');
  if (await page.$('[data-testid="open-filters"]')) await page.click('[data-testid="open-filters"]');
  await page.click('[data-testid="search-mode-number"]');
  await page.type('[data-testid="card-search-input"]', 'hBP04-005');
  await page.waitForSelector('[data-testid="card-cell-hBP04-005"]', { timeout: DB_TIMEOUT });
  if (await page.$('[data-testid="close-filters"]')) await page.click('[data-testid="close-filters"]');
  const searchRow = await page.evaluate(() => {
    const cell = document.querySelector('[data-testid="card-cell-hBP04-005"]');
    return cell ? cell.parentElement.innerText.replace(/\n/g, ' | ') : null;
  });
  // One cell per card number, carrying the low-cost default printing: the plain
  // one is offered, the ¥69,800 signed one is never the default.
  const offersPlainPrinting = await page.evaluate(
    () => !!document.querySelector('[data-testid="collection-add-hBP04-005#BASE"]'),
  );
  const offersSignedPrinting = await page.evaluate(
    () => !!document.querySelector('[data-testid="collection-add-hBP04-005#PARALLEL/SIGN"]'),
  );
  await shot('search');

  await page.click('[data-testid="card-cell-hBP04-005"]');
  await waitForEditorReady();

  // ── 2. Estimate uses the exact SELL price, never the store buy price ──────
  const estimate = await subtotal(page);
  const gapPanel = await page.evaluate(() => {
    const nodes = [...document.querySelectorAll('div,span')];
    const h = nodes.find((n) => n.textContent.trim().startsWith('缺卡預估（參考售價）'));
    return h ? h.parentElement.innerText : document.body.innerText;
  });
  await shot('estimate');

  // ── 3. Persistence: reload and confirm the slot + deck list survive ───────
  const persistedBeforeReload = await readDeck();
  await page.reload({ waitUntil: 'networkidle0' });
  await enterDeckEditor();
  await waitForEditorReady();
  const persistedAfterReload = await readDeck();
  const estimateAfterReload = await subtotal(page);
  await clickText('切換牌組');
  await page.waitForFunction(() => document.body.innerText.includes('我的牌組'), { timeout: DB_TIMEOUT });
  const deckListText = await page.evaluate(() => document.body.innerText);
  await shot('deck-list');

  // ── 4. A pre-DIC-1013 draft migrates onto the plain printing ─────────────
  const legacyDraft = {
    state: {
      activeDeckId: 'seed',
      // Owning an SEC copy must NOT be re-keyed onto the plain printing.
      collection: { 'hBP04-005|SEC': 1 },
      decks: [{
        id: 'seed',
        name: '舊草稿（rarity 版本模型）',
        oshi: [{ card: { id: 'hBP04-005_ent07', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス', rarity: 'SEC', series: 'ent07', cardTypeJp: '推しホロメン' }, qty: 1 }],
        main: [{ card: { id: 'hBP04-057_ent07', cardNumber: 'hBP04-057', name: 'ラプラス・ダークネス', rarity: 'S', series: 'ent07', cardTypeJp: 'ホロメン' }, qty: 4 }],
        yell: [],
        updatedAt: '2026-08-01T00:00:00.000Z',
      }],
    },
    version: 1,
  };
  await page.evaluate((s) => localStorage.setItem('hunterCard-decks', JSON.stringify(s)), legacyDraft);
  await page.reload({ waitUntil: 'networkidle0' });
  await enterDeckEditor();
  await waitForEditorReady();
  await page.waitForFunction(() => {
    const raw = localStorage.getItem('hunterCard-decks');
    return raw && JSON.parse(raw).state.decks[0].oshi[0].card.printing;
  }, { timeout: DB_TIMEOUT });
  const migrated = await readDeck();
  const migratedEstimate = await subtotal(page);
  await shot('migrated');

  // ── 5. A deliberately picked premium printing keeps ITS price ────────────
  await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('hunterCard-decks'));
    raw.state.decks[0].oshi = [{
      card: {
        id: 'hBP04-005#PARALLEL/SIGN', cardNumber: 'hBP04-005', name: 'ラプラス・ダークネス',
        printing: 'PARALLEL/SIGN', printingLabel: 'ラプラス・ダークネス(パラレル/サイン)',
        series: 'hBP04', type: '', cardTypeJp: '推しホロメン',
      },
      qty: 1,
    }];
    raw.state.decks[0].main = [];
    localStorage.setItem('hunterCard-decks', JSON.stringify(raw));
  });
  await page.reload({ waitUntil: 'networkidle0' });
  await enterDeckEditor();
  await waitForEditorReady();
  const premiumEstimate = await subtotal(page);
  const premiumStillPremium = await page.evaluate(
    () => JSON.parse(localStorage.getItem('hunterCard-decks')).state.decks[0].oshi[0].card.printing,
  );
  await shot('premium');

  report[label] = {
    searchRow,
    offersPlainPrinting,
    offersSignedPrinting,
    estimate,
    wordingSaysReferenceSell: gapPanel.includes('參考售價'),
    wordingExcludesBuyPrice: gapPanel.includes('不使用「店家收購價」估算缺卡成本'),
    buyPrice150Absent: !/(^|\D)150(\D|$)/.test(estimate ?? ''),
    persistedBeforeReload,
    persistedAfterReload,
    estimateAfterReload,
    deckListShowsDeck: deckListText.includes('DIC-1013 驗證'),
    migrated,
    migratedEstimate,
    premiumEstimate,
    premiumStillPremium,
    pageErrors: errors,
  };
  await page.close();
}

await run('desktop', { width: 1280, height: 1000 });
await run('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true });

console.log(JSON.stringify(report, null, 2));

await browser.close();
server.close();
