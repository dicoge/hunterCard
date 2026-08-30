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

// ── The card-detail render markers. Each corresponds to one of the four
//    gates on CardDetailScreen: favorites (ownership widget), marketData
//    (top price section AND MarketDataPanel), externalPriceLinks (yuyu +
//    Carousell), and watchlist (top chip + bottom button). ──
const GATED_DETAIL_MARKERS = [
  ['collectionCard (favorites)', 'hasCollectionCard'],
  ['top priceSection (marketData)', 'hasPriceSection'],
  ['市場數據 section title (marketData)', 'hasMarketDataTitle'],
  ['遊々亭 external link (externalPriceLinks)', 'hasYuyuLink'],
  ['Carousell external link (externalPriceLinks)', 'hasCarousellLink'],
  ['到價提醒 chip (watchlist)', 'hasWatchlistChip'],
  ['到價提醒 bottom button (watchlist)', 'hasWatchlistBtn'],
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
