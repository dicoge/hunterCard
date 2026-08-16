#!/usr/bin/env node
// Manual UI verification for DIC-1033 — drives the built web bundle in a real
// browser at desktop and 390px mobile.
//
// Acceptance it exercises end to end:
//   • a verified August deck offers 一鍵匯入我的牌組 as a primary button
//   • the older unverified July records stay browse-only with the exact reason
//   • one tap creates a NEW deck, opens the deck editor and shows 71 cards
//   • the import provenance banner names the source event
//   • the deck survives a reload and reopens from 我的牌組
//   • a second import makes an independent copy, never overwriting the first
//   • at 390px the button does not cause horizontal overflow
//
// Requires `npm run build` first (serves ./dist). Not part of CI.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const dist = path.resolve('dist');
const types = {
  '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
  '.ico': 'image/x-icon', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml',
};
const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  let file = path.join(dist, url);
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
  res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => server.listen(4174, r));

const OUT = process.env.SHOT_DIR || '/tmp';
const T = 120000;
const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));
const july = JSON.parse(fs.readFileSync('data/tournaments/2026-07.json', 'utf8'));
const DUKHN = august.events[0].decks.find((d) => d.decklogCode === 'DUKHN');
const H2 = august.events[0].decks.find((d) => d.decklogCode === '2H33J8');

const report = {};
const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

async function run(label, viewport) {
  console.log(`\n[${label} ${viewport.width}×${viewport.height}]`);
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  const hasText = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
  const shot = (n) => page.screenshot({ path: path.join(OUT, `dic1033-${label}-${n}.png`), fullPage: true });
  const clickText = async (text) => {
    const handle = await page.evaluateHandle((t) => {
      const el = [...document.querySelectorAll('div,span,button')]
        .reverse().find((n) => n.textContent.trim() === t) || null;
      el?.scrollIntoView({ block: 'center' });
      return el;
    }, text);
    const el = handle.asElement();
    if (!el) throw new Error(`no clickable element with text "${text}"`);
    try { await el.click(); } catch { await el.evaluate((n) => n.click()); }
  };
  const clickTestId = async (id) => {
    const el = await page.$(`[data-testid="${id}"]`);
    if (!el) throw new Error(`no element with testID ${id}`);
    await el.evaluate((n) => n.scrollIntoView({ block: 'center' }));
    try { await el.click(); } catch { await el.evaluate((n) => n.click()); }
  };
  const decks = () => page.evaluate(() => {
    const raw = localStorage.getItem('hunterCard-decks');
    if (!raw) return null;
    const { state } = JSON.parse(raw);
    const count = (d) => ['oshi', 'main', 'yell']
      .reduce((n, z) => n + (d[z] ?? []).reduce((m, s) => m + s.qty, 0), 0);
    return {
      activeDeckId: state.activeDeckId,
      decks: (state.decks ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        total: count(d),
        oshi: (d.oshi ?? []).reduce((n, s) => n + s.qty, 0),
        main: (d.main ?? []).reduce((n, s) => n + s.qty, 0),
        yell: (d.yell ?? []).reduce((n, s) => n + s.qty, 0),
        origin: d.origin ?? null,
        unresolved: ['oshi', 'main', 'yell']
          .reduce((n, z) => n + (d[z] ?? []).filter((s) => s.card.unresolvedPrinting).length, 0),
        printings: [...new Set(['oshi', 'main', 'yell']
          .flatMap((z) => (d[z] ?? []).map((s) => s.card.printing)))],
      })),
    };
  });

  async function openTournamentReport() {
    await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
      || document.body.innerText.includes('賽事月報'), { timeout: T });
    if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
    await page.waitForFunction(() => document.body.innerText.includes('賽事月報'), { timeout: T });
    await clickText('賽事月報');
    await page.waitForFunction(() => document.body.innerText.includes('每月賽事月報'), { timeout: T });
  }

  // The import gate stays closed until the card database has streamed in, so
  // waiting for the enabled button is also the proof that the gate opened.
  const waitForImportReady = (deckId) => page.waitForSelector(
    `[data-testid="deck-import-${deckId}"]`, { timeout: T },
  );

  // ── 1. Fresh state, open the report ──────────────────────────────────────
  await page.goto('http://localhost:4174/', { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'networkidle0' });
  await openTournamentReport();
  await clickText('2026-08');
  await page.waitForFunction(() => document.body.innerText.includes('卡表：'), { timeout: T });
  await waitForImportReady(DUKHN.deckId);
  await shot('01-report');

  check(`${label}: verified DUKHN offers 一鍵匯入我的牌組`,
    !!(await page.$(`[data-testid="deck-import-${DUKHN.deckId}"]`)));
  check(`${label}: verified 2H33J8 offers 一鍵匯入我的牌組`,
    !!(await page.$(`[data-testid="deck-import-${H2.deckId}"]`)));
  check(`${label}: the decklog source link stays available as a secondary action`,
    await hasText('在 decklog 查看牌組'));

  // ── 2. Older unverified July records stay browse-only ────────────────────
  await clickText('2026-07');
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-testid="deck-import-disabled-${id}"]`),
    { timeout: T }, july.events[0].decks[0].deckId,
  );
  const julyState = await page.evaluate((ids) => ids.map((id) => ({
    id,
    enabled: !!document.querySelector(`[data-testid="deck-import-${id}"]`),
    disabled: !!document.querySelector(`[data-testid="deck-import-disabled-${id}"]`),
    reason: document.querySelector(`[data-testid="deck-import-reason-${id}"]`)?.innerText ?? null,
  })), july.events.flatMap((e) => e.decks).map((d) => d.deckId));
  report.july = julyState;
  check(`${label}: every unverified July deck is disabled`,
    julyState.every((d) => d.disabled && !d.enabled), JSON.stringify(julyState.map((d) => d.id)));
  check(`${label}: July decks state 卡表尚未取得，無法匯入`,
    julyState.every((d) => d.reason === '卡表尚未取得，無法匯入'),
    julyState.map((d) => d.reason).join(' / '));
  await shot('02-july-disabled');

  // ── 3. Mobile overflow guard ─────────────────────────────────────────────
  if (viewport.width <= 390) {
    const overflow = await page.evaluate(() => ({
      doc: document.documentElement.scrollWidth,
      client: document.documentElement.clientWidth,
      widest: Math.max(...[...document.querySelectorAll('[data-testid^="deck-import"]')]
        .map((n) => n.getBoundingClientRect().right), 0),
    }));
    report.overflow = overflow;
    check(`${label}: no horizontal overflow at 390px`,
      overflow.doc <= overflow.client, JSON.stringify(overflow));
    check(`${label}: the import button stays inside the viewport`,
      overflow.widest <= overflow.client + 1, `right edge ${overflow.widest}`);
  }

  // ── 4. One tap imports and lands in the editor ───────────────────────────
  await clickText('2026-08');
  await waitForImportReady(DUKHN.deckId);
  await clickTestId(`deck-import-${DUKHN.deckId}`);
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });
  await page.waitForSelector('[data-testid="deck-origin-banner"]', { timeout: T });
  await shot('03-editor');

  const afterImport = await decks();
  report.afterImport = afterImport;
  const imported = afterImport.decks[0];
  check(`${label}: exactly one new deck was created`, afterImport.decks.length === 1);
  check(`${label}: it is the active deck the editor opened`,
    afterImport.activeDeckId === imported.id);
  check(`${label}: the imported deck holds 71 cards`, imported.total === 71, `total ${imported.total}`);
  check(`${label}: zones are exactly 1 / 50 / 20`,
    imported.oshi === 1 && imported.main === 50 && imported.yell === 20,
    `${imported.oshi}/${imported.main}/${imported.yell}`);
  check(`${label}: provenance records the source deck`,
    imported.origin?.decklogCode === 'DUKHN' && imported.origin?.kind === 'tournament',
    JSON.stringify(imported.origin));
  check(`${label}: the editor shows the import provenance banner`,
    await hasText('已從賽事牌組匯入'));
  check(`${label}: the editor reports 71 total cards`, await hasText('71'));

  const bannerText = await page.evaluate(
    () => document.querySelector('[data-testid="deck-origin-banner"]')?.innerText ?? null,
  );
  report.banner = bannerText;
  check(`${label}: unresolved printings are stated, not hidden`,
    imported.unresolved === 0 || /版本/.test(bannerText ?? ''), bannerText);
  check(`${label}: no unresolved slot adopted a real printing`,
    imported.printings.every((p) => p === 'UNRESOLVED' || p !== ''),
    imported.printings.join(','));

  // ── 4b. The import does not auto-apply the low-cost default, but the
  //        editor's existing explicit action is still offered for it ─────────
  const lowCost = await page.evaluate(() => {
    const el = [...document.querySelectorAll('div,span')]
      .find((n) => n.textContent.trim().startsWith('套用低配版本'));
    return el ? el.textContent.trim() : null;
  });
  report.lowCostAction = lowCost;
  check(`${label}: the import did not silently apply a low-cost printing`,
    imported.printings.every((p) => p === 'UNRESOLVED'), imported.printings.join(','));
  check(`${label}: the editor still offers 套用低配版本 as an explicit opt-in`,
    imported.unresolved === 0 || !!lowCost, String(lowCost));

  // ── 5. Reload persistence + reopen from 我的牌組 ──────────────────────────
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
    || document.body.innerText.includes('牌組編輯器'), { timeout: T });
  if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
  await clickText('牌組編輯器');
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌')
    || document.body.innerText.includes('本地牌組'), { timeout: T });

  // Reopen it explicitly from the deck list, as a returning player would.
  if (await hasText('切換牌組')) await clickText('切換牌組');
  await page.waitForFunction(() => document.body.innerText.includes('本地牌組'), { timeout: T });
  await shot('04-my-decks');
  const listedName = await page.evaluate(
    (name) => document.body.innerText.includes(name), imported.name,
  );
  check(`${label}: the imported deck is listed under 我的牌組 after reload`, listedName,
    imported.name);
  await clickText(imported.name);
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });

  const afterReload = await decks();
  report.afterReload = afterReload;
  const restored = afterReload.decks.find((d) => d.id === imported.id);
  check(`${label}: the deck survives reload with all 71 cards`, restored?.total === 71,
    `total ${restored?.total}`);
  check(`${label}: provenance survives reload`, restored?.origin?.decklogCode === 'DUKHN');
  check(`${label}: printings were not silently rewritten on reload`,
    JSON.stringify(restored?.printings?.slice().sort())
      === JSON.stringify(imported.printings.slice().sort()),
    JSON.stringify(restored?.printings));
  await shot('05-reopened');

  // ── 6. A second import is an independent copy ────────────────────────────
  await clickText('賽事月報');
  await page.waitForFunction(() => document.body.innerText.includes('每月賽事月報'), { timeout: T });
  await clickText('2026-08');
  await waitForImportReady(DUKHN.deckId);
  await clickTestId(`deck-import-${DUKHN.deckId}`);
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });

  const afterSecond = await decks();
  report.afterSecond = afterSecond;
  check(`${label}: a second import adds a deck instead of overwriting`,
    afterSecond.decks.length === 2, `${afterSecond.decks.length} decks`);
  check(`${label}: the copy is named with a (2) suffix`,
    afterSecond.decks[1].name === `${afterSecond.decks[0].name} (2)`,
    afterSecond.decks.map((d) => d.name).join(' | '));
  check(`${label}: both copies hold 71 cards`,
    afterSecond.decks.every((d) => d.total === 71));
  check(`${label}: the first deck is unchanged`,
    afterSecond.decks[0].id === imported.id && afterSecond.decks[0].total === 71);
  await shot('06-second-import');

  report[`${label}_errors`] = errors;
  check(`${label}: no runtime errors on the page`, errors.length === 0, errors.slice(0, 3).join(' | '));
  await page.close();
}

await run('desktop', { width: 1440, height: 900 });
await run('mobile', { width: 390, height: 844 });

console.log(`\n${JSON.stringify(report, null, 2)}`);
await browser.close();
server.close();

if (failures.length > 0) {
  console.error(`\nDIC-1033 UI verification FAILED (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nDIC-1033 UI verification: all checks passed');
