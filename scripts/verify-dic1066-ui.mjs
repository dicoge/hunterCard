#!/usr/bin/env node
// UI verification for DIC-1066 — drives a real browser at desktop and 390px
// mobile, against the local build by default or any deployed environment via
// BASE_URL, so the same script produces Preview and Production evidence:
//
//   npm run build && node scripts/verify-dic1066-ui.mjs               # local dist
//   BASE_URL=https://<preview>.vercel.app node scripts/verify-dic1066-ui.mjs
//   BASE_URL=https://holohunter.dicoge.com node scripts/verify-dic1066-ui.mjs
//
// Every expectation is derived from the month files the environment actually
// serves — nothing about the sample size is hardcoded, so the same run is valid
// before and after the DIC-1065 July backfill.
//
// Covers: the donut renders for every scope, the centre label states the
// verified sample, legend percentages sum to 100, a small sample says so, an
// empty scope draws nothing instead of NaN, clicking a slice filters the deck
// list, clearing restores it, and 390px never scrolls horizontally.
// Not part of CI (needs a browser).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import puppeteer from 'puppeteer';

const BASE_URL = (process.env.BASE_URL || '').replace(/\/$/, '');
const LOCAL_PORT = 4176;
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
fs.mkdirSync(OUT, { recursive: true });
const T = 120000;

const failures = [];
function check(label, ok, detail) {
  if (!ok) failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
}

// ── Expectations, read from the same JSON the app fetches ───────────────────
async function fetchJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${res.status} ${url}`);
  return res.json();
}

const index = await fetchJson(`${ORIGIN}/data/tournaments/index.json`);
const MONTHS = index.months.map((m) => m.month);
const reports = Object.fromEntries(
  await Promise.all(
    MONTHS.map(async (m) => [m, await fetchJson(`${ORIGIN}/data/tournaments/${m}.json`)]),
  ),
);

const decksOf = (months) =>
  months.flatMap((m) => reports[m].events.flatMap((e) => e.decks));
const uniq = (decks) => [...new Map(decks.map((d) => [d.deckId, d])).values()];
// `=== true`, not truthiness: this oracle has to state the rule independently of
// the app. Accepting any truthy value here would make the check agree with a
// screen that had wrongly counted `cardsVerified: "false"` as published.
const verifiedOf = (months) => uniq(decksOf(months)).filter((d) => d.cardsVerified === true);

const SCOPES = [
  { id: 'all', months: MONTHS },
  ...MONTHS.map((m) => ({ id: m, months: [m] })),
];

// The slice order the chart draws in: count desc, id asc, unknown last. Needed
// to know which angle each wedge occupies, so a click can be aimed at the ring
// the way a user aims at it.
function sliceOrder(verified) {
  const counts = new Map();
  let unknown = 0;
  for (const d of verified) {
    if (d.archetypeId == null) unknown += 1;
    else counts.set(d.archetypeId, (counts.get(d.archetypeId) ?? 0) + 1);
  }
  const rows = [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count || a.key.localeCompare(b.key));
  if (unknown > 0) rows.push({ key: '__unknown__', count: unknown });
  return rows;
}
const expected = Object.fromEntries(
  SCOPES.map((s) => {
    const verified = verifiedOf(s.months);
    const byArchetype = new Map();
    for (const d of verified) {
      const key = d.archetypeId ?? '__unknown__';
      byArchetype.set(key, (byArchetype.get(key) ?? 0) + 1);
    }
    return [s.id, { n: verified.length, observed: uniq(decksOf(s.months)).length, byArchetype }];
  }),
);

console.log(`\n[expectations from ${ENV}]`);
for (const s of SCOPES) {
  console.log(
    `  ${s.id}: verified n=${expected[s.id].n}, observed=${expected[s.id].observed}`,
  );
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
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const shot = (n) =>
    page.screenshot({ path: path.join(OUT, `dic1066-${label}-${n}.png`), fullPage: true });
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
  const testIdText = (id) =>
    page.evaluate((x) => document.querySelector(`[data-testid="${x}"]`)?.innerText ?? null, id);
  // Deck rows are testID'd by their own deckId, so the visible list can be
  // compared against the data rather than against a count in this script.
  const visibleDeckIds = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="deck-decklog:"]')]
      .map((n) => n.getAttribute('data-testid').replace(/^deck-/, '')));
  const legendRows = () => page.evaluate(() =>
    [...document.querySelectorAll('[data-testid^="donut-legend-"]')].map((n) => ({
      key: n.getAttribute('data-testid').replace('donut-legend-', ''),
      text: n.innerText.replace(/\n/g, ' '),
    })));

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
    || document.body.innerText.includes('賽事月報'), { timeout: T });
  if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
  await page.waitForFunction(() => document.body.innerText.includes('賽事月報'), { timeout: T });
  await clickText('賽事月報');
  await page.waitForFunction(() => document.body.innerText.includes('每月賽事月報'), { timeout: T });

  // ── 1. Default scope is every verified month ──────────────────────────────
  await page.waitForFunction(
    () => document.querySelector('[data-testid="donut-center"]')
      || document.querySelector('[data-testid="donut-empty"]'),
    { timeout: T },
  );
  const defaultScopeActive = await page.evaluate(() => {
    const el = document.querySelector('[data-testid="scope-all"]');
    return el ? getComputedStyle(el).backgroundColor : null;
  });
  check('the all-months scope chip exists and is the default', defaultScopeActive != null,
    defaultScopeActive ?? 'missing');
  await shot('01-default-all');

  // ── 2. Each scope: sample size, legend, small-sample / empty state ────────
  for (const scope of SCOPES) {
    const exp = expected[scope.id];
    await clickTestId(`scope-${scope.id}`);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="donut-center"]')
        || document.querySelector('[data-testid="donut-empty"]'),
      { timeout: T },
    );

    if (exp.n === 0) {
      const empty = await testIdText('donut-empty');
      check(`${scope.id}: an empty sample says so instead of drawing a chart`, empty != null,
        empty ?? 'no empty state');
      check(`${scope.id}: no chart is drawn`,
        (await page.$('[data-testid="donut-chart"]')) === null);
    } else {
      const centre = await testIdText('donut-center');
      check(`${scope.id}: centre label states the verified sample`,
        centre === `n=${exp.n}`, `${centre} (expected n=${exp.n})`);

      const rows = await legendRows();
      check(`${scope.id}: one legend row per slice`,
        rows.length === exp.byArchetype.size, `${rows.length} vs ${exp.byArchetype.size}`);
      const percents = rows.map((r) => Number(/(\d+)%/.exec(r.text)?.[1] ?? NaN));
      check(`${scope.id}: legend percentages sum to 100`,
        percents.reduce((a, b) => a + b, 0) === 100, percents.join('+'));
      for (const [key, count] of exp.byArchetype) {
        const row = rows.find((r) => r.key === key);
        check(`${scope.id}: legend row ${key} shows ${count} 副`,
          row != null && row.text.includes(`${count} 副`), row?.text ?? 'missing');
      }

      const small = await testIdText('donut-small-sample');
      const wantSmall = exp.n < 3;
      check(`${scope.id}: small-sample notice ${wantSmall ? 'shown' : 'absent'} for n=${exp.n}`,
        (small != null) === wantSmall, small ?? 'none');
    }

    const text = await bodyText();
    check(`${scope.id}: no NaN / undefined rendered`,
      !/NaN|undefined/.test(text), (text.match(/NaN|undefined/g) ?? []).join(','));
    check(`${scope.id}: the observed-vs-published distinction stays on screen`,
      text.includes('已公開樣本'));
    await shot(`02-scope-${scope.id}`);
  }

  // ── 3. Clicking a slice filters the deck list; clearing restores it ───────
  await clickTestId('scope-all');
  await page.waitForFunction(() => document.querySelector('[data-testid="donut-center"]'),
    { timeout: T });
  const before = await visibleDeckIds();
  check('every observed deck is listed with no filter',
    before.length === expected.all.observed, `${before.length} vs ${expected.all.observed}`);

  const decksOfSlice = (key) => uniq(decksOf(MONTHS))
    .filter((d) => (d.archetypeId ?? '__unknown__') === key)
    .map((d) => d.deckId);

  // Aim at the middle of each wedge's ring, the way a user does. Hitting the
  // right slice from an angle is the real proof the geometry and the hit
  // regions agree — an element-centroid click would land in the centre hole.
  const clickRingAt = async (midAngle) => {
    // Viewport coordinates, because that is what page.mouse works in.
    const box = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="donut-chart"]');
      el.scrollIntoView({ block: 'center' });
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    });
    const rad = (midAngle * Math.PI) / 180;
    const r = box.width * 0.4; // between the hole (0.29) and the rim (0.5)
    await page.mouse.click(
      box.x + box.width / 2 + r * Math.sin(rad),
      box.y + box.height / 2 - r * Math.cos(rad),
    );
  };

  const order = sliceOrder(verifiedOf(MONTHS));
  const total = order.reduce((n, s) => n + s.count, 0);
  let cumulative = 0;
  for (const row of order) {
    const midAngle = ((cumulative + row.count / 2) * 360) / total;
    cumulative += row.count;
    const want = decksOfSlice(row.key);

    await clickRingAt(midAngle);
    await page.waitForFunction(() => document.querySelector('[data-testid="donut-clear"]'),
      { timeout: T });
    const got = await visibleDeckIds();
    check(`clicking the ring at ${Math.round(midAngle)}° selects ${row.key} and filters the list`,
      got.length === want.length && want.every((id) => got.includes(id)),
      `${got.join(',')} vs ${want.join(',')}`);
    if (row === order[0]) await shot('03-slice-selected');

    await clickTestId('donut-clear');
    await page.waitForFunction(() => !document.querySelector('[data-testid="donut-clear"]'),
      { timeout: T });
    check(`clearing ${row.key} restores every deck`,
      (await visibleDeckIds()).length === before.length);
  }

  // The legend is the selection control that must work on every platform.
  const legendKey = order[0].key;
  await clickTestId(`donut-legend-${legendKey}`);
  await page.waitForFunction(() => document.querySelector('[data-testid="donut-clear"]'),
    { timeout: T });
  check('the legend row selects the same slice',
    (await visibleDeckIds()).length === decksOfSlice(legendKey).length);
  await clickTestId('donut-clear');

  // ── 4. The oshi switch ────────────────────────────────────────────────────
  await clickTestId('dimension-oshi');
  await page.waitForFunction(() => document.querySelector('[data-testid="donut-center"]'),
    { timeout: T });
  const oshiRows = await legendRows();
  const expectedOshi = new Set(verifiedOf(MONTHS).map((d) => d.oshi ?? '__unknown__'));
  check('the oshi switch regroups the same sample',
    oshiRows.length === expectedOshi.size, `${oshiRows.length} vs ${expectedOshi.size}`);
  check('the oshi centre label keeps the same sample size',
    (await testIdText('donut-center')) === `n=${expected.all.n}`);
  await shot('04-oshi');
  await clickTestId('dimension-archetype');

  // ── 5. Layout + runtime health ────────────────────────────────────────────
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  check(`no horizontal overflow at ${viewport.width}px`,
    overflow.scrollWidth <= overflow.clientWidth + 1,
    `${overflow.scrollWidth} > ${overflow.clientWidth}`);
  check('no page errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  await page.close();
}

/**
 * A month that fails to load must not leave the rest rendering as the complete
 * set. Blocking one month's request is the only honest way to reach that state
 * from outside the app, so the browser check drives it rather than trusting the
 * reducer test alone.
 */
async function runPartialScope(label, viewport) {
  if (MONTHS.length < 2) {
    console.log(`\n[${label} partial-scope] skipped — needs 2+ months, index has ${MONTHS.length}`);
    return;
  }
  const blocked = MONTHS[MONTHS.length - 1];
  const kept = MONTHS.filter((m) => m !== blocked);
  console.log(`\n[${label} partial-scope @ ${ENV}] blocking ${blocked}.json`);

  const page = await browser.newPage();
  await page.setViewport(viewport);
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (req.url().includes(`/data/tournaments/${blocked}.json`)) req.abort();
    else req.continue();
  });

  const hasText = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
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

  await page.goto(`${ORIGIN}/`, { waitUntil: 'networkidle0' });
  await page.waitForFunction(() => document.body.innerText.includes('以訪客身份進入')
    || document.body.innerText.includes('賽事月報'), { timeout: T });
  if (await hasText('以訪客身份進入')) await clickText('以訪客身份進入');
  await page.waitForFunction(() => document.body.innerText.includes('賽事月報'), { timeout: T });
  await clickText('賽事月報');
  await page.waitForFunction(
    () => document.querySelector('[data-testid="scope-partial"]')
      || document.querySelector('[data-testid="scope-error"]'),
    { timeout: T },
  );

  const notice = await page.evaluate(() =>
    document.querySelector('[data-testid="scope-partial"]')?.innerText ?? null);
  const body = await page.evaluate(() => document.body.innerText);

  check('a failed month is called out instead of silently dropped',
    notice != null && notice.includes(blocked), notice ?? 'no scope-partial notice');
  check('the heading no longer claims the complete set',
    !body.includes('已公開樣本分布（全部月份）'),
    body.split('\n').find((l) => l.includes('已公開樣本分布')) ?? 'heading missing');
  check('the months that did load are still named and rendered',
    kept.every((m) => notice?.includes(m)), `kept=${kept.join(',')} notice=${notice}`);
  check('the surviving month still charts its own verified sample',
    (await page.evaluate(() =>
      document.querySelector('[data-testid="donut-center"]')?.innerText ?? null))
      === `n=${verifiedOf(kept).length}`,
    `expected n=${verifiedOf(kept).length}`);

  await page.screenshot({
    path: path.join(OUT, `dic1066-${label}-05-partial-scope.png`),
    fullPage: true,
  });
  await page.close();
}

await run('desktop', { width: 1440, height: 900 });
await run('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true });
await runPartialScope('desktop', { width: 1440, height: 900 });
await runPartialScope('mobile', { width: 390, height: 844, isMobile: true, hasTouch: true });

await browser.close();
if (server) server.close();

console.log(`\nScreenshots in ${OUT}`);
if (failures.length) {
  console.error(`\nverify-dic1066-ui: FAIL (${failures.length})`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log('\nverify-dic1066-ui: PASS');
