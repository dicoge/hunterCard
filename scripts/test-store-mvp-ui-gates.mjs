#!/usr/bin/env node
/**
 * DIC-1256 regression: the Store MVP profile must hide favorites / market data
 * / external price links / watchlist / paid entry on the SURFACES the review
 * build renders, not only in the data mapping layer.
 *
 * The field-strip and native-export tests already prove the shipped data
 * artifact carries no forbidden fields. This test proves the RENDER paths that
 * would otherwise resurface those hidden surfaces (drawer entry, card-detail
 * price section, external price links, login/settings copy) are all wrapped in
 * `{FEATURES.<flag> && ...}` — so an accidental removal of a gate breaks the
 * suite instead of the store review.
 *
 * The gates are asserted by parsing the actual source with regexes. Static
 * checks intentionally, because full component render requires react-native and
 * a full RN env — the fast suite mustn't take on that boot cost, and the value
 * we care about is the invariant that the gates STAY on every surface.
 *
 * Run: node scripts/test-store-mvp-ui-gates.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(repoRoot, rel), 'utf-8');
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

// ── 1. FEATURES exposes the three new umbrella flags derived from STORE_MVP ──
const flags = read('src/config/releaseFlags.ts');
check(
  'releaseFlags: FEATURES.favorites is derived from !STORE_MVP',
  /favorites:\s*!STORE_MVP/.test(flags),
);
check(
  'releaseFlags: FEATURES.marketData is derived from !STORE_MVP',
  /marketData:\s*!STORE_MVP/.test(flags),
);
// DIC-1319: the plain sale price of the printing in hand is the product's
// primary path, so it is the ONE price flag that is unconditionally on. If it
// ever becomes STORE_MVP-derived again, the store build ships blank prices —
// exactly the v21 closed-test defect.
check(
  'releaseFlags: FEATURES.sellPrice is unconditionally true (DIC-1319)',
  /sellPrice:\s*true\s*,/.test(flags),
);
check(
  'releaseFlags: FEATURES.sellPrice is NOT derived from STORE_MVP',
  !/sellPrice:\s*!?STORE_MVP/.test(flags),
);
check(
  'releaseFlags: FEATURES.externalPriceLinks is derived from !STORE_MVP',
  /externalPriceLinks:\s*!STORE_MVP/.test(flags),
);
check(
  'releaseFlags: FEATURES.watchlist still gated on !STORE_MVP (regression)',
  /watchlist:\s*!STORE_MVP/.test(flags),
);
check(
  'releaseFlags: FEATURES.premium still gated on !STORE_MVP (regression)',
  /premium:\s*!STORE_MVP/.test(flags),
);

// ── 2. Drawer routes fail-closed: Collection AND Watchlist unregistered
//        under Store MVP. Removing the Drawer.Screen unregisters the route so
//        `navigation.navigate('Collection')` and deep links both throw — the
//        acceptance criterion says "not only hidden menus". ──
const nav = read('src/navigation/AppNavigator.tsx');
check(
  'AppNavigator: Collection Drawer.Screen wrapped in {FEATURES.favorites && ...}',
  /\{FEATURES\.favorites\s*&&[^}]*<Drawer\.Screen[^>]*name="Collection"/s.test(nav),
);
check(
  'AppNavigator: Watchlist Drawer.Screen still wrapped in {FEATURES.watchlist && ...} (regression)',
  /\{FEATURES\.watchlist\s*&&[^}]*<Drawer\.Screen[^>]*name="Watchlist"/s.test(nav),
);
// Every other drawer entry (Home / Scan / Search / DeckEditor / TournamentReport
// / Tutorial / Settings) must NOT be wrapped in any FEATURES gate — those are
// the retained surfaces.
for (const name of ['Home', 'Scan', 'Search', 'DeckEditor', 'TournamentReport', 'Tutorial', 'Settings']) {
  const beforeIdx = nav.indexOf(`name="${name}"`);
  assert.notEqual(beforeIdx, -1, `AppNavigator must still declare ${name}`);
  // Look at the ~200 chars preceding the name= to confirm no FEATURES.* gate
  // was accidentally added.
  const preceding = nav.slice(Math.max(0, beforeIdx - 200), beforeIdx);
  check(
    `AppNavigator: ${name} drawer entry is NOT gated under FEATURES.*`,
    !/\{FEATURES\.[a-zA-Z]+\s*&&\s*\(\s*<Drawer\.Screen[^>]*$/.test(preceding),
  );
}

// ── 3. Card detail: the four gates that had to land ──
const detail = read('src/screens/CardDetailScreen.tsx');
check(
  'CardDetailScreen: per-card 收藏 (ownership) widget wrapped in {FEATURES.favorites && ...}',
  /\{FEATURES\.favorites\s*&&\s*collectionVersion/.test(detail),
);
check(
  'CardDetailScreen: top price section wrapped in {FEATURES.sellPrice && ...} (DIC-1319)',
  /\{FEATURES\.sellPrice\s*&&\s*\(\s*<View[^>]*styles\.priceSection/s.test(detail),
);
check(
  'CardDetailScreen: 查即時價 CTA inside the price section is gated on FEATURES.externalPriceLinks (DIC-1319)',
  /\{FEATURES\.externalPriceLinks\s*&&\s*\(\s*<TouchableOpacity[^>]*styles\.checkPriceBtn/s.test(detail),
);
check(
  'CardDetailScreen: MarketDataPanel invocation wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*<MarketDataPanel/.test(detail),
);
check(
  'CardDetailScreen: yuyu-tei and Carousell external links wrapped in {FEATURES.externalPriceLinks && ...}',
  /\{FEATURES\.externalPriceLinks\s*&&[\s\S]*?card_detail_yuyu_link[\s\S]*?card_detail_carousell_link/.test(detail),
);
{
  // Scope the official-list assertion to the EXTERNAL LINKS section. Checking
  // "no FEATURES.externalPriceLinks gate appears anywhere before it" was
  // over-broad: DIC-1319 added a second externalPriceLinks gate higher up (the
  // 查即時價 CTA), which made the old regex match across unrelated blocks and
  // report a retained link as gated.
  const sectionStart = detail.indexOf("card_detail_external_links");
  const sectionEnd = detail.indexOf('{FEATURES.watchlist', sectionStart);
  const externalSection = detail.slice(sectionStart, sectionEnd === -1 ? undefined : sectionEnd);
  const officialIdx = externalSection.indexOf('card_detail_official_list');
  const gateIdx = externalSection.indexOf('{FEATURES.externalPriceLinks');
  check(
    'CardDetailScreen: 官方卡表 external link is NOT gated (must retain)',
    /<LinkButton[^/]*text=\{t\('card_detail_official_list'\)\}[^/]*\/>/.test(externalSection)
      && officialIdx !== -1 && gateIdx !== -1 && officialIdx < gateIdx,
  );
}
check(
  'CardDetailScreen: 到價提醒 top chip still wrapped in {FEATURES.watchlist && ...} (regression)',
  /\{FEATURES\.watchlist\s*&&\s*\(\s*<View style=\{styles\.topActionRow\}/s.test(detail),
);
check(
  'CardDetailScreen: 到價提醒 bottom button still wrapped in {FEATURES.watchlist && ...} (regression)',
  /\{FEATURES\.watchlist\s*&&\s*\(\s*<View style=\{styles\.section\}>[\s\S]*?watchlistBtn/s.test(detail),
);

// ── 3b. Scan surfaces (DIC-1258 CR → DIC-1256 → DIC-1319).
//        The scanned printing's OWN sale price is the primary path and rides on
//        FEATURES.sellPrice, so it survives the store build. Cross-printing
//        comparison stays on FEATURES.marketData and stays hidden. ──
const scanResult = read('src/components/ScanResultCard.tsx');
check(
  'ScanResultCard: prices section wrapped in {FEATURES.sellPrice && ...} (DIC-1319)',
  /\{FEATURES\.sellPrice\s*&&\s*\(\s*<View style=\{styles\.pricesSection\}/s.test(scanResult),
);
check(
  'ScanResultCard: cross-printing variants section still wrapped in {FEATURES.marketData && variants && ...}',
  /\{FEATURES\.marketData\s*&&\s*variants\s*&&\s*\(\s*<View style=\{styles\.variantsSection\}/s.test(scanResult),
);

const scanCandidate = read('src/components/ScanCandidateSelector.tsx');
check(
  'ScanCandidateSelector: meta price segment gated on FEATURES.sellPrice (DIC-1319)',
  /FEATURES\.sellPrice\s*\?\s*`\s+\$\{formatPrice\(card\.sellPrice\)\}`\s*:\s*''/.test(scanCandidate),
);

const scanSession = read('src/components/ScanSessionPanel.tsx');
check(
  'ScanSessionPanel: header total price wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<Text style=\{styles\.totalPrice\}/s.test(scanSession),
);
check(
  'ScanSessionPanel: currency selector row wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<View style=\{styles\.currencyRow\}/s.test(scanSession),
);
check(
  'ScanSessionPanel: footer total row wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<View style=\{styles\.totalRow\}/s.test(scanSession),
);
check(
  'ScanSessionPanel: 複製結果 button wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<TouchableOpacity[\s\S]*?scan_copy_results/s.test(scanSession),
);
check(
  'ScanSessionPanel: header title swaps to store variant under !FEATURES.marketData',
  /FEATURES\.marketData\s*\?\s*'scan_session_title'\s*:\s*'scan_session_title_store'/.test(scanSession),
);
check(
  'ScanSessionPanel: version select hint swaps to store variant under !FEATURES.marketData',
  /FEATURES\.marketData\s*\?\s*'scan_version_select_hint'\s*:\s*'scan_version_select_hint_store'/.test(scanSession),
);
check(
  'ScanSessionPanel: version chip price segment gated on FEATURES.marketData',
  /FEATURES\.marketData\s*\?\s*`\$\{v\.name\}\s*·\s*\$\{formatPrice\(v\.sellPrice\)\}`\s*:\s*v\.name/.test(scanSession),
);

const scanScreen = read('src/screens/ScanScreen.tsx');
check(
  'ScanScreen: last-scanned toast price wrapped in {FEATURES.sellPrice && ...} (DIC-1319)',
  /\{FEATURES\.sellPrice\s*&&\s*\(\s*<Text style=\{resultStyles\.toastPrice\}/s.test(scanScreen),
);
check(
  'ScanScreen: search-suggestion price wrapped in {FEATURES.sellPrice && ...} (DIC-1319)',
  /\{FEATURES\.sellPrice\s*&&\s*\(\s*<Text style=\{resultStyles\.listItemPrice\}/s.test(scanScreen),
);

// ── 3c. SearchResults + DeckEditor (DIC-1262 CR → DIC-1256 remediation) ──
// Both are retained routes; only their price / market / watchlist surfaces
// are gated. Static-source pins live alongside the render probe below.
const searchResults = read('src/screens/SearchResultsScreen.tsx');
check(
  'SearchResultsScreen: card price/no-trade branch wrapped in {FEATURES.sellPrice && (...)} (DIC-1319)',
  /\{FEATURES\.sellPrice\s*&&\s*\(\s*card\.yuyuPrice/s.test(searchResults),
);
check(
  'SearchResultsScreen: imports FEATURES from releaseFlags',
  /from '\.\.\/config\/releaseFlags'/.test(searchResults)
    && /import\s*\{[^}]*FEATURES[^}]*\}\s*from\s*'\.\.\/config\/releaseFlags'/.test(searchResults),
);

const deckEditor = read('src/screens/DeckEditorScreen.tsx');
check(
  'DeckEditorScreen: imports FEATURES from releaseFlags',
  /import\s*\{\s*FEATURES\s*\}\s*from\s*'\.\.\/config\/releaseFlags'/.test(deckEditor),
);
check(
  'DeckEditorScreen: gap panel header title uses store variant under !FEATURES.marketData',
  /FEATURES\.marketData\s*\?\s*'deck_gap_title'\s*:\s*'deck_gap_title_store'/.test(deckEditor),
);
check(
  'DeckEditorScreen: per-row gap price wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<Text style=\{styles\.gapPrice\}/s.test(deckEditor),
);
check(
  'DeckEditorScreen: gap-totals card wrapped under FEATURES.marketData',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<Text style=\{styles\.gapPrice\}/s.test(deckEditor)
    && /FEATURES\.marketData\s*\?\s*\(\s*<View style=\{styles\.totalCard\}/s.test(deckEditor),
);
check(
  'DeckEditorScreen: price-alert row/editor gated by FEATURES.watchlist',
  /\{FEATURES\.watchlist\s*&&\s*r\.missing\s*>\s*0\s*&&\s*\(/.test(deckEditor),
);

// ── 4. Settings: price sources section only rendered under FEATURES.marketData;
//        link-hint and guest-sync copy have a store-only branch. ──
const settings = read('src/screens/SettingsScreen.tsx');
check(
  'SettingsScreen: 價格來源 section wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(/.test(settings)
    && /settings_price_sources/.test(settings),
);
check(
  'SettingsScreen: link hint has a store branch (settings_link_hint_store)',
  /settings_link_hint_store/.test(settings),
);
check(
  'SettingsScreen: guest sync hint has a store branch (settings_guest_sync_store)',
  /settings_guest_sync_store/.test(settings),
);

// ── 5. Login: description uses a store-only copy variant. ──
const login = read('src/screens/LoginScreen.tsx');
check(
  'LoginScreen: description picks login_description_store when STORE_MVP',
  /STORE_MVP\s*\?\s*'login_description_store'\s*:\s*'login_description'/.test(login)
    || /STORE_MVP\s*\?\s*"login_description_store"\s*:\s*"login_description"/.test(login),
);

// ── 6. i18n: the three new keys exist in both zh and ja, and their text
//        does NOT reintroduce the forbidden claims (收藏 / 提醒 / 趨勢 / 價格). ──
const zh = read('src/i18n/locales/zh.ts');
const ja = read('src/i18n/locales/ja.ts');
function extractStoreKey(src, key) {
  const re = new RegExp(`${key}:\\s*'([^']+)'`);
  const m = src.match(re);
  return m ? m[1] : null;
}
for (const key of [
  'login_description_store',
  'settings_link_hint_store',
  'settings_guest_sync_store',
  'scan_session_title_store',
  'scan_version_select_hint_store',
  'scan_version_pending_hint_store',
  'deck_gap_title_store',
]) {
  const zhText = extractStoreKey(zh, key);
  const jaText = extractStoreKey(ja, key);
  check(`zh locale defines ${key}`, !!zhText);
  check(`ja locale defines ${key}`, !!jaText);
  // Guard: store-variant copy must not claim favorites / alerts / price / trend.
  if (zhText) {
    check(
      `zh ${key} does not claim 收藏 / 提醒 / 趨勢 / 價格 (store build compliance)`,
      !/收藏|提醒|趨勢|價格/.test(zhText),
      `zh text = "${zhText}"`,
    );
  }
  if (jaText) {
    check(
      `ja ${key} does not claim お気に入り / アラート / 価格 / 推移 (store build compliance)`,
      !/お気に入り|アラート|価格|推移/.test(jaText),
      `ja text = "${jaText}"`,
    );
  }
}

// ── 7. eas.json: production / production-apk / preview all set STORE_MVP=1
//        so the review build resolves fail-closed. ──
const easRaw = JSON.parse(read('eas.json'));
check(
  'eas.json: preview.env.EXPO_PUBLIC_STORE_MVP === "1"',
  easRaw?.build?.preview?.env?.EXPO_PUBLIC_STORE_MVP === '1',
);
check(
  'eas.json: production.env.EXPO_PUBLIC_STORE_MVP === "1"',
  easRaw?.build?.production?.env?.EXPO_PUBLIC_STORE_MVP === '1',
);
check(
  'eas.json: production-apk extends production (inherits STORE_MVP=1)',
  easRaw?.build?.['production-apk']?.extends === 'production',
);

// ── 8. Mutation sensitivity: if we accidentally dropped a gate, the test
//        would fail. Prove that by testing an inverted expectation against
//        an in-memory mutated source snippet — the assertion must FAIL for the
//        mutated text and PASS for the real text. Prevents "the regex is so
//        loose the test can never fail" false confidence. ──
{
  const mutated = detail.replace(
    /\{FEATURES\.marketData\s*&&\s*<MarketDataPanel/,
    '<MarketDataPanel',
  );
  const mutationBroke = !/\{FEATURES\.marketData\s*&&\s*<MarketDataPanel/.test(mutated);
  check(
    'mutation: removing the MarketDataPanel gate in-memory would flip the assertion',
    mutationBroke,
  );
}
// DIC-1319 mutation: regressing the scan-result price gate back onto
// FEATURES.marketData is the exact edit that blanked v21's prices. Prove the
// assertion above actually catches it rather than matching either spelling.
{
  const regressed = scanResult.replace(
    /\{FEATURES\.sellPrice\s*&&\s*\(\s*<View style=\{styles\.pricesSection\}/,
    '{FEATURES.marketData && (\n          <View style={styles.pricesSection}',
  );
  check(
    'mutation: re-gating the scan-result price on FEATURES.marketData would flip the assertion',
    !/\{FEATURES\.sellPrice\s*&&\s*\(\s*<View style=\{styles\.pricesSection\}/s.test(regressed),
  );
}
// DIC-1319 mutation: making sellPrice STORE_MVP-derived is the other way to
// reintroduce the defect.
{
  const regressed = flags.replace(/sellPrice:\s*true\s*,/, 'sellPrice: !STORE_MVP,');
  check(
    'mutation: making FEATURES.sellPrice STORE_MVP-derived would flip both sellPrice assertions',
    !/sellPrice:\s*true\s*,/.test(regressed) && /sellPrice:\s*!?STORE_MVP/.test(regressed),
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Store MVP UI-gates regression: ${passed} checks passed`);
} else {
  console.error(`\n❌ Store MVP UI-gates regression failed`);
}
