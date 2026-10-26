#!/usr/bin/env node
// hSD20/hSD21 review B1 + M1: the official detail page carries two blocks the
// effects pipeline used to drop or mangle.
//   B1 — 推しステージスキル (`<div class="stage skill">`, hSD20-001 / hSD21-001) was never
//        parsed, so both oshi cards shipped without one of their two official skills.
//   M1 — the arts 特攻 bonus (`<span class="tokkou"><img alt="緑+50"></span>`) was folded
//        into the arts cost ("赤赤◇緑+50"), so cost no longer matched the card.
//
// Pinned against verbatim excerpts of the saved official pages
// (fixtures/official-detail-hsd20-hsd21, provenance.json), end to end:
//   1. fixture bytes match their recorded provenance sha256;
//   2. an independent jsdom census of every rules block on the page — an unknown
//      block class fails closed instead of being skipped;
//   3. parseCardPage() carries every census block, with stage text and the tokkou
//      bonus taken from the DOM and kept out of cost;
//   4. committed data/effects-jp.json equals the parser output for those pages;
//   5. committed data/effects-zh.json has a kana-free block for every JP block, keeps
//      numbers, and copies cost / damage / tokkou verbatim;
//   6. sync → every printing (incl. the hSD20-011 reprint under hSD21) carries them,
//      and sanitizeDatabase() (native asset path) keeps them;
//   7. CardDetail renders the stage skill and the 特攻 bonus in zh and ja.
//
// Run with the web render hooks (see package.json `test:official-stage-skill-tokkou`).

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

process.env.EXPO_PUBLIC_STORE_MVP = '0';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, '..');
const fixtureDir = path.join(here, 'fixtures', 'official-detail-hsd20-hsd21');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));

const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
class TestResizeObserver { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = TestResizeObserver;
dom.window.ResizeObserver = TestResizeObserver;
// CardDetail's price-trend panel fetches /data/trends/*.json; trends are out of
// scope here, so it gets the same 404 the landing render test uses.
globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({}), text: async () => '' });

const { parseCardPage } = await import('./scrape-effects.js');
const { syncOfficialCatalogToDatabase } = await import('./sync-official-catalog-to-database.mjs');
const { sanitizeDatabase } = await import('./lib/store-mvp-sanitize.mjs');
const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');
const CardDetailScreen = (await import('../src/screens/CardDetailScreen.tsx')).default;
const { toCanonicalCardRecord } = await import('../src/utils/canonicalCardRecord.ts');
const { useSettingsStore } = await import('../src/store/settingsStore.ts');
const { t } = await import('../src/i18n/index.ts');

let passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    process.exitCode = 1;
    console.error(`  ✗ ${name} — ${err.message}`);
  }
}

// DIC-465: a zh field may never carry hiragana/katakana.
const KANA_RE = /[぀-ゟァ-ヺー-ヿ]/u;
// Japanese text carries no meaningful ASCII/ideographic spacing; compare without it.
const squash = (s) => String(s ?? '').replace(/\s+/g, '');
const numbers = (s) => (String(s ?? '').match(/\d+/g) ?? []).sort();

const provenance = readJson(path.join(fixtureDir, 'provenance.json'));
const officialRows = readJson(path.join(fixtureDir, 'official-rows.json'));
const effectsJp = readJson(path.join(repoRoot, 'data', 'effects-jp.json'));
const effectsZh = readJson(path.join(repoRoot, 'data', 'effects-zh.json'));
const pages = provenance.files.map((f) => ({
  ...f,
  html: fs.readFileSync(path.join(fixtureDir, f.file), 'utf8'),
  row: officialRows.find((r) => r.cardNumber === f.cardNumber),
}));

// ── Independent DOM census ──────────────────────────────────────────────────
// Every direct child block of the rules area. `info` / `illustrator` are card
// metadata; everything else is rules text and must be classified, so a block
// class the official site adds later fails here instead of silently vanishing.
const META_BLOCKS = new Set(['info', 'illustrator']);
const KEYWORD_CLASSES = ['keyword', 'extra', 'gift', 'buzz', 'collabo', 'collab', 'bloomEffect', 'baton'];
const SKILL_KINDS = { stage: 'stageSkill', oshi: 'oshiSkill', sp: 'spOshiSkill' };

function census(html) {
  const doc = new JSDOM(html).window.document;
  const area = doc.querySelector('.txt-Inner');
  if (!area) throw new Error('no .txt-Inner rules area');
  const out = { skills: {}, arts: [], keywords: 0, unknown: [] };
  for (const block of area.children) {
    const cls = [...block.classList];
    if (block.tagName !== 'DIV' || cls.some((c) => META_BLOCKS.has(c))) continue;
    const ps = block.querySelectorAll(':scope > p');
    if (cls.includes('skill')) {
      const kind = Object.keys(SKILL_KINDS).find((k) => cls.includes(k));
      if (!kind || out.skills[SKILL_KINDS[kind]]) { out.unknown.push(cls.join(' ')); continue; }
      const body = ps[1];
      const nameEl = body?.querySelector(':scope > span');
      const name = nameEl?.textContent ?? '';
      const after = body ? body.textContent.slice(body.textContent.indexOf(name) + name.length) : '';
      out.skills[SKILL_KINDS[kind]] = { name, effect: after, bodyText: body?.textContent ?? '' };
    } else if (cls.includes('arts')) {
      const head = ps[1]?.querySelector(':scope > span');
      const tokkouImgs = head ? [...head.querySelectorAll('.tokkou img')] : [];
      const costImgs = head ? [...head.querySelectorAll('img')].filter((img) => !img.closest('.tokkou')) : [];
      const headClone = head?.cloneNode(true);
      headClone?.querySelectorAll('.tokkou').forEach((el) => el.remove());
      const effect = ps[1] ? ps[1].textContent.slice((head?.textContent ?? '').length) : '';
      out.arts.push({
        cost: costImgs.map((img) => img.getAttribute('alt')).join(''),
        tokkou: tokkouImgs.map((img) => img.getAttribute('alt')).join(''),
        headText: headClone?.textContent ?? '',
        effect,
      });
    } else if (cls.some((c) => KEYWORD_CLASSES.includes(c))) {
      out.keywords += 1;
    } else {
      out.unknown.push(cls.join(' ') || block.outerHTML.slice(0, 40));
    }
  }
  return out;
}

const censuses = new Map();

await test('fixtures: every excerpt matches its provenance sha256 and has an official row', async () => {
  const onDisk = fs.readdirSync(fixtureDir).filter((f) => f.endsWith('.html')).sort();
  assert.deepEqual(onDisk, provenance.files.map((f) => f.file).sort(), 'fixture set equals provenance list');
  for (const p of pages) {
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(fixtureDir, p.file))).digest('hex');
    assert.equal(sha, p.excerpt.sha256, `${p.file} sha256`);
    assert.ok(p.html.startsWith(provenance.excerptStart), `${p.file} starts at the detail block`);
    assert.ok(p.row, `${p.cardNumber} has an official cardsearch row`);
    assert.equal(p.row.id, p.officialId, `${p.cardNumber} official id`);
  }
});

await test('census: every rules block is classified, and the set exercises both stage skill and tokkou', async () => {
  for (const p of pages) {
    const c = census(p.html);
    assert.deepEqual(c.unknown, [], `${p.cardNumber} has no unclassified rules block`);
    censuses.set(p.cardNumber, c);
  }
  const all = [...censuses.values()];
  assert.ok(all.some((c) => c.skills.stageSkill), 'fixtures contain at least one stage skill block');
  assert.ok(all.some((c) => c.arts.some((a) => a.tokkou)), 'fixtures contain at least one tokkou bonus');
});

await test('parser: parseCardPage carries every census block; stage text and tokkou come from the page', async () => {
  for (const p of pages) {
    const c = censuses.get(p.cardNumber);
    assert.ok(c, `${p.cardNumber} census`);
    const parsed = parseCardPage(p.html, p.row);
    for (const key of Object.values(SKILL_KINDS)) {
      assert.equal(!!parsed[key], !!c.skills[key], `${p.cardNumber} ${key} presence`);
    }
    if (c.skills.stageSkill) {
      assert.ok(parsed.stageSkill.name && parsed.stageSkill.effect, `${p.cardNumber} stage name/effect non-empty`);
      assert.equal(squash(parsed.stageSkill.name), squash(c.skills.stageSkill.name), `${p.cardNumber} stage name`);
      assert.equal(squash(parsed.stageSkill.effect), squash(c.skills.stageSkill.effect), `${p.cardNumber} stage effect`);
      assert.ok(!('cost' in parsed.stageSkill), `${p.cardNumber} stage skill has no holo-power cost`);
      assert.notDeepEqual(parsed.stageSkill, parsed.oshiSkill && { name: parsed.oshiSkill.name, effect: parsed.oshiSkill.effect },
        `${p.cardNumber} stage skill is not the oshi skill`);
    }
    assert.equal(parsed.arts?.length ?? 0, c.arts.length, `${p.cardNumber} arts count`);
    c.arts.forEach((want, i) => {
      const art = parsed.arts[i];
      assert.equal(art.cost, want.cost, `${p.cardNumber} arts[${i}] cost is only the cost icons`);
      if (want.tokkou) {
        assert.equal(art.tokkou, want.tokkou, `${p.cardNumber} arts[${i}] tokkou`);
        assert.ok(!art.cost.includes(want.tokkou), `${p.cardNumber} arts[${i}] tokkou not folded into cost`);
      } else {
        assert.ok(!('tokkou' in art), `${p.cardNumber} arts[${i}] no invented tokkou`);
      }
      assert.equal(squash(`${art.name}${art.damage}`), squash(want.headText), `${p.cardNumber} arts[${i}] name+damage`);
      assert.equal(squash(art.effect), squash(want.effect), `${p.cardNumber} arts[${i}] effect`);
    });
    assert.equal(parsed.keywords?.length ?? 0, c.keywords, `${p.cardNumber} keyword count`);
  }
});

await test('effects-jp: committed entry equals the parser output for the official page', async () => {
  for (const p of pages) {
    assert.ok(Object.hasOwn(effectsJp, p.cardNumber), `${p.cardNumber} in effects-jp`);
    assert.deepEqual(effectsJp[p.cardNumber], parseCardPage(p.html, p.row), `${p.cardNumber} effects-jp`);
  }
});

await test('effects-zh: a kana-free zh block for every JP block, numbers kept, cost/damage/tokkou verbatim', async () => {
  for (const p of pages) {
    const jp = effectsJp[p.cardNumber];
    const zh = effectsZh[p.cardNumber];
    assert.ok(zh, `${p.cardNumber} in effects-zh`);
    for (const key of Object.values(SKILL_KINDS)) {
      if (!jp[key]) { assert.ok(!zh[key], `${p.cardNumber} zh has no ${key} the page lacks`); continue; }
      assert.ok(zh[key]?.name && zh[key]?.effect, `${p.cardNumber} zh ${key} name/effect`);
      assert.ok(!KANA_RE.test(zh[key].name) && !KANA_RE.test(zh[key].effect), `${p.cardNumber} zh ${key} kana-free`);
      assert.deepEqual(numbers(zh[key].effect), numbers(jp[key].effect), `${p.cardNumber} zh ${key} numbers`);
      assert.equal(zh[key].cost, jp[key].cost, `${p.cardNumber} zh ${key} cost`);
    }
    assert.equal(zh.arts?.length ?? 0, jp.arts?.length ?? 0, `${p.cardNumber} zh arts count`);
    (jp.arts ?? []).forEach((art, i) => {
      const zart = zh.arts[i];
      assert.equal(zart.cost, art.cost, `${p.cardNumber} zh arts[${i}] cost`);
      assert.equal(zart.damage, art.damage, `${p.cardNumber} zh arts[${i}] damage`);
      assert.equal(zart.tokkou, art.tokkou, `${p.cardNumber} zh arts[${i}] tokkou`);
      assert.ok(zart.name && !KANA_RE.test(zart.name) && !KANA_RE.test(zart.effect ?? ''), `${p.cardNumber} zh arts[${i}] kana-free`);
      assert.deepEqual(numbers(zart.effect), numbers(art.effect), `${p.cardNumber} zh arts[${i}] numbers`);
    });
  }
});

// ── sync → native ───────────────────────────────────────────────────────────
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'huntercard-stage-skill-tokkou-'));
const dbPath = path.join(tmp, 'database.json');
const officialDir = path.join(tmp, 'official');
fs.mkdirSync(officialDir, { recursive: true });
fs.writeFileSync(dbPath, `${JSON.stringify({ lastUpdated: '2026-10-24T00:00:00.000Z', totalCards: 0, cards: {} }, null, 2)}\n`);
const rowsBySet = Map.groupBy(officialRows, (r) => r.sourceProduct);
fs.writeFileSync(path.join(officialDir, '_meta.json'), `${JSON.stringify({
  seriesStats: [...rowsBySet].map(([code, rows]) => ({ code, expectedCount: rows.length, ingestedCount: rows.length })),
}, null, 2)}\n`);
for (const [code, rows] of rowsBySet) {
  fs.writeFileSync(path.join(officialDir, `${code}.json`), `${JSON.stringify(rows, null, 2)}\n`);
}

let synced = [];
await test('sync → native: every printing carries the stage skill and tokkou in skillsJp and skillsZh', async () => {
  syncOfficialCatalogToDatabase({
    databasePath: dbPath,
    officialDirectory: officialDir,
    translationPath: path.join(repoRoot, 'data', 'character-names-zh.json'),
    effectsJpPath: path.join(repoRoot, 'data', 'effects-jp.json'),
    effectsZhPath: path.join(repoRoot, 'data', 'effects-zh.json'),
  });
  const after = readJson(dbPath);
  const native = sanitizeDatabase(after);
  synced = Object.values(after.cards);
  for (const row of officialRows) {
    const card = synced.find((c) => c.cardNumber === row.cardNumber && c.sourceProduct === row.sourceProduct);
    assert.ok(card, `${row.cardNumber}/${row.sourceProduct} upserted`);
    assert.deepEqual(card.skillsJp, effectsJp[row.cardNumber], `${row.cardNumber}/${row.sourceProduct} skillsJp`);
    assert.deepEqual(card.skillsZh, effectsZh[row.cardNumber], `${row.cardNumber}/${row.sourceProduct} skillsZh`);
    const shipped = native.cards[card.id];
    assert.deepEqual(shipped.skillsJp, card.skillsJp, `${row.cardNumber}/${row.sourceProduct} native skillsJp`);
    assert.deepEqual(shipped.skillsZh, card.skillsZh, `${row.cardNumber}/${row.sourceProduct} native skillsZh`);
    const c = censuses.get(row.cardNumber);
    assert.equal(!!shipped.skillsZh.stageSkill, !!c?.skills.stageSkill, `${row.cardNumber}/${row.sourceProduct} native stage skill`);
    assert.deepEqual((shipped.skillsZh.arts ?? []).map((a) => a.tokkou ?? ''), (c?.arts ?? []).map((a) => a.tokkou),
      `${row.cardNumber}/${row.sourceProduct} native tokkou`);
  }
});

// ── UI ──────────────────────────────────────────────────────────────────────
async function renderText(card, language) {
  useSettingsStore.setState({ preferredLanguage: language });
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => root.render(React.createElement(CardDetailScreen, {
    route: { params: { card } },
    navigation: { navigate() {}, goBack() {} },
  })));
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  const text = container.textContent;
  await act(async () => root.unmount());
  container.remove();
  return text;
}

// 推しステージスキル → 主推舞台技能 follows the 推しスキル → 主推技能 glossary entry and the
// existing hBP09-025 effect text that already says 主推舞台技能.
const STAGE_BADGE = { zh: '主推舞台技能', ja: '推しステージスキル' };

await test('CardDetail: stage skill and 特攻 bonus render in zh and ja for every affected printing', async () => {
  const names = readJson(path.join(repoRoot, 'data', 'character-names-zh.json'));
  const affected = synced.filter((c) => c.skillsJp?.stageSkill || c.skillsJp?.arts?.some((a) => a.tokkou));
  assert.equal(affected.length, officialRows.length, 'every fixture printing is a stage-skill or tokkou printing');
  for (const row of affected) {
    const card = toCanonicalCardRecord(row, names);
    for (const language of ['zh', 'ja']) {
      const skills = language === 'zh' ? row.skillsZh : row.skillsJp;
      const text = await renderText(card, language);
      const label = `${row.cardNumber}/${row.sourceProduct} ${language}`;
      if (skills.stageSkill) {
        assert.ok(text.includes(STAGE_BADGE[language]), `${label} stage skill badge`);
        if (language === 'zh') assert.ok(!text.includes(STAGE_BADGE.ja), `${label} stage skill badge is not Japanese`);
        assert.ok(text.includes(skills.stageSkill.name), `${label} stage skill name`);
        assert.ok(text.includes(skills.stageSkill.effect), `${label} stage skill effect`);
      }
      for (const art of skills.arts ?? []) {
        if (!art.tokkou) continue;
        assert.ok(text.includes(t('card_detail_tokkou', language, { value: art.tokkou })), `${label} tokkou`);
        assert.ok(text.includes(art.cost), `${label} arts cost`);
      }
    }
  }
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
