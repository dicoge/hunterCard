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
import { existsSync } from 'node:fs';
import path from 'node:path';
import * as pathMod from 'node:path';
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
  'CardDetailScreen: top price section wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<View[^>]*styles\.priceSection/s.test(detail),
);
check(
  'CardDetailScreen: MarketDataPanel invocation wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*<MarketDataPanel/.test(detail),
);
check(
  'CardDetailScreen: yuyu-tei and Carousell external links wrapped in {FEATURES.externalPriceLinks && ...}',
  /\{FEATURES\.externalPriceLinks\s*&&[\s\S]*?card_detail_yuyu_link[\s\S]*?card_detail_carousell_link/.test(detail),
);
check(
  'CardDetailScreen: 官方卡表 external link is NOT gated (must retain)',
  /<LinkButton[^/]*text=\{t\('card_detail_official_list'\)\}[^/]*\/>/.test(detail)
    // and the official-list line should NOT be inside the FEATURES.externalPriceLinks branch:
    && !/\{FEATURES\.externalPriceLinks\s*&&[\s\S]*?card_detail_official_list[\s\S]*?card_detail_yuyu_link/.test(detail),
);
check(
  'CardDetailScreen: 到價提醒 top chip still wrapped in {FEATURES.watchlist && ...} (regression)',
  /\{FEATURES\.watchlist\s*&&\s*\(\s*<View style=\{styles\.topActionRow\}/s.test(detail),
);
check(
  'CardDetailScreen: 到價提醒 bottom button still wrapped in {FEATURES.watchlist && ...} (regression)',
  /\{FEATURES\.watchlist\s*&&\s*\(\s*<View style=\{styles\.section\}>[\s\S]*?watchlistBtn/s.test(detail),
);

// ── 3b. Scan surfaces (DIC-1258 CR → DIC-1256): Store MVP data intentionally
//        retains sellPrice (retail reference); the Scan journey UI must fail
//        closed on every surface that would otherwise render a price. ──
const scanResult = read('src/components/ScanResultCard.tsx');
check(
  'ScanResultCard: prices section wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<View style=\{styles\.pricesSection\}/s.test(scanResult),
);
check(
  'ScanResultCard: variants section wrapped in {FEATURES.marketData && variants && ...}',
  /\{FEATURES\.marketData\s*&&\s*variants\s*&&\s*\(\s*<View style=\{styles\.variantsSection\}/s.test(scanResult),
);

const scanCandidate = read('src/components/ScanCandidateSelector.tsx');
check(
  'ScanCandidateSelector: meta price segment gated on FEATURES.marketData',
  /FEATURES\.marketData\s*\?\s*`\s+\$\{formatPrice\(card\.sellPrice\)\}`\s*:\s*''/.test(scanCandidate),
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
  'ScanScreen: last-scanned toast price wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<Text style=\{resultStyles\.toastPrice\}/s.test(scanScreen),
);
check(
  'ScanScreen: search-suggestion price wrapped in {FEATURES.marketData && ...}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*<Text style=\{resultStyles\.listItemPrice\}/s.test(scanScreen),
);

// ── 3c. SearchResults + DeckEditor (DIC-1262 CR → DIC-1256 remediation) ──
// Both are retained routes; only their price / market / watchlist surfaces
// are gated. Static-source pins live alongside the render probe below.
const searchResults = read('src/screens/SearchResultsScreen.tsx');
check(
  'SearchResultsScreen: card price/no-trade branch wrapped in {FEATURES.marketData && (...)}',
  /\{FEATURES\.marketData\s*&&\s*\(\s*card\.yuyuPrice/s.test(searchResults),
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

// ── DIC-1381 W10 / W11 CR — Store MVP user-facing copy MUST NOT
//    promise sync. App.tsx gates installAccountSyncBinding() on
//    FEATURES.favorites | .watchlist | .premium, all of which resolve
//    to !STORE_MVP, so no sync request is issued on the shipping
//    build. Any clause that promises cross-device sync / account-
//    binding of decks / settings / favorites / alerts on a `_store`
//    variant is a false claim.
//
//    Truth-source binding: fail closed if App.tsx or releaseFlags stop
//    agreeing with this assumption — the copy would need to change
//    too.
const appSrcForSync = read('App.tsx');
const flagsSrcForSync = read('src/config/releaseFlags.ts');
check(
  'code sanity: App.tsx gates installAccountSyncBinding on FEATURES.favorites | .watchlist | .premium',
  /installAccountSyncBinding\(\)/.test(appSrcForSync)
    && /FEATURES\.favorites\s*\|\|\s*FEATURES\.watchlist\s*\|\|\s*FEATURES\.premium/.test(appSrcForSync),
);
for (const flag of ['favorites', 'watchlist', 'premium']) {
  check(
    `code sanity: releaseFlags derives FEATURES.${flag} from !STORE_MVP (Store MVP disables it)`,
    new RegExp(`${flag}:\\s*!STORE_MVP`).test(flagsSrcForSync),
  );
}

// DIC-1381 W11 CR — MUTATION SENSITIVE: reject any additional binding
// call outside the FEATURES-gate. Counts every `installAccountSyncBinding(`
// invocation (excluding declaration/import lines) in App.tsx and asserts
// there is exactly one; then verifies THAT one line is inside a block
// that starts with the three-flag guard. An extra unconditional call
// added anywhere else in App.tsx fails this check even when the guarded
// call is left in place.
const bindingCallLines = appSrcForSync
  .split('\n')
  .map((line, idx) => ({ line, idx: idx + 1 }))
  .filter(({ line }) => /installAccountSyncBinding\s*\(/.test(line))
  .filter(({ line }) => !/^\s*(import|export)\s/.test(line))
  .filter(({ line }) => !/^\s*(\/\/|\*|\/\*)/.test(line));
check(
  'code sanity: App.tsx calls installAccountSyncBinding() exactly ONCE (no additional unguarded call)',
  bindingCallLines.length === 1,
  `got ${bindingCallLines.length} call sites: ${bindingCallLines.map(({ idx, line }) => `L${idx}: ${line.trim()}`).join(' | ')}`,
);
if (bindingCallLines.length === 1) {
  // Walk backwards from the call line to prove the enclosing `if` is
  // the three-flag guard. Reject a truthful-looking prefix like
  // `if (true) { installAccountSyncBinding(); }` or a plain
  // top-level call.
  const linesArr = appSrcForSync.split('\n');
  const callLineIdx = bindingCallLines[0].idx - 1;
  let guardLineIdx = -1;
  for (let i = callLineIdx - 1; i >= 0; i -= 1) {
    if (/^\s*if\s*\(/.test(linesArr[i])) { guardLineIdx = i; break; }
    if (/^\s*\}\s*$/.test(linesArr[i])) { break; } // walked out of a block first
  }
  check(
    'code sanity: the single installAccountSyncBinding() call sits inside an `if (FEATURES.favorites || FEATURES.watchlist || FEATURES.premium)` guard',
    guardLineIdx >= 0 && /FEATURES\.favorites\s*\|\|\s*FEATURES\.watchlist\s*\|\|\s*FEATURES\.premium/.test(linesArr[guardLineIdx]),
    guardLineIdx >= 0 ? `enclosing if at L${guardLineIdx + 1}: ${linesArr[guardLineIdx].trim()}` : 'no enclosing if(...) found',
  );
}

// DIC-1381 W11 CR — MUTATION SENSITIVE sync-copy predicate.
// Splits each _store locale variant into clause-sized spans (Chinese
// and Japanese sentence terminators + semicolons + full-width
// counterparts). Each clause is evaluated independently: a clause that
// carries a sync verb MUST also carry an on-device qualifier IN THE
// SAME CLAUSE — a qualifier elsewhere in the string does not rescue
// it. Catches both mutants Mac-Codex named:
//   zh mutant: 此版本的牌組可跨裝置同步；設定為裝置本機儲存。
//   ja mutant: このバージョンではデッキを端末間で同期できます。設定は端末内に保存されます。
const SYNC_VERB_ZH = /(同步|跨裝置|同一個帳號|帳號同步)/;
const SYNC_VERB_JA = /(同期|端末間|端末間で|同じアカウント|アカウント同期)/;
const ONDEVICE_QUALIFIER_ZH = /(本機儲存|裝置本機|裝置內|不會同步|不進行同步|裝置端|不會跨裝置|不同步|本機保存|裝置本地)/;
const ONDEVICE_QUALIFIER_JA = /(端末内|端末に保存|端末のみ|同期しません|同期されません|オフライン|ローカルに保存|端末に保存されます|同期しない)/;

function splitClausesZh(s) {
  return s.split(/[。！？；;.!?]|,\s|，/).map((c) => c.trim()).filter(Boolean);
}
function splitClausesJa(s) {
  return s.split(/[。！？；;.!?]|,\s|、/).map((c) => c.trim()).filter(Boolean);
}
function badSyncClauses(text, verbRe, qualifierRe, splitFn) {
  return splitFn(text).filter((c) => verbRe.test(c) && !qualifierRe.test(c));
}

const STORE_MVP_ONLY_KEYS = [
  'login_description_store',
  'settings_link_hint_store',
  'settings_guest_sync_store',
];
for (const key of STORE_MVP_ONLY_KEYS) {
  const zhText = extractStoreKey(zh, key) || '';
  const jaText = extractStoreKey(ja, key) || '';
  const zhBad = badSyncClauses(zhText, SYNC_VERB_ZH, ONDEVICE_QUALIFIER_ZH, splitClausesZh);
  const jaBad = badSyncClauses(jaText, SYNC_VERB_JA, ONDEVICE_QUALIFIER_JA, splitClausesJa);
  check(
    `zh ${key} has NO clause promising sync without an in-clause on-device qualifier (DIC-1381 W11 CR)`,
    zhBad.length === 0,
    zhBad.length ? `offending clauses: ${JSON.stringify(zhBad)} in "${zhText}"` : '',
  );
  check(
    `ja ${key} has NO clause promising sync without an in-clause on-device qualifier (DIC-1381 W11 CR)`,
    jaBad.length === 0,
    jaBad.length ? `offending clauses: ${JSON.stringify(jaBad)} in "${jaText}"` : '',
  );
}

// DIC-1381 W11 CR — mutation probes. Inject the exact mutants Mac-Codex
// demonstrated against the predicate and prove the predicate REJECTS
// them. If a future refactor of `badSyncClauses` accidentally weakens
// it back to "qualifier anywhere in the string", this probe fails.
{
  const zhMutant = '此版本的牌組可跨裝置同步；設定為裝置本機儲存。';
  const jaMutant = 'このバージョンではデッキを端末間で同期できます。設定は端末内に保存されます。';
  const zhBad = badSyncClauses(zhMutant, SYNC_VERB_ZH, ONDEVICE_QUALIFIER_ZH, splitClausesZh);
  const jaBad = badSyncClauses(jaMutant, SYNC_VERB_JA, ONDEVICE_QUALIFIER_JA, splitClausesJa);
  check(
    'mutation probe: zh sync-in-one-clause + qualifier-in-another mutant IS rejected by the predicate',
    zhBad.length > 0,
    `predicate must flag "${zhMutant}" but produced no offending clauses`,
  );
  check(
    'mutation probe: ja sync-in-one-clause + qualifier-in-another mutant IS rejected by the predicate',
    jaBad.length > 0,
    `predicate must flag "${jaMutant}" but produced no offending clauses`,
  );
}

// ── DIC-1381 W10 / W11 CR — settings_delete_note must NOT tell the
//    user that the deletion backend is still under construction / not
//    live.
//
//    Ground truth is the SHIPPING chain the SettingsScreen actually
//    uses (Mac-Codex W11 CR):
//      src/screens/SettingsScreen.tsx
//        └─ useAuthStore from `../store/authStore` (singular)
//           └─ src/store/authStore.ts.deleteUserAccount
//              └─ deleteAccount from `../services/authService`
//                 └─ src/services/authService.ts.deleteAccount
//                    └─ apiPost('/auth/delete-account', ...)
//                       └─ api/auth/delete-account.ts
//    A stale "尚未上線 / under construction / 準備中" note contradicts
//    this live chain and public/privacy.html §5 / §6 which agree.
const settingsScreenSrc = read('src/screens/SettingsScreen.tsx');
const shippingAuthStoreSrc = read('src/store/authStore.ts');
const shippingAuthServiceSrc = read('src/services/authService.ts');
const deleteEndpointFile = 'api/auth/delete-account.ts';

check(
  'shipping chain: SettingsScreen imports useAuthStore from ../store/authStore (the shipping store)',
  /import\s*\{[^}]*useAuthStore[^}]*\}\s*from\s*['"]\.\.\/store\/authStore['"]/.test(settingsScreenSrc),
);
check(
  'shipping chain: SettingsScreen invokes s.deleteUserAccount() (the store method)',
  /useAuthStore\(\(s\)\s*=>\s*s\.deleteUserAccount\)/.test(settingsScreenSrc),
);
check(
  'shipping chain: store/authStore imports deleteAccount from ../services/authService (not services/auth)',
  /import\s*\{[^}]*deleteAccount[^}]*\}\s*from\s*['"]\.\.\/services\/authService['"]/.test(shippingAuthStoreSrc),
);
check(
  'shipping chain: store/authStore.deleteUserAccount awaits deleteAccount(session) inside a try/catch that keeps the session on failure',
  /deleteUserAccount:[\s\S]*?await\s+deleteAccount\(session\)[\s\S]*?catch[\s\S]*?set\(\{[\s\S]*?isLoading:\s*false[\s\S]*?error:[\s\S]*?throw\s+err/.test(shippingAuthStoreSrc),
);
// Fail-closed: authService.deleteAccount must only resolve when the
// response is ok AND body.deleted === true; ANY other case throws.
// Mutation probe below verifies this predicate rejects a weakened
// (no-throw) mutant.
const svcDeleteMatch = shippingAuthServiceSrc.match(/export async function deleteAccount\(session:[^)]*\):\s*Promise<[^>]*>\s*\{([\s\S]*?)\n\}/);
check(
  'shipping chain: authService.deleteAccount posts to /auth/delete-account',
  svcDeleteMatch && /apiPost\(\s*['"]\/auth\/delete-account['"]/.test(svcDeleteMatch[1]),
);
check(
  'fail-closed: authService.deleteAccount throws unless res.ok AND data.deleted === true (DIC-1381 W11 CR)',
  svcDeleteMatch
    && /if\s*\(\s*!res\.ok\s*\|\|\s*data\??\.deleted\s*!==\s*true\s*\)\s*\{\s*throw\s+/.test(svcDeleteMatch[1]),
  svcDeleteMatch ? `deleteAccount body: ${svcDeleteMatch[1].trim().slice(0, 200)}` : 'no deleteAccount definition matched',
);
check(
  `code sanity: ${deleteEndpointFile} exists on disk (deletion backend implemented)`,
  existsSync(path.join(repoRoot, deleteEndpointFile)),
);

// DIC-1381 W11 CR — mutation probe: the exact predicate must reject a
// weakened `deleteAccount` that resolves normally regardless of status.
{
  const weakened = `export async function deleteAccount(session: string): Promise<void> {\n  const res = await apiPost('/auth/delete-account', {}, session);\n  const data = await readJson(res);\n  return;\n}`;
  const m = weakened.match(/export async function deleteAccount\(session:[^)]*\):\s*Promise<[^>]*>\s*\{([\s\S]*?)\n\}/);
  const rejectsWeakened = !(
    m && /if\s*\(\s*!res\.ok\s*\|\|\s*data\??\.deleted\s*!==\s*true\s*\)\s*\{\s*throw\s+/.test(m[1])
  );
  check(
    'mutation probe: a weakened deleteAccount that never throws IS rejected by the fail-closed predicate',
    rejectsWeakened,
  );
}

// DIC-1381 W11 CR — mutation probe: renaming the shipping route away
// from `/auth/delete-account` fails the shipping-chain predicate. The
// weakened source uses `/auth/wipe-account` instead.
{
  const renamed = `export async function deleteAccount(session: string): Promise<void> {\n  const res = await apiPost('/auth/wipe-account', {}, session);\n  const data = await readJson(res);\n  if (!res.ok || data?.deleted !== true) {\n    throw toAuthError(data, res.status);\n  }\n}`;
  const m = renamed.match(/export async function deleteAccount\(session:[^)]*\):\s*Promise<[^>]*>\s*\{([\s\S]*?)\n\}/);
  const routePasses = m && /apiPost\(\s*['"]\/auth\/delete-account['"]/.test(m[1]);
  check(
    'mutation probe: renaming the delete route away from /auth/delete-account IS rejected by the route predicate',
    !routePasses,
  );
}

const zhDeleteNote = extractStoreKey(zh, 'settings_delete_note') || '';
const jaDeleteNote = extractStoreKey(ja, 'settings_delete_note') || '';
check(
  'zh settings_delete_note does not claim deletion backend is unbuilt / offline (DIC-1381 W10 CR)',
  !/(仍在建置|建置中|尚未上線|尚未實作|尚未就緒|尚未建置)/.test(zhDeleteNote),
  `zh text = "${zhDeleteNote}"`,
);
check(
  'ja settings_delete_note does not claim deletion backend is unbuilt / offline (DIC-1381 W10 CR)',
  !/(準備中|未実装|未対応|未リリース|建設中|開発中)/.test(jaDeleteNote),
  `ja text = "${jaDeleteNote}"`,
);
// Positive: the note should still describe the fail-closed behavior
// when a specific attempt fails — that is legitimate and matches the
// settings_delete_pending / _pending_body strings and the runtime.
check(
  'zh settings_delete_note describes the fail-closed "未完成 / 尚未完成" behavior (fail-closed intact)',
  /(未完成|尚未完成|不會誤示|維持登入狀態)/.test(zhDeleteNote),
);
check(
  'ja settings_delete_note describes the fail-closed "未完了" behavior (fail-closed intact)',
  /(未完了|ログイン状態を維持|誤って削除済みと表示することはありません)/.test(jaDeleteNote),
);

// Cross-page parity: privacy.html says deletion is live; the App-side
// note must not contradict that or a user reading both surfaces sees
// two different truths.
const privacyRaw = read('public/privacy.html');
check(
  'privacy.html states the deletion backend is implemented and live',
  /(帳號刪除的[^<]*已實作|已實作並上線|deletion backend[\s\S]*?(is implemented|is live)|Account deletion[\s\S]*?(is implemented|is live)|deletion endpoint[\s\S]*?is deployed)/i.test(privacyRaw),
  'privacy.html must state deletion is live (matches src/services/authService.ts.deleteAccount)',
);

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

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Store MVP UI-gates regression: ${passed} checks passed`);
} else {
  console.error(`\n❌ Store MVP UI-gates regression failed`);
}
