#!/usr/bin/env node
// DIC-1494 — the scheduled tournament collector failed on the 2026-09-17
// official column (vol.13): discovery demanded `events[]` for a set-release
// sample recipe that publishes no event, player or placement, so the only way
// to turn the run green was to invent event data. Meanwhile vol.12 (2026-09-04,
// Grand Stage 2026 大阪) — which DOES publish placements — was shadowed by it.
//
// Pinned here:
//   1. classifyOfficialPost on trimmed excerpts of the real vol.12 / vol.13 /
//      producer-letter pages, and its fail-closed edges;
//   2. cardsFromDecklog merges rows the source proves are distinct printings
//      of one number (deck 108R5W, hBP01-021 ×3 rows) and still rejects rows
//      it cannot prove distinct;
//   3. the live collector end to end with a mocked upstream: every newer post
//      is classified, only placement-bearing / unclassifiable posts stub + exit
//      non-zero, a stub never publishes an empty month, re-runs are
//      byte-identical, and a Deck Log failure never overwrites last-known-good.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  classifyOfficialPost,
  officialArticleText,
  cardsFromDecklog,
  verifyDeckCards,
} from '../src/utils/tournamentReport.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const collectorPath = path.join(__dirname, 'collect-tournament-reports.mjs');
const fixtureDir = path.join(__dirname, 'fixtures', 'dic1494');
const html = (name) => fs.readFileSync(path.join(fixtureDir, `${name}.html`), 'utf8');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    console.error(`  ✗ ${name}\n    ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}

const VOL13_TITLE = 'イチ推し！デッキ紹介！vol.13 ～ボリュームヴォルテックス～';
const VOL12_TITLE = 'イチ推し！デッキ紹介！vol.12 ～Grand Stage 2026 大阪注目デッキピックアップ～';
const LETTER_TITLE = 'プロデューサーレター';
const VOL13_URL = 'https://hololive-official-cardgame.com/news/post/deck-showcase_vol-13/';
const VOL12_URL = 'https://hololive-official-cardgame.com/news/post/deck-showcase_vol-12/';
const LETTER_URL = 'https://hololive-official-cardgame.com/news/post/producer_letter/';

// ── 1. classification ────────────────────────────────────────────────────
await test('vol.13 (2026-09-17 sample recipe) carries no tournament results', () => {
  const c = classifyOfficialPost(VOL13_TITLE, officialArticleText(html('vol-13')));
  assert.equal(c.kind, 'no-tournament-results', c.reason);
  assert.match(c.reason, /サンプルレシピ/);
});

await test('vol.13 mentions upcoming events (WGP / Extreamer Final) but that is not a result', () => {
  const text = officialArticleText(html('vol-13'));
  assert.match(text, /ワールドグランプリ26-27/);
  assert.equal(classifyOfficialPost(VOL13_TITLE, text).kind, 'no-tournament-results');
});

await test('vol.12 (Grand Stage 2026 大阪 pick-up) is tournament results', () => {
  const c = classifyOfficialPost(VOL12_TITLE, officialArticleText(html('vol-12')));
  assert.equal(c.kind, 'tournament-results');
  assert.match(c.reason, /選手/);
});

await test('vol.10-style "予選8位 まっさん3297選手" (placement before the player) is results', () => {
  const text = `ーニュースー ${'エリア予選で活躍したデッキを紹介します。'.repeat(10)} ` +
    '「エクストリーマーカップ25-26 エリア予選 東北」Aブロック予選8位 まっさん3297選手';
  assert.equal(classifyOfficialPost('イチ推し！デッキ紹介！ vol.10', text).kind, 'tournament-results');
});

await test('the producer letter (same news category) is not a deck column and has no results', () => {
  const c = classifyOfficialPost(LETTER_TITLE, officialArticleText(html('producer-letter')));
  assert.equal(c.kind, 'no-tournament-results', c.reason);
});

await test('fail-closed: a placement wins over the sample-recipe exemption', () => {
  const text = officialArticleText(html('vol-13')) + ' 優勝 テスト選手 のデッキです';
  assert.equal(classifyOfficialPost(VOL13_TITLE, text).kind, 'tournament-results');
});

await test('fail-closed: a placement wins over the non-column exemption', () => {
  const text = officialArticleText(html('producer-letter')) + ' 個人戦 準優勝 テスト選手';
  assert.equal(classifyOfficialPost(LETTER_TITLE, text).kind, 'tournament-results');
});

await test('fail-closed: an empty / error-page body is unknown, never exempt', () => {
  assert.equal(classifyOfficialPost(VOL13_TITLE, '').kind, 'unknown');
  assert.equal(classifyOfficialPost(VOL13_TITLE, null).kind, 'unknown');
  assert.equal(classifyOfficialPost(LETTER_TITLE, 'サンプルレシピ').kind, 'unknown');
});

await test('fail-closed: a deck column with no placement and no sample-recipe marker is unknown', () => {
  const text = 'イチ推し！デッキ紹介！ '.repeat(30);
  assert.equal(classifyOfficialPost('イチ推し！デッキ紹介！vol.99', text).kind, 'unknown');
});

await test('officialArticleText narrows to the article body and drops markup', () => {
  const text = officialArticleText(html('vol-12'));
  assert.ok(text.startsWith('ーニュースー'), text.slice(0, 40));
  assert.ok(!text.includes('一覧にもどる'));
  assert.ok(!text.includes('© COVER'));
  assert.ok(!/[<>]/.test(text));
});

// ── 2. Deck Log printings ────────────────────────────────────────────────
// Rebuild the real 108R5W Deck Log response from its committed, verified
// card list: the committed single hBP01-021 ×5 slot is split back into the
// three rows Deck Log actually publishes (P promo, hEB01 C reprint, hBP01 C).
const vol12 = JSON.parse(fs.readFileSync(
  path.join(repoRoot, 'data', 'tournaments', 'sources', '2026-09-deck-showcase-vol-12.json'),
  'utf8',
));
const aji = vol12.events.flatMap((e) => e.decks).find((d) => d.decklogCode === '108R5W');
const HBP01_021_ROWS = [
  { card_number: 'hBP01-021', num: 1, type: 1, rare: 'P', img: 'hPR/hBP01-021_P.png' },
  { card_number: 'hBP01-021', num: 2, type: 1, rare: 'C', img: 'hEB01/hBP01-021_C_02.png' },
  { card_number: 'hBP01-021', num: 2, type: 1, rare: 'C', img: 'hBP01/hBP01-021_C.png' },
];
const LIST_KEY = { oshi: ['p_list', 3], main: ['list', 1], yell: ['sub_list', 2] };
function decklog108R5W(hbp01021Rows = HBP01_021_ROWS) {
  const deck = { game_title_id: 9, p_list: [], list: [], sub_list: [] };
  for (const c of aji.cards) {
    const [key, type] = LIST_KEY[c.zone];
    if (c.cardNumber === 'hBP01-021') {
      deck[key].push(...hbp01021Rows);
      continue;
    }
    deck[key].push({
      card_number: c.cardNumber,
      num: c.count,
      type,
      rare: c.version,
      img: `x/${c.cardNumber}_${c.version}.png`,
    });
  }
  return deck;
}
const catalog = new Set(
  Object.values(JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'database.json'), 'utf8')).cards)
    .map((c) => c.cardNumber),
);

await test('precondition: committed 108R5W is verified 1/50/20 with hBP01-021 as one ×5 slot', () => {
  assert.equal(aji.cardsVerified, true);
  const slot = aji.cards.filter((c) => c.cardNumber === 'hBP01-021');
  assert.deepEqual(slot, [{ zone: 'main', cardNumber: 'hBP01-021', version: null, count: 5 }]);
});

await test('108R5W: three distinct printings of hBP01-021 map to one slot and verify 1/50/20', () => {
  const cards = cardsFromDecklog(decklog108R5W());
  const slot = cards.filter((c) => c.cardNumber === 'hBP01-021');
  assert.deepEqual(slot, [{ zone: 'main', cardNumber: 'hBP01-021', version: null, count: 5 }]);
  const v = verifyDeckCards(cards, catalog);
  assert.equal(v.cardsVerified, true, v.failure);
  assert.deepEqual(cards, aji.cards, 'mapping reproduces the committed list exactly');
});

await test('same-grade distinct printings keep their shared grade', () => {
  const cards = cardsFromDecklog(decklog108R5W([
    { ...HBP01_021_ROWS[1], num: 3 },
    HBP01_021_ROWS[2],
  ]));
  const slot = cards.filter((c) => c.cardNumber === 'hBP01-021');
  assert.deepEqual(slot, [{ zone: 'main', cardNumber: 'hBP01-021', version: 'C', count: 5 }]);
});

await test('fail-closed: a repeated row (same img) is NOT merged and fails the duplicate gate', () => {
  const cards = cardsFromDecklog(decklog108R5W([
    HBP01_021_ROWS[0],
    { ...HBP01_021_ROWS[2], num: 2 },
    { ...HBP01_021_ROWS[2], num: 2 },
  ]));
  assert.equal(cards.filter((c) => c.cardNumber === 'hBP01-021').length, 3);
  const v = verifyDeckCards(cards, catalog);
  assert.equal(v.cardsVerified, false);
  assert.match(v.failure, /duplicate card slot within zone: main:hBP01-021/);
});

await test('fail-closed: rows without an img cannot prove distinct printings', () => {
  const cards = cardsFromDecklog(decklog108R5W(
    HBP01_021_ROWS.map(({ img, ...row }) => row),
  ));
  const v = verifyDeckCards(cards, catalog);
  assert.equal(v.cardsVerified, false);
  assert.match(v.failure, /duplicate card slot/);
});

// ── 3. live collector, mocked upstream ───────────────────────────────────
const FEED = [
  { date: '2026-09-17T18:04:18', link: VOL13_URL, title: { rendered: VOL13_TITLE } },
  { date: '2026-09-17T18:04:08', link: LETTER_URL, title: { rendered: LETTER_TITLE } },
  { date: '2026-09-04T18:00:00', link: VOL12_URL, title: { rendered: VOL12_TITLE } },
];

function makeFixture({ curatedVol12 = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1494-'));
  const sources = path.join(dir, 'sources');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // Newest curated source before this incident (2026-08-09), card-free so the
  // run never needs Deck Log.
  fs.writeFileSync(path.join(sources, '2026-08.json'), JSON.stringify({
    month: '2026-08',
    publishedDate: '2026-08-09',
    liveDecklog: false,
    events: [{ eventId: 'ev-aug', name: 'August', sourceUrl: 'https://example.invalid/aug', decks: [] }],
  }, null, 2));
  if (curatedVol12) {
    fs.copyFileSync(
      path.join(repoRoot, 'data', 'tournaments', 'sources', '2026-09-deck-showcase-vol-12.json'),
      path.join(sources, '2026-09-deck-showcase-vol-12.json'),
    );
  }
  return { dir, sources, outDir };
}

function runCollector(fixture, { articleStatus = 200, decklog = null, feed = FEED } = {}) {
  const pages = {
    [VOL13_URL]: html('vol-13'),
    [VOL12_URL]: html('vol-12'),
    [LETTER_URL]: html('producer-letter'),
  };
  const wrapperPath = path.join(fixture.dir, 'run-wrapper.mjs');
  fs.writeFileSync(wrapperPath, `
    const pages = ${JSON.stringify(pages)};
    const decklog = ${JSON.stringify(decklog)};
    globalThis.fetch = async (url) => {
      const u = String(url);
      if (u.includes('/wp-json/wp/v2/post_news')) {
        return new Response(${JSON.stringify(JSON.stringify(feed))}, { status: 200 });
      }
      if (u in pages) {
        return ${articleStatus} === 200
          ? new Response(pages[u], { status: 200 })
          : new Response('', { status: ${articleStatus} });
      }
      if (u.includes('decklog.bushiroad.com') && decklog) {
        return new Response(JSON.stringify(decklog), { status: 200 });
      }
      return new Response('{}', { status: 500 });
    };
    globalThis.__COLLECT_TOURNAMENT_REPORTS_RUN_MAIN__ = true;
    await import(${JSON.stringify(pathToFileURL(collectorPath).href)});
  `);
  const res = spawnSync(
    process.execPath,
    [
      '--experimental-strip-types',
      '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
      '--import', path.join(repoRoot, 'scripts', 'register-ts.mjs'),
      wrapperPath,
      '--live',
      '--sources-dir', fixture.sources,
      '--out-dir', fixture.outDir,
      '--now', '2026-09-29T00:00:00Z',
    ],
    { encoding: 'utf8', timeout: 120_000 },
  );
  const alerts = JSON.parse(fs.readFileSync(path.join(fixture.outDir, 'collector-alerts.json'), 'utf8')).alerts;
  return { status: res.status, out: `${res.stdout}\n${res.stderr}`, alerts };
}

const snapshot = (dir) => Object.fromEntries(
  fs.readdirSync(dir).sort().map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]),
);

await test('before curation: vol.12 (results) stubs + exits non-zero; vol.13 and the letter do not', () => {
  const fx = makeFixture();
  const { status, out, alerts } = runCollector(fx);
  assert.notEqual(status, 0, out);
  assert.deepEqual(
    fs.readdirSync(fx.sources).sort(),
    ['2026-08.json', 'discovered-2026-09-04.json'],
    'only the placement-bearing column gets a stub',
  );
  const errors = alerts.filter((a) => a.level === 'error');
  assert.equal(errors.length, 1, JSON.stringify(errors));
  assert.equal(errors[0].discovered, '2026-09-04T18:00:00');
  assert.equal(errors[0].classification, 'tournament-results');
  for (const date of ['2026-09-17T18:04:18', '2026-09-17T18:04:08']) {
    const a = alerts.find((x) => x.discovered === date);
    assert.equal(a?.level, 'info', `${date}: ${JSON.stringify(a)}`);
    assert.equal(a.classification, 'no-tournament-results');
  }
});

await test('an uncurated stub never publishes an empty month', () => {
  const fx = makeFixture();
  runCollector(fx);
  assert.ok(!fs.existsSync(path.join(fx.outDir, '2026-09.json')));
  const index = JSON.parse(fs.readFileSync(path.join(fx.outDir, 'index.json'), 'utf8'));
  assert.deepEqual(index.months.map((m) => m.month), ['2026-08']);
});

await test('after curation: vol.13 no longer fails the run — exit 0, no stub, September published', () => {
  const fx = makeFixture({ curatedVol12: true });
  const { status, out, alerts } = runCollector(fx);
  assert.equal(status, 0, out);
  assert.ok(!fs.readdirSync(fx.sources).some((f) => f.startsWith('discovered-')));
  assert.equal(alerts.filter((a) => a.level === 'error').length, 0, JSON.stringify(alerts));
  assert.equal(alerts.find((a) => a.discovered === '2026-09-17T18:04:18')?.classification, 'no-tournament-results');
  const sept = JSON.parse(fs.readFileSync(path.join(fx.outDir, '2026-09.json'), 'utf8'));
  assert.equal(sept.events.length, 2);
  assert.equal(sept.observedSampleSize, 3);
  assert.ok(sept.events.flatMap((e) => e.decks).every((d) => d.cardsVerified === true));
});

await test('idempotent: a second identical run leaves every output and source byte-identical', () => {
  const fx = makeFixture({ curatedVol12: true });
  runCollector(fx);
  const out1 = snapshot(fx.outDir);
  const src1 = snapshot(fx.sources);
  const second = runCollector(fx);
  assert.equal(second.status, 0, second.out);
  assert.deepEqual(snapshot(fx.outDir), out1);
  assert.deepEqual(snapshot(fx.sources), src1);
});

await test('fail-closed: an unreachable article is unknown → stub + non-zero exit', () => {
  const fx = makeFixture({ curatedVol12: true });
  const { status, out, alerts } = runCollector(fx, { articleStatus: 503 });
  assert.notEqual(status, 0, out);
  const err = alerts.find((a) => a.level === 'error' && a.discovered === '2026-09-17T18:04:18');
  assert.equal(err?.classification, 'unknown', JSON.stringify(alerts));
  assert.ok(fs.existsSync(path.join(fx.sources, 'discovered-2026-09-17.json')));
});

await test('fail-closed: a foreign article link is never fetched and stays unknown', () => {
  const fx = makeFixture({ curatedVol12: true });
  const feed = [{ date: '2026-09-17T18:04:18', link: 'https://evil.example/post', title: { rendered: VOL13_TITLE } }];
  const { status, alerts } = runCollector(fx, { feed });
  assert.notEqual(status, 0);
  assert.match(alerts.find((a) => a.level === 'error')?.message ?? '', /no official article link/);
});

await test('no last-known-good overwrite: a Deck Log failure keeps the published month byte-identical', () => {
  const fx = makeFixture({ curatedVol12: true });
  runCollector(fx);
  const before = snapshot(fx.outDir);
  // Corrupt the committed 108R5W list so the live leg must re-fetch it, then
  // serve a response whose hBP01-021 rows cannot be proven distinct.
  const srcPath = path.join(fx.sources, '2026-09-deck-showcase-vol-12.json');
  const src = JSON.parse(fs.readFileSync(srcPath, 'utf8'));
  const deck = src.events.flatMap((e) => e.decks).find((d) => d.decklogCode === '108R5W');
  deck.cards = deck.cards.filter((c) => c.cardNumber !== 'hBP01-021');
  fs.writeFileSync(srcPath, JSON.stringify(src, null, 2) + '\n');
  const badDecklog = decklog108R5W(HBP01_021_ROWS.map(({ img, ...row }) => row));
  const { status, out, alerts } = runCollector(fx, { decklog: badDecklog });
  assert.notEqual(status, 0, out);
  assert.ok(alerts.some((a) => /108R5W failed validation: duplicate card slot/.test(a.message)), out);
  const after = snapshot(fx.outDir);
  assert.equal(after['2026-09.json'], before['2026-09.json'], 'September report preserved');
  assert.equal(after['index.json'], before['index.json'], 'index preserved');
});

if ((process.exitCode ?? 0) === 0) {
  console.log(`\nDIC-1494 official post classification: ${passed} tests passed`);
} else {
  console.error('\nDIC-1494 official post classification: FAILED');
}
