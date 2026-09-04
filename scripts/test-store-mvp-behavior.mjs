#!/usr/bin/env node
/**
 * DIC-1256 owner correction: build-time-define proof of behavior.
 *
 * Spawns the render probe TWICE from the same main codebase — once with
 * `EXPO_PUBLIC_STORE_MVP=1` (production / production-apk / preview) and once
 * with `EXPO_PUBLIC_STORE_MVP=0` (staging / development) — then asserts:
 *
 *   • STORE_MVP=1 → every gated FEATURES.* flag resolves to false AND every
 *     gated card-detail / login surface is absent from the rendered DOM
 *     (hidden / fail-closed).
 *   • STORE_MVP=0 → every gated flag resolves to true AND every gated surface
 *     is present in the rendered DOM (staging/dev unchanged).
 *   • Retained surfaces (官方卡表, card name, keywords, external-links
 *     header) render in BOTH modes.
 *   • Cross-check: the two probes' DOMs actually differ on every gated
 *     testID / text — otherwise the render assertion is vacuously green.
 *
 * The two probes run in isolated subprocesses so `releaseFlags.ts`'s module
 * cache and STORE_MVP resolution flip cleanly for each env. Same source tree,
 * same commit — only the define differs.
 *
 * Run: node scripts/test-store-mvp-behavior.mjs
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');
const probePath = path.join(__dirname, 'lib', 'store-mvp-behavior-probe.mjs');
const registerHook = path.join(__dirname, 'register-web-render.mjs');

function runProbe(envValue) {
  const env = { ...process.env };
  if (envValue === undefined) delete env.EXPO_PUBLIC_STORE_MVP;
  else env.EXPO_PUBLIC_STORE_MVP = envValue;

  const result = spawnSync('node', [
    '--experimental-strip-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--import', registerHook,
    probePath,
  ], {
    cwd: repoRoot,
    env,
    encoding: 'utf-8',
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.status !== 0) {
    console.error(`\n── probe FAILED (EXPO_PUBLIC_STORE_MVP=${JSON.stringify(envValue)}) ──`);
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.error('\n--- stdout ---\n' + result.stdout);
    throw new Error(`probe exit status ${result.status}`);
  }

  // The probe writes exactly one JSON blob to stdout. There might be Node
  // warnings on stdout too (unlikely with --disable-warning); take the last
  // non-empty line that parses as JSON.
  const lines = result.stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]);
    } catch { /* keep looking */ }
  }
  throw new Error(`probe stdout produced no JSON. stdout:\n${result.stdout}`);
}

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

// ── The full allowlist of gated features. Every one of these must be false
//    under STORE_MVP=1 and true under STORE_MVP=0 (fail-closed profile). ──
const GATED_FLAGS = [
  'favorites',
  'marketData',
  'externalPriceLinks',
  'watchlist',
  'buyPrice',
  'priceSpread',
  'trendPrediction',
  'newsSentiment',
  'ytStats',
  'pushAlerts',
  'premium',
];

// ── The card-detail render markers. Each corresponds to one of the gates on
//    CardDetailScreen: favorites (ownership widget), marketData
//    (MarketDataPanel), externalPriceLinks (查即時價 CTA + yuyu + Carousell),
//    and watchlist (top chip + bottom button). The top price section moved to
//    SELL_PRICE_MARKERS in DIC-1319. ──
const GATED_DETAIL_MARKERS = [
  ['collectionCard (favorites)', 'hasCollectionCard'],
  ['市場數據 section title (marketData)', 'hasMarketDataTitle'],
  ['查即時價 CTA (externalPriceLinks)', 'hasLivePriceCta'],
  ['遊々亭 external link (externalPriceLinks)', 'hasYuyuLink'],
  ['Carousell external link (externalPriceLinks)', 'hasCarousellLink'],
  ['到價提醒 chip (watchlist)', 'hasWatchlistChip'],
  ['到價提醒 bottom button (watchlist)', 'hasWatchlistBtn'],
];

// ── DIC-1319 sale-price markers: the surfaces the v21 closed test shipped
//    blank. They ride on FEATURES.sellPrice, which is unconditionally true, so
//    each must be PRESENT under STORE_MVP=1 as well as =0. They are
//    deliberately excluded from the "presence must differ" cross-check further
//    down — not differing is the whole point of the flag. ──
const SELL_PRICE_MARKERS = [
  ['detail', 'card-detail price section', 'hasPriceSection'],
  ['detail', 'card-detail price-like text (¥/NT$/$)', 'hasPriceLikeText'],
  ['scanResult', 'ScanResultCard prices section', 'hasPricesSection'],
  ['scanResult', 'ScanResultCard price-like text (¥/NT$/$)', 'hasPriceLikeText'],
  ['scanCandidate', 'ScanCandidateSelector meta price-like text', 'hasPriceLikeInMeta'],
  ['searchResult', 'SearchResults card price badge row', 'hasPriceBadgeRow'],
  ['searchResult', 'SearchResults card no-trade badge', 'hasNoTradeBadge'],
  ['searchResult', 'SearchResults card price-like text (¥/NT$/$)', 'hasPriceLikeText'],
];

// ── Scan surface markers that stay gated (DIC-1258 CR blocker → DIC-1256).
//    Cross-printing comparison and session valuation totals remain hidden;
//    retained surfaces (card name / number / rarity / candidate title /
//    session count / clear) stay present in both modes. ──
const GATED_SCAN_RESULT_MARKERS = [
  ['ScanResultCard cross-printing variants section', 'hasVariantsSection'],
];
const GATED_SCAN_SESSION_MARKERS = [
  ['ScanSessionPanel header total price', 'hasHeaderTotalPrice'],
  ['ScanSessionPanel currency selector row', 'hasCurrencyRow'],
  ['ScanSessionPanel footer total row', 'hasTotalRow'],
  ['ScanSessionPanel 複製結果 (copy-export) button', 'hasCopyResultsBtn'],
  ['ScanSessionPanel any price-like text (¥/NT$/$)', 'hasPriceLikeText'],
];
const GATED_DECK_EDITOR_MARKERS = [
  ['DeckEditor gap-price (marketData)', 'hasGapPrice'],
  ['DeckEditor deck-gap-totals block (marketData)', 'hasGapTotals'],
  ['DeckEditor gap-subtotal-JPY (marketData)', 'hasGapSubtotalJPY'],
  ['DeckEditor price-alert CTA (watchlist)', 'hasAlertOpen'],
  ['DeckEditor "yuyu-tei.jp" source copy (marketData)', 'hasGapSourceCopy'],
];

// ── Must-retain markers. Card image / name / number / keyword / official
//    卡表 / external-links header — visible in BOTH modes so cardholders
//    can still identify a card and open the official gallery. ──
const RETAINED_DETAIL_MARKERS = [
  '  detail retains card name in both modes',
  '  detail retains card number in both modes',
  '  detail retains 官方卡表 link in both modes',
  '  detail retains 搜尋關鍵字 section in both modes',
  '  detail retains 外部連結 section header in both modes',
];

console.log('── Probe 1: EXPO_PUBLIC_STORE_MVP=1 (production / production-apk / preview) ──');
console.log('     → Store MVP ON → every gated feature must be hidden / fail-closed.\n');
const on = runProbe('1');

for (const flag of GATED_FLAGS) {
  check(`STORE_MVP=1: FEATURES.${flag} === false`, on.features[flag] === false, `got ${JSON.stringify(on.features[flag])}`);
}
for (const [label, key] of GATED_DETAIL_MARKERS) {
  check(`STORE_MVP=1: CardDetail hides ${label}`, on.detail[key] === false, `got ${JSON.stringify(on.detail[key])}`);
}
check('STORE_MVP=1: CardDetail retains 官方卡表 link', on.detail.hasOfficialLink === true);
check('STORE_MVP=1: CardDetail retains card name', on.detail.hasCardName === true);
check('STORE_MVP=1: CardDetail retains card number', on.detail.hasCardNumber === true);
check('STORE_MVP=1: CardDetail retains 搜尋關鍵字 section', on.detail.hasKeywordsSection === true);
check('STORE_MVP=1: CardDetail retains 外部連結 section header', on.detail.hasExternalLinksHeader === true);
check(
  'STORE_MVP=1: LoginScreen shows the store-only description (no 收藏 / 提醒 / 趨勢 claim)',
  on.login.usesStoreDescription === true && on.login.usesFullDescription === false,
  `usesStore=${on.login.usesStoreDescription} usesFull=${on.login.usesFullDescription}`,
);
for (const [label, key] of GATED_SCAN_RESULT_MARKERS) {
  check(`STORE_MVP=1: ScanResultCard hides ${label}`, on.scanResult[key] === false, `got ${JSON.stringify(on.scanResult[key])}`);
}
check('STORE_MVP=1: ScanResultCard retains card name', on.scanResult.hasCardName === true);
check('STORE_MVP=1: ScanResultCard retains card number', on.scanResult.hasCardNumber === true);
check('STORE_MVP=1: ScanResultCard retains rarity badge', on.scanResult.hasRarityBadge === true);
check('STORE_MVP=1: ScanCandidateSelector retains card number', on.scanCandidate.hasCardNumber === true);
check('STORE_MVP=1: ScanCandidateSelector retains candidate title', on.scanCandidate.hasCandidateTitle === true);
check('STORE_MVP=1: ScanCandidateSelector retains rescan action', on.scanCandidate.hasRescanAction === true);
for (const [label, key] of GATED_SCAN_SESSION_MARKERS) {
  check(`STORE_MVP=1: ScanSessionPanel hides ${label}`, on.scanSession[key] === false, `got ${JSON.stringify(on.scanSession[key])}`);
}
check(
  'STORE_MVP=1: ScanSessionPanel header shows store-only title (no 估值 claim)',
  on.scanSession.hasStoreTitle === true && on.scanSession.hasEstimateTitle === false,
  `store=${on.scanSession.hasStoreTitle} estimate=${on.scanSession.hasEstimateTitle}`,
);
check(
  'STORE_MVP=1: ScanSessionPanel version hint uses store variant (no 估價 claim)',
  on.scanSession.hasStoreVersionHint === true && on.scanSession.hasEstimateVersionHint === false,
);
check('STORE_MVP=1: ScanSessionPanel retains session count', on.scanSession.hasSessionCount === true);
check('STORE_MVP=1: ScanSessionPanel retains clear action', on.scanSession.hasClearAction === true);
check('STORE_MVP=1: SearchResults retains card name', on.searchResult.hasCardName === true);
check('STORE_MVP=1: SearchResults retains card number', on.searchResult.hasCardNumber === true);
for (const [label, key] of GATED_DECK_EDITOR_MARKERS) {
  check(`STORE_MVP=1: DeckEditor hides ${label}`, on.deckEditor[key] === false, `got ${JSON.stringify(on.deckEditor[key])}`);
}
check(
  'STORE_MVP=1: DeckEditor gap panel uses store title (no 參考售價 claim)',
  on.deckEditor.hasStoreTitle === true && on.deckEditor.hasEstimateTitle === false,
  `store=${on.deckEditor.hasStoreTitle} estimate=${on.deckEditor.hasEstimateTitle}`,
);
check('STORE_MVP=1: DeckEditor retains missing-card number for deck-editing help', on.deckEditor.hasCardNumber === true);

// DIC-1319 CR: a store build must never instruct the user to use a section it
// hides. The multi-printing price list renders under FEATURES.sellPrice, but
// both of its original hints say "pick a version below in 「市場數據」" — and
// MarketDataPanel is gated on FEATURES.marketData. The probe fixture carries two
// priced printings specifically so this branch is exercised.
check(
  'STORE_MVP=1: multi-printing price list renders its hint',
  on.detail.hasVariantHint === true,
  `got ${JSON.stringify(on.detail.hasVariantHint)}`,
);
check(
  'STORE_MVP=1: the hint uses the store variant, which names no gated section',
  on.detail.hasStoreVariantHint === true && on.detail.hasMarketDataVariantHint === false,
  `store=${on.detail.hasStoreVariantHint} marketData=${on.detail.hasMarketDataVariantHint}`,
);
check(
  'STORE_MVP=1: the rendered card detail never mentions 市場數據 at all',
  on.detail.namesMarketDataSection === false,
  `got ${JSON.stringify(on.detail.namesMarketDataSection)}`,
);

// DIC-1319: the store build MUST show the sale price of the printing in hand.
// These are the assertions that would have caught the v21 closed-test defect.
for (const [surface, label, key] of SELL_PRICE_MARKERS) {
  check(
    `STORE_MVP=1: ${label} is SHOWN (FEATURES.sellPrice)`,
    on[surface][key] === true,
    `got ${JSON.stringify(on[surface][key])}`,
  );
}

console.log('\n── Probe 2: EXPO_PUBLIC_STORE_MVP=0 (staging / development) ──');
console.log('     → Store MVP OFF → every gated feature must be present unchanged.\n');
const off = runProbe('0');

for (const flag of GATED_FLAGS) {
  check(`STORE_MVP=0: FEATURES.${flag} === true`, off.features[flag] === true, `got ${JSON.stringify(off.features[flag])}`);
}
for (const [label, key] of GATED_DETAIL_MARKERS) {
  check(`STORE_MVP=0: CardDetail shows ${label}`, off.detail[key] === true, `got ${JSON.stringify(off.detail[key])}`);
}
check('STORE_MVP=0: CardDetail retains 官方卡表 link', off.detail.hasOfficialLink === true);
check('STORE_MVP=0: CardDetail retains card name', off.detail.hasCardName === true);
check('STORE_MVP=0: CardDetail retains card number', off.detail.hasCardNumber === true);
check('STORE_MVP=0: CardDetail retains 搜尋關鍵字 section', off.detail.hasKeywordsSection === true);
check('STORE_MVP=0: CardDetail retains 外部連結 section header', off.detail.hasExternalLinksHeader === true);
check(
  'STORE_MVP=0: LoginScreen shows the full description (with 收藏 / 提醒 / 趨勢)',
  off.login.usesFullDescription === true && off.login.usesStoreDescription === false,
  `usesStore=${off.login.usesStoreDescription} usesFull=${off.login.usesFullDescription}`,
);
for (const [label, key] of GATED_SCAN_RESULT_MARKERS) {
  check(`STORE_MVP=0: ScanResultCard shows ${label}`, off.scanResult[key] === true, `got ${JSON.stringify(off.scanResult[key])}`);
}
check('STORE_MVP=0: ScanResultCard retains card name', off.scanResult.hasCardName === true);
check('STORE_MVP=0: ScanResultCard retains card number', off.scanResult.hasCardNumber === true);
check('STORE_MVP=0: ScanResultCard retains rarity badge', off.scanResult.hasRarityBadge === true);
check('STORE_MVP=0: ScanCandidateSelector retains card number', off.scanCandidate.hasCardNumber === true);
check('STORE_MVP=0: ScanCandidateSelector retains candidate title', off.scanCandidate.hasCandidateTitle === true);
check('STORE_MVP=0: ScanCandidateSelector retains rescan action', off.scanCandidate.hasRescanAction === true);
for (const [label, key] of GATED_SCAN_SESSION_MARKERS) {
  check(`STORE_MVP=0: ScanSessionPanel shows ${label}`, off.scanSession[key] === true, `got ${JSON.stringify(off.scanSession[key])}`);
}
check(
  'STORE_MVP=0: ScanSessionPanel header shows the estimate title (with 估值 claim)',
  off.scanSession.hasEstimateTitle === true && off.scanSession.hasStoreTitle === false,
);
check(
  'STORE_MVP=0: ScanSessionPanel version hint uses the estimate variant (with 估價 claim)',
  off.scanSession.hasEstimateVersionHint === true && off.scanSession.hasStoreVersionHint === false,
);
check('STORE_MVP=0: ScanSessionPanel retains session count', off.scanSession.hasSessionCount === true);
check('STORE_MVP=0: ScanSessionPanel retains clear action', off.scanSession.hasClearAction === true);
check('STORE_MVP=0: SearchResults retains card name', off.searchResult.hasCardName === true);
check('STORE_MVP=0: SearchResults retains card number', off.searchResult.hasCardNumber === true);
for (const [label, key] of GATED_DECK_EDITOR_MARKERS) {
  check(`STORE_MVP=0: DeckEditor shows ${label}`, off.deckEditor[key] === true, `got ${JSON.stringify(off.deckEditor[key])}`);
}
check(
  'STORE_MVP=0: DeckEditor gap panel uses estimate title (with 參考售價 claim)',
  off.deckEditor.hasEstimateTitle === true && off.deckEditor.hasStoreTitle === false,
);
check('STORE_MVP=0: DeckEditor retains missing-card number', off.deckEditor.hasCardNumber === true);

check(
  'STORE_MVP=0: the hint keeps its market-data wording, because that section is there',
  off.detail.hasMarketDataVariantHint === true && off.detail.hasStoreVariantHint === false,
  `store=${off.detail.hasStoreVariantHint} marketData=${off.detail.hasMarketDataVariantHint}`,
);
check(
  'STORE_MVP=0: the multi-printing price list still renders its hint',
  off.detail.hasVariantHint === true,
);

// The same sale-price surfaces stay visible on staging/dev — FEATURES.sellPrice
// is profile-independent, so both probes must agree here.
for (const [surface, label, key] of SELL_PRICE_MARKERS) {
  check(
    `STORE_MVP=0: ${label} is SHOWN (FEATURES.sellPrice)`,
    off[surface][key] === true,
    `got ${JSON.stringify(off[surface][key])}`,
  );
}

// ── Vacuousness guard: the two probes MUST disagree on every gated marker.
//    If they don't, the profile isn't actually flipping the render — the
//    "hidden" assertion would be trivially green. ──
console.log('\n── Cross-check: STORE_MVP=1 vs =0 DOM diff must span every gated surface ──');
for (const [label, key] of GATED_DETAIL_MARKERS) {
  check(
    `STORE_MVP=1 vs =0: ${label} presence differs (${on.detail[key]} vs ${off.detail[key]})`,
    on.detail[key] !== off.detail[key],
  );
}
for (const [label, key] of GATED_SCAN_RESULT_MARKERS) {
  check(
    `STORE_MVP=1 vs =0: ${label} presence differs (${on.scanResult[key]} vs ${off.scanResult[key]})`,
    on.scanResult[key] !== off.scanResult[key],
  );
}
for (const [label, key] of GATED_SCAN_SESSION_MARKERS) {
  check(
    `STORE_MVP=1 vs =0: ${label} presence differs (${on.scanSession[key]} vs ${off.scanSession[key]})`,
    on.scanSession[key] !== off.scanSession[key],
  );
}
for (const [label, key] of GATED_DECK_EDITOR_MARKERS) {
  check(
    `STORE_MVP=1 vs =0: ${label} presence differs (${on.deckEditor[key]} vs ${off.deckEditor[key]})`,
    on.deckEditor[key] !== off.deckEditor[key],
  );
}
check(
  'STORE_MVP=1 vs =0: DeckEditor gap-panel title text swaps between store/estimate',
  on.deckEditor.hasStoreTitle !== off.deckEditor.hasStoreTitle
    && on.deckEditor.hasEstimateTitle !== off.deckEditor.hasEstimateTitle,
);
check(
  'STORE_MVP=1 vs =0: ScanSessionPanel header title text swaps between store/estimate',
  on.scanSession.hasStoreTitle !== off.scanSession.hasStoreTitle
    && on.scanSession.hasEstimateTitle !== off.scanSession.hasEstimateTitle,
);
check(
  'STORE_MVP=1 vs =0: ScanSessionPanel version hint text swaps between store/estimate',
  on.scanSession.hasStoreVersionHint !== off.scanSession.hasStoreVersionHint
    && on.scanSession.hasEstimateVersionHint !== off.scanSession.hasEstimateVersionHint,
);
// DIC-1319 inverse cross-check: the sale-price surfaces must NOT differ. If a
// future change re-gates one of them on the profile, this flips red even
// though the "hidden under STORE_MVP=1" style of assertion would look fine.
for (const [surface, label, key] of SELL_PRICE_MARKERS) {
  check(
    `STORE_MVP=1 vs =0: ${label} is present in BOTH profiles (${on[surface][key]} vs ${off[surface][key]})`,
    on[surface][key] === true && off[surface][key] === true,
  );
}
check(
  'STORE_MVP=1 vs =0: the variant hint wording swaps between store/market-data',
  on.detail.hasStoreVariantHint !== off.detail.hasStoreVariantHint
    && on.detail.hasMarketDataVariantHint !== off.detail.hasMarketDataVariantHint,
);
check(
  'STORE_MVP=1 vs =0: FEATURES.sellPrice does not flip with the profile',
  on.features.sellPrice === true && off.features.sellPrice === true,
);
for (const flag of GATED_FLAGS) {
  check(
    `STORE_MVP=1 vs =0: FEATURES.${flag} flips (${on.features[flag]} vs ${off.features[flag]})`,
    on.features[flag] !== off.features[flag],
  );
}
check(
  'STORE_MVP=1 vs =0: LoginScreen description text swaps',
  on.login.usesStoreDescription !== off.login.usesStoreDescription
    && on.login.usesFullDescription !== off.login.usesFullDescription,
);

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Store MVP behavior regression: ${passed} checks passed across both env values`);
} else {
  console.error(`\n❌ Store MVP behavior regression failed`);
}
