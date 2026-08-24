#!/usr/bin/env node
/**
 * DIC-1085 i18n and Tournament Monthly Summary regression test.
 *
 * Covers:
 * 1. Key parity between zh and ja locale dictionaries.
 * 2. Translation interpolation and fallback behavior.
 * 3. Tournament Monthly Summary model construction from live verified data.
 * 4. Summary localization in both Traditional Chinese (zh) and Japanese (ja).
 *
 * Run: node --experimental-strip-types --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-i18n.mjs
 */

import assert from 'node:assert/strict';
import { t, zh, ja } from '../src/i18n/index.ts';
import {
  buildTournamentMonthlySummary, buildEventHighlights, buildRepresentativeCards,
  filterEventsByColor, normalizeTournamentColor, REPRESENTATIVE_CARDS_LIMIT,
} from '../src/utils/tournamentSummary.ts';
import { verifiedDecks, ALL_SCOPE } from '../src/utils/tournamentDonut.ts';
import fs from 'node:fs';
import path from 'node:path';
import { getTutorialData } from '../src/data/tutorialData.ts';
import { getSimulationPhases } from '../src/data/tutorialSimulationData.ts';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── 1. Locale Key Parity & Completeness ─────────────────────────────────────
test('zh and ja locale dictionaries have exact key parity', () => {
  const zhKeys = Object.keys(zh).sort();
  const jaKeys = Object.keys(ja).sort();
  assert.deepEqual(zhKeys, jaKeys, 'Locale dictionary keys must match exactly');
  assert.ok(zhKeys.length > 50, 'Dictionary should contain complete UI key set');
});

test('no translation key resolves to empty or undefined value', () => {
  for (const [key, val] of Object.entries(zh)) {
    assert.ok(val && val.trim().length > 0, `zh key ${key} must not be empty`);
  }
  for (const [key, val] of Object.entries(ja)) {
    assert.ok(val && val.trim().length > 0, `ja key ${key} must not be empty`);
  }
});

// ── 2. Interpolation and Translation Function ───────────────────────────────
test('t() interpolates template parameters correctly', () => {
  const zhRes = t('search_results_count', 'zh', { count: 42 });
  assert.equal(zhRes, '共 42 張卡牌');

  const jaRes = t('search_results_count', 'ja', { count: 42 });
  assert.equal(jaRes, '全 42 件');
});

test('t() returns default fallback string when given an invalid language', () => {
  const fallback = t('nav_home', 'invalid');
  assert.equal(fallback, '首頁');
});

test('t() fails closed for missing keys instead of rendering the raw key', () => {
  assert.throws(
    () => t('definitely_missing_key', 'ja'),
    /Missing translation key: definitely_missing_key \(ja\)/,
  );
});

// ── 3. Mutation-sensitive source coverage ──────────────────────────────────
const SOURCE_COVERAGE = {
  'src/screens/HomeScreen.tsx': 9,
  'src/screens/SearchScreen.tsx': 4,
  'src/screens/SearchResultsScreen.tsx': 9,
  'src/screens/CardDetailScreen.tsx': 65,
  'src/screens/CollectionScreen.tsx': 13,
  'src/screens/ScanScreen.tsx': 55,
  'src/screens/DeckEditorScreen.tsx': 70,
  'src/screens/SettingsScreen.tsx': 40,
  'src/screens/TutorialScreen.tsx': 11,
  'src/screens/TutorialDetailScreen.tsx': 3,
  'src/screens/TutorialSimulationScreen.tsx': 3,
  'src/screens/WatchlistScreen.tsx': 24,
  'src/screens/TournamentReportScreen.tsx': 55,
  'src/components/ObservedShareDonut.tsx': 4,
  'src/components/CardPicker.tsx': 18,
  'src/components/PriceAlertEditor.tsx': 18,
  'src/components/ScanOverlay.tsx': 12,
  'src/components/ScanCandidateSelector.tsx': 10,
  'src/components/ScanQuotaBanner.tsx': 5,
  'src/components/ScanResultCard.tsx': 4,
  'src/components/ScanSessionPanel.tsx': 14,
  'src/components/WebCamera.tsx': 2,
  'src/components/CardItem.tsx': 2,
  'src/components/PriceTrend.tsx': 6,
  'src/components/tutorial/SimulationStepCard.tsx': 4,
  'src/components/tutorial/TutorialPhaseCard.tsx': 3,
  'src/components/tutorial/SimulationBoard.tsx': 19,
  'src/data/tutorialDataJa.ts': null,
  'src/data/tutorialSimulationDataJa.ts': null,
};

const stripComments = (source) => source
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^\s*\/\/.*$/gm, '');

test('every required reachable surface subscribes to locale changes and uses translated copy', () => {
  for (const [file, minimumLookups] of Object.entries(SOURCE_COVERAGE)) {
    const source = fs.readFileSync(path.resolve(file), 'utf8');
    if (minimumLookups == null) {
      assert.match(source, /const\s+\w+Ja\s*:/, `${file} must export an explicit Japanese dataset`);
      continue;
    }
    assert.match(source, /useTranslation/, `${file} must subscribe to language changes`);
    const lookups = source.match(/\bt\(/g)?.length ?? 0;
    assert.ok(
      lookups >= minimumLookups,
      `${file} translation coverage regressed: ${lookups} < ${minimumLookups}`,
    );
  }
});

test('required surfaces contain no hardcoded Traditional-Chinese JSX or UI props', () => {
  const allowedVisibleData = new Set([
    '星街すいせい', '湊あくあ', '巴哈姆特 — 桜雪', '🏪 遊々亭',
  ]);
  const failures = [];
  for (const [file, minimumLookups] of Object.entries(SOURCE_COVERAGE)) {
    if (minimumLookups == null) continue;
    const source = stripComments(fs.readFileSync(path.resolve(file), 'utf8'));
    const candidates = [
      ...source.matchAll(/>([^<{\n]*[\u3400-\u9fff][^<{\n]*)</g),
      ...source.matchAll(/(?:placeholder|accessibilityLabel|emptyLabel|title|label)=["']([^"']*[\u3400-\u9fff][^"']*)["']/g),
      ...source.matchAll(/(?:Alert\.alert|showAlert|set(?:Scan|Search|Camera|Scanning)\w*)\(\s*["']([^"']*[\u3400-\u9fff][^"']*)["']/g),
    ];
    for (const match of candidates) {
      const literal = match[1].trim();
      if (!allowedVisibleData.has(literal)) failures.push(`${file}: ${literal}`);
    }
  }
  assert.deepEqual(failures, [], `Hardcoded UI strings found:\n${failures.join('\n')}`);
});

test('CI runs the i18n source/key gate', () => {
  const workflow = fs.readFileSync(path.resolve('.github/workflows/ci.yml'), 'utf8');
  assert.match(workflow, /npm run test:i18n/, 'CI must execute npm run test:i18n');
});

test('Collection browser verification waits for controls, not loading copy', () => {
  const verifier = fs.readFileSync(path.resolve('scripts/verify-dic1085-ui.mjs'), 'utf8');
  assert.ok(
    ja.collection_loading.includes(ja.collection_title),
    'negative control must preserve the Japanese loading/title substring race',
  );
  assert.match(
    verifier,
    /waitCollectionReady\s*=\s*\(\)\s*=>\s*page\.waitForSelector\([\s\S]*collection-search[\s\S]*visible:\s*true/,
    'Collection verification must wait for the real search control',
  );
  assert.doesNotMatch(verifier, /await waitText\(['"]コレクション['"]\)/);
  assert.doesNotMatch(verifier, /await waitText\(['"]收藏卡片['"]\)/);
});

test('DIC-1086 production verification waits for editor controls, not obsolete copy', () => {
  const verifier = fs.readFileSync(path.resolve('scripts/verify-dic1086-production-e2e.mjs'), 'utf8');
  assert.equal(zh.deck_zone_main, '主牌組', 'negative control keeps the localized label distinct from obsolete 主牌');
  assert.match(
    verifier,
    /waitDeckEditorReady[\s\S]*deck-mobile-panel-switch[\s\S]*deck-phone-progress[\s\S]*deck-zone-tabs/,
    'mobile readiness must wait for the rendered editor controls',
  );
  assert.doesNotMatch(verifier, /主牌 2\/50/, 'obsolete pre-localization copy cannot gate readiness');
});

const phaseShape = (phase) => ({
  steps: phase.steps?.length ?? 0,
  notes: phase.notes?.length ?? 0,
  conditions: phase.conditions?.length ?? 0,
  canDo: phase.canDo?.length ?? 0,
  cannotDo: phase.cannotDo?.length ?? 0,
  subPhases: phase.subPhases?.map(phaseShape) ?? [],
});

const LOCALIZED_DATA_KEYS = new Set([
  'title', 'description', 'alt', 'label', 'content', 'notes', 'steps',
  'conditions', 'canDo', 'cannotDo', 'actionLabel', 'explanation', 'name',
]);
const JAPANESE_HAN_ONLY_ALLOWLIST = new Set([
  '勝利条件',
  '参考資料',
  'hololive OCG 公式 X（Twitter）',
]);
const HAN = /\p{Script=Han}/u;
const KANA = /[\p{Script=Hiragana}\p{Script=Katakana}ー]/u;

function collectLocalizedLeaves(value, objectPath = [], localized = false, leaves = []) {
  if (typeof value === 'string') {
    if (localized) leaves.push({ objectPath, value });
    return leaves;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectLocalizedLeaves(item, [...objectPath, index], localized, leaves));
    return leaves;
  }
  if (!value || typeof value !== 'object') return leaves;
  for (const [key, child] of Object.entries(value)) {
    collectLocalizedLeaves(child, [...objectPath, key], LOCALIZED_DATA_KEYS.has(key), leaves);
  }
  return leaves;
}

function setValueAtPath(root, objectPath, value) {
  const parent = objectPath.slice(0, -1).reduce((current, key) => current[key], root);
  parent[objectPath.at(-1)] = value;
}

function validateJapaneseLocalizedDataset(japanese, chinese, datasetName) {
  const japaneseLeaves = collectLocalizedLeaves(japanese);
  const chineseLeaves = new Map(
    collectLocalizedLeaves(chinese).map((leaf) => [JSON.stringify(leaf.objectPath), leaf.value]),
  );
  assert.ok(japaneseLeaves.length > 0, `${datasetName} must expose localized text`);
  for (const { objectPath, value } of japaneseLeaves) {
    const field = `${datasetName}${objectPath.map((part) => `[${JSON.stringify(part)}]`).join('')}`;
    const chineseValue = chineseLeaves.get(JSON.stringify(objectPath));
    assert.equal(typeof chineseValue, 'string', `${field} must have a matching Chinese source field`);
    if (value === chineseValue) {
      throw new Error(`${field}: Japanese localized text must not fall back to Chinese`);
    }
    if (HAN.test(value) && !KANA.test(value) && !JAPANESE_HAN_ONLY_ALLOWLIST.has(value)) {
      throw new Error(`${field}: Japanese localized text containing Han characters must include kana`);
    }
  }
}

test('rule detail and simulation datasets cover every offered language with matching structure', () => {
  const zhTutorial = getTutorialData('zh');
  const jaTutorial = getTutorialData('ja');
  assert.deepEqual(
    jaTutorial.map((section) => ({
      id: section.id,
      items: section.items?.length ?? 0,
      content: section.content?.length ?? 0,
      links: section.links?.length ?? 0,
      phases: section.phases?.map(phaseShape) ?? [],
    })),
    zhTutorial.map((section) => ({
      id: section.id,
      items: section.items?.length ?? 0,
      content: section.content?.length ?? 0,
      links: section.links?.length ?? 0,
      phases: section.phases?.map(phaseShape) ?? [],
    })),
  );

  const zhSimulation = getSimulationPhases('zh');
  const jaSimulation = getSimulationPhases('ja');
  assert.deepEqual(
    jaSimulation.map((phase) => [phase.id, phase.steps.length]),
    zhSimulation.map((phase) => [phase.id, phase.steps.length]),
  );

  const japaneseCopy = JSON.stringify([jaTutorial, jaSimulation]);
  for (const traditionalChinese of ['牌組', '吶喊', '聯動', '舞台後方', '主推位置', '步驟', '模擬實戰', '卡牌', '比賽流程']) {
    assert.ok(!japaneseCopy.includes(traditionalChinese), `Japanese rule data leaks: ${traditionalChinese}`);
  }
});

test('every reachable Japanese rule field rejects arbitrary untranslated Traditional-Chinese content', () => {
  const fixtures = [
    ['tutorial', getTutorialData('ja'), getTutorialData('zh')],
    ['simulation', getSimulationPhases('ja'), getSimulationPhases('zh')],
  ];
  for (const [name, japanese, chinese] of fixtures) {
    validateJapaneseLocalizedDataset(japanese, chinese, name);
    for (const { objectPath } of collectLocalizedLeaves(japanese)) {
      const mutated = structuredClone(japanese);
      setValueAtPath(mutated, objectPath, '這段規則內容尚未翻譯');
      assert.throws(
        () => validateJapaneseLocalizedDataset(mutated, chinese, name),
        /Japanese localized text/,
        `${name}${JSON.stringify(objectPath)} must be mutation-sensitive`,
      );
    }
  }
});

// ── 4. Live Tournament Data Fixtures & Summary Derivation ───────────────────
const julyPath = path.resolve('public/data/tournaments/2026-07.json');
const augustPath = path.resolve('public/data/tournaments/2026-08.json');
const indexPath = path.resolve('public/data/tournaments/index.json');

assert.ok(fs.existsSync(julyPath), '2026-07.json must exist');
assert.ok(fs.existsSync(augustPath), '2026-08.json must exist');
assert.ok(fs.existsSync(indexPath), 'index.json must exist');

const julyReport = JSON.parse(fs.readFileSync(julyPath, 'utf8'));
const augustReport = JSON.parse(fs.readFileSync(augustPath, 'utf8'));

test('buildTournamentMonthlySummary generates real accurate stats for 2026-08', () => {
  const summaryZh = buildTournamentMonthlySummary([augustReport], '2026-08', 'zh');
  assert.equal(summaryZh.eventCount, 1);
  assert.equal(summaryZh.observedDeckCount, 2);
  assert.equal(summaryZh.verifiedDeckCount, 2);
  assert.equal(summaryZh.smallSample, true, 'n=2 is below SMALL_SAMPLE_MIN (3)');
  assert.ok(summaryZh.topArchetypes.length > 0);
  assert.ok(summaryZh.topColors.length > 0);
  assert.ok(summaryZh.notablePlacements.length > 0);
  assert.equal(summaryZh.notablePlacements[0].rankLabel, 'champion');
});

test('buildTournamentMonthlySummary aggregates all-months scope correctly', () => {
  const summaryZh = buildTournamentMonthlySummary([augustReport, julyReport], ALL_SCOPE, 'zh');
  assert.equal(summaryZh.eventCount, 4);
  assert.equal(summaryZh.observedDeckCount, 5);
  assert.equal(summaryZh.verifiedDeckCount, 5);
  assert.equal(summaryZh.smallSample, false, 'n=5 is >= 3');
  assert.ok(summaryZh.scopeLabel.includes('2026-07 ~ 2026-08'));
  assert.deepEqual(
    Object.fromEntries(summaryZh.topColors.map(({ color, count }) => [color, count])),
    { purple: 3, blue: 3, red: 1 },
  );
});

test('top-color actions filter the live verified deck list without inventing shares', () => {
  const events = [augustReport, julyReport].flatMap((report) => report.events);
  const filtered = filterEventsByColor(events, 'purple');
  const decks = filtered.flatMap((event) => event.decks);
  assert.equal(decks.length, 3);
  assert.ok(decks.every((deck) => deck.colors.some((color) => normalizeTournamentColor(color) === 'purple')));
  assert.deepEqual(filterEventsByColor(events, null), events);
});

test('buildTournamentMonthlySummary translates scope labels into Japanese when requested', () => {
  const summaryJa = buildTournamentMonthlySummary([augustReport, julyReport], ALL_SCOPE, 'ja');
  assert.ok(summaryJa.scopeLabel.includes('全期間'));
  assert.ok(summaryJa.scopeLabel.includes('2026-07 ~ 2026-08'));
});

// ── 5. Fail-closed gates & unknown handling in summary ─────────────────────
test('summary ignores unverified decks for top archetype counts', () => {
  const unverifiedReport = {
    ...augustReport,
    events: [
      {
        ...augustReport.events[0],
        decks: augustReport.events[0].decks.map((d) => ({ ...d, cardsVerified: false })),
      },
    ],
  };
  const summary = buildTournamentMonthlySummary([unverifiedReport], '2026-08', 'zh');
  assert.equal(summary.verifiedDeckCount, 0);
  assert.equal(summary.topArchetypes.length, 0);
});

test('summary omits unknown archetypes instead of leaking a fixed-language label', () => {
  const unknownReport = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: [{
        ...augustReport.events[0].decks[0],
        archetypeId: null,
        archetypeLabel: null,
        cardsVerified: true,
      }],
    }],
  };
  assert.deepEqual(buildTournamentMonthlySummary([unknownReport], '2026-08', 'zh').topArchetypes, []);
  assert.deepEqual(buildTournamentMonthlySummary([unknownReport], '2026-08', 'ja').topArchetypes, []);
});

// ── 6. DIC-1142 player-focused analysis ─────────────────────────────────────
test('summary carries per-archetype best rank from published data', () => {
  const summary = buildTournamentMonthlySummary([augustReport], '2026-08', 'zh');
  const withBestRank = summary.topArchetypes.filter((a) => a.bestRank === 1);
  assert.ok(
    withBestRank.length > 0,
    'August fixture has champion decks so at least one archetype must show bestRank=1',
  );
  const azkiEntry = summary.topArchetypes.find((a) => a.id === 'azki');
  if (azkiEntry) {
    assert.equal(azkiEntry.bestRank, 1, 'AZKi block A champion should propagate bestRank=1');
    assert.equal(azkiEntry.bestRankLabel, 'champion');
  }
});

test('summary carries per-oshi best rank from published data', () => {
  const summary = buildTournamentMonthlySummary([augustReport], '2026-08', 'zh');
  assert.ok(summary.topOshi.length > 0);
  for (const oshi of summary.topOshi) {
    if (oshi.bestRank != null) {
      assert.ok(oshi.bestRank >= 1, 'best rank is never zero or negative');
      assert.ok(typeof oshi.bestRankLabel === 'string' || oshi.bestRankLabel === null);
    }
  }
});

test('summary best rank stays null when the source published no rank', () => {
  const noRankReport = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: augustReport.events[0].decks.map((d) => ({
        ...d, rank: null, rankLabel: null, cardsVerified: true,
      })),
    }],
  };
  const summary = buildTournamentMonthlySummary([noRankReport], '2026-08', 'zh');
  for (const item of summary.topArchetypes) {
    assert.equal(item.bestRank, null, `${item.label} bestRank must stay null when unpublished`);
    assert.equal(item.bestRankLabel, null);
  }
});

test('representative cards dedupe by cardNumber across printings/versions', () => {
  // Build a fixture with the same card at two versions inside one deck. The
  // dedupe contract is: one deck contains one instance of hBP07-006, no
  // matter how many printings show up in its card array.
  const fixture = {
    deckId: 'deck-1',
    cardsVerified: true,
    cards: [
      { zone: 'oshi', cardNumber: 'hBP07-006', version: 'OSR', count: 1 },
      { zone: 'oshi', cardNumber: 'hBP07-006', version: 'RR', count: 1 },
      { zone: 'main', cardNumber: 'hBP01-044', version: 'P', count: 2 },
    ],
  };
  const rows = buildRepresentativeCards([fixture]);
  const oshiCard = rows.find((r) => r.cardNumber === 'hBP07-006');
  assert.ok(oshiCard);
  assert.equal(oshiCard.deckCount, 1, 'same cardNumber across versions counts as one deck');
  assert.equal(oshiCard.totalCopies, 2, 'copies still sum across printings');
});

test('representative cards use verified sample as adoption denominator', () => {
  const rows = buildRepresentativeCards(verifiedDecks(augustReport.events));
  assert.ok(rows.length > 0, 'August fixture has verified decks so cards must surface');
  for (const row of rows) {
    assert.ok(row.adoptionRate > 0 && row.adoptionRate <= 1, 'adoption is a fraction');
    assert.ok(row.deckCount >= 1);
    assert.ok(row.deckCount <= 2, `August has 2 verified decks — deckCount cannot exceed that; got ${row.deckCount}`);
  }
  assert.ok(rows.length <= REPRESENTATIVE_CARDS_LIMIT);
});

test('representative cards over an empty verified sample is empty', () => {
  assert.deepEqual(buildRepresentativeCards([]), []);
});

test('representative cards ignore unverified decks entirely', () => {
  const unverified = {
    deckId: 'unverified-1',
    cardsVerified: false,
    cards: [{ zone: 'main', cardNumber: 'hBP08-005', version: 'C', count: 4 }],
  };
  // buildRepresentativeCards takes ALREADY-verified decks; upstream summary
  // uses verifiedDecks(). We assert the aggregator does not add anything for a
  // caller that hands it an empty verified slice.
  assert.deepEqual(buildRepresentativeCards([]), []);
  // Sanity: the summary path drops unverified decks so representativeCards
  // stays empty when nothing verified survives.
  const summary = buildTournamentMonthlySummary([{
    ...augustReport,
    events: [{ ...augustReport.events[0], decks: [unverified] }],
  }], '2026-08', 'zh');
  assert.deepEqual(summary.representativeCards, []);
});

test('event highlights extract champion, common cards, and dedupe by cardNumber', () => {
  const highlights = buildEventHighlights(augustReport.events);
  const event = augustReport.events[0];
  const h = highlights.get(event.eventId);
  assert.ok(h, 'every event must have a highlight entry');
  assert.equal(h.showcasedDecks, 2);
  assert.equal(h.verifiedDecks, 2);
  assert.ok(h.championDeckId != null, 'August event has a rank=1 champion');
  assert.ok(h.hasNotableRank, 'a rank=1 deck counts as notable');
  // Common cards must appear in >= 2 verified decks and be deduped by cardNumber.
  for (const c of h.commonCards) {
    assert.ok(c.deckCount >= 2, `${c.cardNumber} appeared in fewer than 2 decks`);
    assert.ok(c.cardNumber && typeof c.cardNumber === 'string');
  }
});

test('event highlights honestly reports no champion when the source published none', () => {
  const noChampionReport = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: augustReport.events[0].decks.map((d) => ({ ...d, rank: null, rankLabel: null })),
    }],
  };
  const highlights = buildEventHighlights(noChampionReport.events);
  const h = highlights.get(noChampionReport.events[0].eventId);
  assert.equal(h.championDeckId, null, 'no champion → null, never invented');
  assert.equal(h.championArchetypeLabel, null);
  assert.equal(h.hasNotableRank, false);
});

test('event highlights common-cards stays empty when only one verified deck exists', () => {
  const oneDeckReport = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: [augustReport.events[0].decks[0]],
    }],
  };
  const highlights = buildEventHighlights(oneDeckReport.events);
  const h = highlights.get(oneDeckReport.events[0].eventId);
  assert.deepEqual(h.commonCards, [], 'single deck cannot yield "common" cards');
});

// ── DIC-1142 CR: champion / top-placement counts and ja CN-leak gates ───────
test('summary champion count uses numeric rank only, never rankLabel', () => {
  const mixed = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: [
        // Two AZKi decks: one is source-published rank=1, the other only carries
        // a "champion" rankLabel with rank=null — the second must NOT count.
        {
          ...augustReport.events[0].decks[0],
          deckId: 'a', decklogCode: 'a', rank: 1, rankLabel: 'champion', cardsVerified: true,
        },
        {
          ...augustReport.events[0].decks[0],
          deckId: 'b', decklogCode: 'b', rank: null, rankLabel: 'champion', cardsVerified: true,
        },
      ],
    }],
  };
  const summary = buildTournamentMonthlySummary([mixed], '2026-08', 'zh');
  const azki = summary.topArchetypes.find((a) => a.id === 'azki');
  assert.ok(azki);
  assert.equal(azki.championCount, 1, 'rankLabel="champion" without numeric rank cannot inflate champion count');
  assert.equal(azki.topPlacementCount, 1, 'top-placement also requires numeric rank');
});

test('summary top-placement count spans ranks 1–4 inclusive; > 4 does not qualify', () => {
  const ranks = {
    ...augustReport,
    events: [{
      ...augustReport.events[0],
      decks: [
        { ...augustReport.events[0].decks[0], deckId: '1', decklogCode: '1', rank: 1, cardsVerified: true },
        { ...augustReport.events[0].decks[0], deckId: '2', decklogCode: '2', rank: 2, cardsVerified: true },
        { ...augustReport.events[0].decks[0], deckId: '3', decklogCode: '3', rank: 4, cardsVerified: true },
        { ...augustReport.events[0].decks[0], deckId: '4', decklogCode: '4', rank: 5, cardsVerified: true },
        { ...augustReport.events[0].decks[0], deckId: '5', decklogCode: '5', rank: 8, cardsVerified: true },
      ],
    }],
  };
  const summary = buildTournamentMonthlySummary([ranks], '2026-08', 'zh');
  const azki = summary.topArchetypes.find((a) => a.id === 'azki');
  assert.ok(azki);
  assert.equal(azki.championCount, 1, 'only rank=1 counts as champion');
  assert.equal(azki.topPlacementCount, 3, 'ranks 1, 2, 4 count as top placements; rank 5 and 8 do not');
});

test('summary champion/top-placement counts on real August fixture', () => {
  const summary = buildTournamentMonthlySummary([augustReport], '2026-08', 'zh');
  const azki = summary.topArchetypes.find((a) => a.id === 'azki');
  const auroChrony = summary.topArchetypes.find((a) => a.id === 'auro-chrony');
  assert.ok(azki && auroChrony, 'August fixture publishes both A-block and B-block champions');
  assert.equal(azki.championCount, 1);
  assert.equal(auroChrony.championCount, 1);
  assert.equal(azki.topPlacementCount, 1);
  assert.equal(auroChrony.topPlacementCount, 1);
});

test('ja summary path does not surface Chinese runtime coverage/source strings', () => {
  // Assert against the SIGNATURE Chinese fragments that live in the fixture
  // JSON's source.name / source.disclaimer / coverage.note / event.coverageNote —
  // none should be reachable via the values buildTournamentMonthlySummary
  // returns for language: 'ja'. This guards the runtime-JSON leak Codex flagged
  // in CR §3, which the JSX static gate cannot see.
  const summary = buildTournamentMonthlySummary([augustReport, julyReport], ALL_SCOPE, 'ja');
  const CN_MARKERS = ['資料僅來自', '本月僅收錄', '官方於 X 公布', '官方專欄', '牌組卡表已透過'];
  const materialized = JSON.stringify(summary);
  for (const marker of CN_MARKERS) {
    assert.ok(!materialized.includes(marker), `ja summary must not carry CN marker: ${marker}`);
  }
});

// ── DIC-1154 Stage 1 CR §regression guard ───────────────────────────────────
// Every locale value on a reachable PriceAlertEditor / watchlist / card-detail
// alert surface must name the entity — 價格提醒 in zh, 価格アラート in ja. A
// bare "提醒" / "アラート" is a CR regression that made it past the earlier
// grep-only sweep; enumerate the exact keys so a future edit that drops the
// prefix fails here, not in a screen review.
test('DIC-1154 alert-entity naming holds on every reachable editor/watchlist key', () => {
  // Every key whose value is user-visible on the PriceAlertEditor modal, the
  // WatchlistScreen list, the CardDetailScreen action row, the deck editor
  // alert row, the settings sync copy, or the notification title. Kept as an
  // explicit list so removing a surface deletes a line here too.
  const REACHABLE_ALERT_KEYS = [
    // PriceAlertEditor
    'price_alert_save',
    'price_alert_save_a11y',
    'price_alert_remove',
    'price_alert_no_printings',
    'price_alert_choose_printing_error',
    'price_alert_unrecognized_printing_error',
    // WatchlistScreen
    'watchlist_title',
    'watchlist_empty',
    'watchlist_empty_title',
    'watchlist_remove_alert',
    'watchlist_remove_alert_confirm',
    'watchlist_remove_a11y',
    'watchlist_resolve_a11y',
    // CardDetailScreen alert row
    'card_detail_add_watchlist',
    'card_detail_watchlist_added',
    'card_detail_watchlist_add',
    'card_detail_watchlist_added_remove',
    'card_detail_watchlist_remove_title',
    'card_detail_watchlist_remove_confirm',
    'card_detail_alert_one',
    'card_detail_alert_many',
    'card_detail_alert_set',
    'card_detail_alert_a11y',
    // Deck editor + settings sync copy that name the feature
    'deck_alert_unavailable',
    'settings_link_hint_watchlist',
    'settings_guest_sync_watchlist',
    // Nav drawer label
    'nav_watchlist',
  ];

  for (const key of REACHABLE_ALERT_KEYS) {
    assert.ok(zh[key].includes('價格提醒'),
      `zh.${key} must name the entity 價格提醒, got: ${zh[key]}`);
    assert.ok(ja[key].includes('価格アラート'),
      `ja.${key} must name the entity 価格アラート, got: ${ja[key]}`);
  }
});

test('DIC-1154 no reachable alert copy leaks the pre-unification names', () => {
  const FORBIDDEN_ZH = ['到價提醒', '入手提醒', '趨勢追蹤'];
  const FORBIDDEN_JA = ['ほしい物アラート', '価格推移の追跡'];
  for (const [key, val] of Object.entries(zh)) {
    for (const bad of FORBIDDEN_ZH) {
      assert.ok(!val.includes(bad), `zh.${key} still names legacy "${bad}": ${val}`);
    }
  }
  for (const [key, val] of Object.entries(ja)) {
    for (const bad of FORBIDDEN_JA) {
      assert.ok(!val.includes(bad), `ja.${key} still names legacy "${bad}": ${val}`);
    }
  }
});

console.log(`test-i18n: PASS (${passed} checks)`);
