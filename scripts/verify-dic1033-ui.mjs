#!/usr/bin/env node
// UI verification for DIC-1033 — drives a real browser at desktop and 390px
// mobile, against the local build by default or any deployed environment via
// BASE_URL, so the same script produces Preview and Production evidence:
//
//   npm run build && node scripts/verify-dic1033-ui.mjs              # local dist
//   BASE_URL=https://<preview>.vercel.app node scripts/verify-dic1033-ui.mjs
//   BASE_URL=https://holohunter.dicoge.com node scripts/verify-dic1033-ui.mjs
//
// The full journey runs for BOTH verified decks (DUKHN and 2H33J8):
//   one tap → a NEW independent deck → exact 1 / 50 / 20 → editor → reload →
//   reopen from 我的牌組.
//
// It also covers: the older unverified July records staying browse-only, the
// import provenance banner, no cross-deck contamination, repeat-import copies,
// and no horizontal overflow at 390px. Not part of CI (needs a browser).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const LOCAL_PORT = 4174;
let server = null;

if (!BASE_URL) {
  const dist = path.resolve('dist');
  if (!fs.existsSync(dist)) {
    console.error('No BASE_URL given and ./dist is missing — run `npm run build` first.');
    process.exit(1);
  }
  const types = {
    '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json',
    '.ico': 'image/x-icon', '.png': 'image/png', '.css': 'text/css', '.svg': 'image/svg+xml',
  };
  server = http.createServer((req, res) => {
    const url = decodeURIComponent(req.url.split('?')[0]);
    let file = path.join(dist, url);
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(dist, 'index.html');
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'text/plain' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise((r) => server.listen(LOCAL_PORT, r));
}

const ORIGIN = BASE_URL || `http://localhost:${LOCAL_PORT}`;
const ENV = BASE_URL ? new URL(ORIGIN).host : 'local-dist';
const OUT = process.env.SHOT_DIR || '/tmp';
const T = 120000;

const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));
const july = JSON.parse(fs.readFileSync('data/tournaments/2026-07.json', 'utf8'));
const VERIFIED = august.events[0].decks.filter((d) => d.cardsVerified);
const JULY_DECK_IDS = july.events.flatMap((e) => e.decks).map((d) => d.deckId);

if (VERIFIED.length < 2) {
  console.error(`Expected at least two verified August decks, found ${VERIFIED.length}`);
  process.exit(1);
}

const report = { environment: ORIGIN };
const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });

async function run(label, viewport) {
  console.log(`\n[${label} ${viewport.width}×${viewport.height} @ ${ENV}]`);
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
  const readDecks = () => page.evaluate(() => {
    const raw = localStorage.getItem('hunterCard-decks');
    if (!raw) return { activeDeckId: null, decks: [] };
    const { state } = JSON.parse(raw);
    const sum = (slots) => (slots ?? []).reduce((n, s) => n + s.qty, 0);
    return {
      activeDeckId: state.activeDeckId,
      decks: (state.decks ?? []).map((d) => ({
        id: d.id,
        name: d.name,
        oshi: sum(d.oshi), main: sum(d.main), yell: sum(d.yell),
        total: sum(d.oshi) + sum(d.main) + sum(d.yell),
        origin: d.origin ?? null,
        printings: [...new Set(['oshi', 'main', 'yell']
          .flatMap((z) => (d[z] ?? []).map((s) => s.card.printing)))],
      })),
    };
  });

  const openReport = async () => {
    await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
      || document.body.innerText.includes('賽事月報'), { timeout: T });
    if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
    await page.waitForFunction(() => document.body.innerText.includes('賽事月報'), { timeout: T });
    await clickText('賽事月報');
    await page.waitForFunction(() => document.body.innerText.includes('每月賽事月報'), { timeout: T });
    await clickText('2026-08');
  };
  // Each import starts from a cold page load rather than an in-app drawer hop:
  // deterministic, and it also proves the previous import really persisted
  // rather than merely surviving in memory. Storage is same-origin, so the
  // decks built so far carry over.
  const freshReport = async () => {
    await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
    await openReport();
  };
  // The gate stays closed until the card database has streamed in, so waiting
  // for the enabled button is itself the proof that the gate opened.
  const waitForImportReady = (deckId) => page.waitForSelector(
    `[data-testid="deck-import-${deckId}"]`, { timeout: T },
  );
  const openEditor = async () => {
    await clickText('牌組編輯器');
    await page.waitForFunction(() => document.body.innerText.includes('完成組牌')
      || document.body.innerText.includes('本地牌組'), { timeout: T });
  };

  // ── 1. Fresh state, open the report ──────────────────────────────────────
  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.evaluate(() => localStorage.removeItem('hunterCard-decks'));
  await page.reload({ waitUntil: 'networkidle0' });
  await openReport();
  for (const deck of VERIFIED) await waitForImportReady(deck.deckId);
  await shot('01-report');

  for (const deck of VERIFIED) {
    check(`${label}: ${deck.decklogCode} offers 一鍵匯入我的牌組`,
      !!(await page.$(`[data-testid="deck-import-${deck.deckId}"]`)));
  }
  check(`${label}: the decklog source link stays a secondary action`,
    await hasText('在 decklog 查看牌組'));

  // ── 2. Older unverified July records stay browse-only ────────────────────
  await clickText('2026-07');
  await page.waitForFunction(
    (id) => !!document.querySelector(`[data-testid="deck-import-disabled-${id}"]`),
    { timeout: T }, JULY_DECK_IDS[0],
  );
  const julyState = await page.evaluate((ids) => ids.map((id) => ({
    id,
    enabled: !!document.querySelector(`[data-testid="deck-import-${id}"]`),
    disabled: !!document.querySelector(`[data-testid="deck-import-disabled-${id}"]`),
    reason: document.querySelector(`[data-testid="deck-import-reason-${id}"]`)?.innerText ?? null,
  })), JULY_DECK_IDS);
  report.july = julyState;
  check(`${label}: every unverified July deck is disabled`,
    julyState.every((d) => d.disabled && !d.enabled));
  check(`${label}: July decks state 卡表尚未取得，無法匯入`,
    julyState.every((d) => d.reason === '卡表尚未取得，無法匯入'));
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

  // ── 4. Full journey for EVERY verified deck ──────────────────────────────
  const importedByCode = {};
  for (const [i, deck] of VERIFIED.entries()) {
    await freshReport();
    await waitForImportReady(deck.deckId);
    await clickTestId(`deck-import-${deck.deckId}`);
    await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });
    await page.waitForSelector('[data-testid="deck-origin-banner"]', { timeout: T });

    const state = await readDecks();
    const mine = state.decks.find((d) => d.origin?.decklogCode === deck.decklogCode);
    importedByCode[deck.decklogCode] = mine;

    check(`${label}: ${deck.decklogCode} → one tap created a new deck (${i + 1} total)`,
      state.decks.length === i + 1, `${state.decks.length} decks`);
    check(`${label}: ${deck.decklogCode} is the active deck the editor opened`,
      state.activeDeckId === mine?.id);
    check(`${label}: ${deck.decklogCode} imports exactly 1 / 50 / 20 = 71`,
      mine?.oshi === 1 && mine?.main === 50 && mine?.yell === 20 && mine?.total === 71,
      `${mine?.oshi}/${mine?.main}/${mine?.yell} = ${mine?.total}`);
    check(`${label}: ${deck.decklogCode} records its own provenance`,
      mine?.origin?.kind === 'tournament' && mine?.origin?.sourceUrl === deck.sourceUrl,
      mine?.origin?.sourceUrl);
    check(`${label}: ${deck.decklogCode} shows the import banner in the editor`,
      await hasText('已從賽事牌組匯入'));
    check(`${label}: ${deck.decklogCode} adopted no real printing`,
      (mine?.printings ?? []).every((p) => p === 'UNRESOLVED'),
      (mine?.printings ?? []).join(','));

    // Every previously imported deck must be untouched by this one.
    for (const prev of VERIFIED.slice(0, i)) {
      const before = importedByCode[prev.decklogCode];
      const now = state.decks.find((d) => d.id === before.id);
      check(`${label}: importing ${deck.decklogCode} left ${prev.decklogCode} intact`,
        now?.total === 71 && now?.name === before.name, `${now?.total}`);
    }
    await shot(`03-editor-${deck.decklogCode}`);
  }

  const distinctNames = new Set(Object.values(importedByCode).map((d) => d.name));
  check(`${label}: the two decks got distinct names`,
    distinctNames.size === VERIFIED.length, [...distinctNames].join(' | '));

  // ── 5. Reload, then reopen EACH deck from 我的牌組 ────────────────────────
  await page.reload({ waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
    || document.body.innerText.includes('牌組編輯器'), { timeout: T });
  if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
  await openEditor();

  for (const deck of VERIFIED) {
    const mine = importedByCode[deck.decklogCode];
    if (await hasText('切換牌組')) await clickText('切換牌組');
    await page.waitForFunction(() => document.body.innerText.includes('本地牌組'), { timeout: T });
    check(`${label}: ${deck.decklogCode} is listed under 我的牌組 after reload`,
      await page.evaluate((n) => document.body.innerText.includes(n), mine.name), mine.name);
    await clickText(mine.name);
    await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });

    const state = await readDecks();
    const restored = state.decks.find((d) => d.id === mine.id);
    check(`${label}: ${deck.decklogCode} reopens with all 71 cards after reload`,
      restored?.total === 71 && restored?.oshi === 1 && restored?.main === 50 && restored?.yell === 20,
      `${restored?.oshi}/${restored?.main}/${restored?.yell}`);
    check(`${label}: ${deck.decklogCode} provenance survived reload`,
      restored?.origin?.decklogCode === deck.decklogCode);
    check(`${label}: ${deck.decklogCode} printings were not rewritten on reload`,
      (restored?.printings ?? []).every((p) => p === 'UNRESOLVED'),
      (restored?.printings ?? []).join(','));
    await shot(`04-reopened-${deck.decklogCode}`);
  }

  // ── 6. A repeat import is an independent copy ────────────────────────────
  const first = VERIFIED[0];
  await freshReport();
  await waitForImportReady(first.deckId);
  await clickTestId(`deck-import-${first.deckId}`);
  await page.waitForFunction(() => document.body.innerText.includes('完成組牌'), { timeout: T });

  const finalState = await readDecks();
  report.finalDecks = finalState.decks.map((d) => ({ name: d.name, total: d.total }));
  const base = importedByCode[first.decklogCode];
  const copy = finalState.decks.find((d) => d.name === `${base.name} (2)`);
  check(`${label}: a repeat import adds a deck instead of overwriting`,
    finalState.decks.length === VERIFIED.length + 1, `${finalState.decks.length} decks`);
  check(`${label}: the copy is named with a (2) suffix`, !!copy,
    finalState.decks.map((d) => d.name).join(' | '));
  check(`${label}: the copy is a separate deck with its own 71 cards`,
    !!copy && copy.id !== base.id && copy.total === 71);
  check(`${label}: every deck still holds 71 cards`,
    finalState.decks.every((d) => d.total === 71));
  await shot('05-repeat-import');

  check(`${label}: no runtime errors on the page`, errors.length === 0, errors.slice(0, 3).join(' | '));
  report[`${label}_errors`] = errors;
  await page.close();
}

await run('desktop', { width: 1440, height: 900 });
await run('mobile', { width: 390, height: 844 });

console.log(`\n${JSON.stringify(report, null, 2)}`);
await browser.close();
server?.close();

if (failures.length > 0) {
  console.error(`\nDIC-1033 UI verification FAILED against ${ORIGIN} (${failures.length}):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nDIC-1033 UI verification: all checks passed against ${ORIGIN}`);
