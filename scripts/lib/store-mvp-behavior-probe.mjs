// DIC-1256 render probe.
//
// Actually renders CardDetailScreen, LoginScreen, ScanResultCard,
// ScanCandidateSelector and ScanSessionPanel through react-native-web under
// the current process env (EXPO_PUBLIC_STORE_MVP), and prints a JSON
// describing FEATURES + which gated surfaces landed in the DOM. The
// coordinator (test-store-mvp-behavior.mjs) invokes this probe once with
// EXPO_PUBLIC_STORE_MVP=1 and once with =0 to prove the same source file
// hides everything on the review build and leaves everything intact on
// staging/dev. This is the build-time-define proof the owner asked for.
//
// The Scan surfaces are here because Store MVP data intentionally retains
// `sellPrice` (retail reference). DIC-1256/DIC-1258 hid every price-shaped
// pixel behind FEATURES.marketData; DIC-1319 reversed that for the ONE price
// the product exists to show — the scanned printing's own sale price — so the
// probe now reports those markers as retained-in-both-modes while keeping the
// cross-printing, spread, valuation-total and external-link markers gated.
import { JSDOM } from 'jsdom';

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

// react-native-web's Dimensions.get('window') reads window.innerWidth / Height
// — pin them so the desktop/mobile layout branch is deterministic. Desktop
// width is required so DeckEditor renders its shortage panel alongside the
// picker (mobile hides it behind the five-way panel switch).
Object.defineProperty(dom.window, 'innerWidth', { value: 1280, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 900, configurable: true });
// react-native-web also reads clientWidth on documentElement for its
// Dimensions API; pin that too.
Object.defineProperty(dom.window.document.documentElement, 'clientWidth', { value: 1280, configurable: true });
Object.defineProperty(dom.window.document.documentElement, 'clientHeight', { value: 900, configurable: true });

// A minimal ResizeObserver stub — react-native-web uses it for layout events.
class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = RO;
dom.window.ResizeObserver = RO;

// Belt-and-suspenders: neutralise any accidental network fetch attempted by
// stores on import so a green run really proves the render, not a masked I/O
// failure. DeckEditor overrides this below to serve the real shipped database.
globalThis.fetch = async () => ({
  ok: false,
  status: 404,
  json: async () => ({}),
  text: async () => '',
});

const React = (await import('react')).default;
const { act } = await import('react');
const { createRoot } = await import('react-dom/client');

// releaseFlags is the module whose env-driven resolution we're proving.
const { FEATURES } = await import('../../src/config/releaseFlags.ts');

// The trend store's `fetchTrendForCard` runs inside a CardDetailScreen
// useEffect in non-MVP mode. Neutralise it so we don't dangle a rejected
// promise or hit an unmocked API on the STORE_MVP=0 probe run.
const trendMod = await import('../../src/store/trendStore.ts');
trendMod.useTrendStore.setState({
  getTrendForCard: () => null,
  fetchTrendForCard: async () => null,
});

const { default: CardDetailScreen } = await import('../../src/screens/CardDetailScreen.tsx');
const { default: LoginScreen } = await import('../../src/screens/LoginScreen.tsx');
const { default: ScanResultCard } = await import('../../src/components/ScanResultCard.tsx');
const { default: ScanCandidateSelector } = await import('../../src/components/ScanCandidateSelector.tsx');
const { default: ScanSessionPanel } = await import('../../src/components/ScanSessionPanel.tsx');
const { CardListItem } = await import('../../src/screens/SearchResultsScreen.tsx');
const scanSessionMod = await import('../../src/stores/scanSessionStore.ts');
const { zh } = await import('../../src/i18n/locales/zh.ts');

// Sample card with just enough shape for CardDetailScreen to render everything
// its gated surfaces normally show — sale price, printings, external link
// URLs, deck-collection ownership widget.
const sampleCard = {
  id: 'hBP04-005',
  cardNumber: 'hBP04-005',
  name: 'Test Card',
  nameZh: '測試卡樣本',
  type: 'Member',
  rarity: 'R',
  grade: '1st',
  yuyuPrice: 1200,
  yuyuPriceName: 'ノーマル',
  prices: [{ name: 'ノーマル', sellPrice: 1200, rarity: 'R' }],
  colors: ['red'],
  color: 'red',
  versions: ['_U.png'],
  seriesNames: ['Blue Journey'],
  tags: ['ホロメン'],
  searchKeywords: ['ホロメン', '測試卡', 'Test Card'],
  skillsJp: null,
  skillsZh: null,
  effects: [],
  series: 'hBP04',
  normalized: null,
  images: [],
};

const mockNavigation = { navigate: () => {}, goBack: () => {}, setOptions: () => {}, canGoBack: () => false };
const mockRoute = { params: { card: sampleCard } };

async function renderElement(element) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => { root.render(element); });
  // Flush any microtasks / effect ticks so the initial-render tree is stable.
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return container;
}

let detailContainer, loginContainer, scanResultContainer, scanCandidateContainer, scanSessionContainer;
try {
  detailContainer = await renderElement(
    React.createElement(CardDetailScreen, { route: mockRoute, navigation: mockNavigation }),
  );
} catch (err) {
  process.stderr.write(`CardDetailScreen render failed: ${err?.stack || err}\n`);
  process.exit(2);
}
try {
  loginContainer = await renderElement(React.createElement(LoginScreen));
} catch (err) {
  process.stderr.write(`LoginScreen render failed: ${err?.stack || err}\n`);
  process.exit(2);
}

// ── Scan surfaces ──
// A scan-result-shaped card (has prices + variants). The gated surfaces are
// the price rows, variant rows, and the meta price segment.
const scanCard = {
  id: 'hBP04-005',
  cardNumber: 'hBP04-005',
  name: 'Test Scan Card',
  nameZh: '掃描測試卡',
  type: 'Member',
  rarity: 'R',
  series: 'hBP04',
  sellPrice: 1200,
  yuyuName: 'Test Scan Card',
  color: 'red',
  imageUrl: '',
  prices: [
    { name: 'ノーマル', sellPrice: 1200, rarity: 'R' },
    { name: 'サイン', sellPrice: 5000, rarity: 'SR' },
  ],
  variants: [
    { series: 'hBP01', seriesName: '(hBP01)', sellPrice: 800, prices: [{ name: 'ノーマル', sellPrice: 800, rarity: 'R' }] },
  ],
};

try {
  scanResultContainer = await renderElement(
    React.createElement(ScanResultCard, {
      card: scanCard,
      visible: true,
      confidence: 0.9,
      onDismiss: () => {},
      preferredCurrency: 'JPY',
      preferredLanguage: 'zh',
    }),
  );
} catch (err) {
  process.stderr.write(`ScanResultCard render failed: ${err?.stack || err}\n`);
  process.exit(2);
}

try {
  scanCandidateContainer = await renderElement(
    React.createElement(ScanCandidateSelector, {
      visible: true,
      tier: 'mid',
      candidates: [{ card: scanCard, confidence: 0.62 }],
      onSelect: () => {},
      onRescan: () => {},
      onManualSearch: () => {},
      onDismiss: () => {},
      preferredCurrency: 'JPY',
      preferredLanguage: 'zh',
    }),
  );
} catch (err) {
  process.stderr.write(`ScanCandidateSelector render failed: ${err?.stack || err}\n`);
  process.exit(2);
}

// Pre-seed a session so the panel expands and renders totals + version chips.
const sessionCard = {
  ...scanCard,
  instanceId: 'seed-1',
  scannedAt: '2026-08-30T00:00:00Z',
  priceVersions: [
    { name: 'ノーマル', sellPrice: 1200 },
    { name: 'サイン', sellPrice: 5000 },
  ],
  selectedVersion: 0,
  versionConfident: true,
};
scanSessionMod.useScanSessionStore.setState({
  cards: [sessionCard],
  totalValue: 1200,
  cardCount: 1,
  isSessionActive: true,
  lastScanKey: null,
  lastScanAt: null,
});

try {
  scanSessionContainer = await renderElement(
    React.createElement(ScanSessionPanel, { preferredCurrency: 'JPY' }),
  );
  // Expand the panel by dispatching a click on the header — the panel exposes
  // the currency selector / version chips / footer only when expanded, which
  // is exactly what we need to inspect for gated surfaces. react-native-web
  // renders testID as data-testid on the Touchable pressable, so this is a
  // stable selector across profiles.
  const header = scanSessionContainer.querySelector('[data-testid="scan-session-header"]');
  if (!header) {
    process.stderr.write('scan-session-header not found — cannot expand panel\n');
    process.exit(2);
  }
  await act(async () => {
    header.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    header.dispatchEvent(new dom.window.MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    header.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }));
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
} catch (err) {
  process.stderr.write(`ScanSessionPanel render failed: ${err?.stack || err}\n`);
  process.exit(2);
}
// Snapshot the WITH-CARDS expanded state (currency row / footer / chips are here).
const scanSessionWithCardsHtml = scanSessionContainer.innerHTML;
const scanSessionWithCardsText = scanSessionContainer.textContent;

// Then clear the session while the panel is still expanded. The panel keeps
// its expanded local state and now renders its cardCount===0 branch, which is
// where the header title (`scan_session_title` vs `_store` variant) lives.
await act(async () => {
  scanSessionMod.useScanSessionStore.setState({
    cards: [], totalValue: 0, cardCount: 0,
    lastScanKey: null, lastScanAt: null, isSessionActive: false,
  });
});
await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const scanSessionEmptyText = scanSessionContainer.textContent;

// ── SearchResultsScreen — exported CardListItem renders per-card price badge ──
// A card fixture matching the CardResult shape SearchResults produces: crucially
// yuyuPrice is non-null (positive) so the price-badge branch fires under !MVP.
const searchResultCard = {
  id: 'hBP04-005',
  cardNumber: 'hBP04-005',
  name: 'Test Search Card',
  nameZh: '搜尋測試卡',
  type: 'Member',
  grade: '1st',
  normalized: null,
  rarity: 'R',
  sourceRarity: 'R',
  colors: ['red'],
  colorNames: ['紅'],
  series: ['hBP04'],
  seriesNames: ['Blue Journey'],
  imageUrl: '',
  yuyuPrice: 1200,
  sellPrice: 1200,
  buyPrice: null,
  ytStats: null,
  yuyuPriceName: 'ノーマル',
  prices: [
    { name: 'ノーマル', sellPrice: 1200, rarity: 'R' },
    { name: 'サイン', sellPrice: 5000, rarity: 'SR' },
  ],
  priceHistory: {},
  yuyuImage: '',
  officialImage: '',
  localImage: '',
  effects: [],
  hp: '',
  life: '',
  arts: '',
  skillsJp: null,
  skillsZh: null,
  searchKeywords: ['Test Search Card', '', ''],
  tags: [],
  yuyuUrl: '',
  carousellUrl: '',
  officialUrl: '',
};
// Render TWO CardListItem instances so both branches of the price-badge
// conditional are exercised under !STORE_MVP: the priced item renders the
// price badge row and the unpriced item renders the "no trade" badge. Under
// STORE_MVP, both must be absent.
const searchResultCardUnpriced = {
  ...searchResultCard,
  cardNumber: 'hBP04-006',
  nameZh: '搜尋測試卡（無交易）',
  yuyuPrice: null,
  sellPrice: null,
  prices: [],
};
let searchResultContainer;
try {
  searchResultContainer = await renderElement(
    React.createElement(
      React.Fragment,
      null,
      React.createElement(CardListItem, { card: searchResultCard, onPress: () => {} }),
      React.createElement(CardListItem, { card: searchResultCardUnpriced, onPress: () => {} }),
    ),
  );
} catch (err) {
  process.stderr.write(`SearchResults CardListItem render failed: ${err?.stack || err}\n`);
  process.exit(2);
}
const searchResultCardHtml = searchResultContainer.innerHTML;
const searchResultCardText = searchResultContainer.textContent;

// ── DeckEditorScreen — full-screen render with a seeded active deck ──
// Serves the shipped `public/data/database.json` via a stubbed fetch, exactly
// like scripts/test-deck-editor-copy.mjs. Then seeds useDeckStore with a small
// active deck whose main slot requires a real card the collection doesn't have,
// so `computeGap` produces a priced row + subtotal — the exact place where
// the gap price, price-alert CTA, and gap-subtotal all render together.
const fs = await import('node:fs');
const shippedDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf-8'));
const originalFetch = globalThis.fetch;
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  if (url === '/data/database.json') {
    return { ok: true, json: async () => shippedDb };
  }
  return originalFetch(input);
};

// The anchor card and printing come from test-deck-editor-copy — hBP07-006 BASE
// is the DIC-1060 canonical ordinary-default printing that always has a real
// yuyu-tei sellPrice in the shipped catalog, so `computeGap` produces a priced
// row and the alert row / gap-subtotal-JPY branch fires.
const DECK_ANCHOR_CARD_NUMBER = 'hBP07-006';
const DECK_ANCHOR_PRINTING = 'BASE';
const seededDeck = {
  id: 'store-mvp-probe-deck',
  name: 'Store MVP Probe Deck',
  oshi: [],
  main: [{
    qty: 1,
    card: {
      id: `${DECK_ANCHOR_CARD_NUMBER}#${DECK_ANCHOR_PRINTING}`,
      cardNumber: DECK_ANCHOR_CARD_NUMBER,
      name: 'Probe Anchor',
      printing: DECK_ANCHOR_PRINTING,
      printingLabel: 'ノーマル',
      series: 'hBP07',
      type: 'ホロメン',
    },
  }],
  yell: [],
  origin: null,
  updatedAt: '2026-08-31T00:00:00.000Z',
};
const deckStoreMod = await import('../../src/store/deckStore.ts');
const platformStorageMod = await import('../../src/stores/storage.ts');
try { platformStorageMod.default.removeItem('hunterCard-decks'); } catch {}
deckStoreMod.useDeckStore.setState({
  decks: [seededDeck],
  activeDeckId: seededDeck.id,
  collection: {},
});

const { default: DeckEditorScreen } = await import('../../src/screens/DeckEditorScreen.tsx');
let deckEditorContainer;
try {
  deckEditorContainer = await renderElement(React.createElement(DeckEditorScreen));
  // The database load is async — give it a couple of ticks so gap is computed.
  for (let i = 0; i < 5; i++) {
    await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  }
} catch (err) {
  process.stderr.write(`DeckEditorScreen render failed: ${err?.stack || err}\n`);
  process.exit(2);
}
const deckEditorHtml = deckEditorContainer.innerHTML;
const deckEditorText = deckEditorContainer.textContent;

const detailHtml = detailContainer.innerHTML;
const detailText = detailContainer.textContent;
const loginText = loginContainer.textContent;
const scanResultHtml = scanResultContainer.innerHTML;
const scanResultText = scanResultContainer.textContent;
const scanCandidateHtml = scanCandidateContainer.innerHTML;
const scanCandidateText = scanCandidateContainer.textContent;
const scanSessionHtml = scanSessionWithCardsHtml;
const scanSessionText = scanSessionWithCardsText;

// The three scan-price markers we care about live inside strings that would
// only ever land in the DOM when a price render fires. Match ¥ + digits or
// currency codes (NT$ / $) followed by digits — the retained card identity
// never emits those.
const priceLikeRe = /(¥|NT\$|\$)\s?\d/;
function containsPriceLike(text) { return priceLikeRe.test(text); }

const result = {
  features: FEATURES,
  storeMvpEnv: process.env.EXPO_PUBLIC_STORE_MVP ?? null,
  detail: {
    // Gated surfaces (must be absent when STORE_MVP=1, present when =0)
    hasCollectionCard: detailHtml.includes('card-detail-collection'),                    // FEATURES.favorites
    hasMarketDataTitle: detailText.includes(zh.card_detail_market_data),                 // FEATURES.marketData
    hasLivePriceCta: detailText.includes(zh.card_detail_live_price),                     // FEATURES.externalPriceLinks
    hasYuyuLink: detailText.includes(zh.card_detail_yuyu_link),                          // FEATURES.externalPriceLinks
    hasCarousellLink: detailText.includes(zh.card_detail_carousell_link),                // FEATURES.externalPriceLinks
    hasWatchlistChip: detailHtml.includes('card-price-alert-chip'),                      // FEATURES.watchlist
    hasWatchlistBtn: detailHtml.includes('card-price-alert-button'),                     // FEATURES.watchlist
    // Retained surfaces (must be present in BOTH modes — regression guard)
    hasPriceSection: detailHtml.includes('card-detail-price-section'),                   // FEATURES.sellPrice (DIC-1319)
    hasPriceLikeText: containsPriceLike(detailText),                                     // FEATURES.sellPrice (DIC-1319)
    hasOfficialLink: detailText.includes(zh.card_detail_official_list),
    hasCardName: detailText.includes(sampleCard.nameZh),
    hasCardNumber: detailText.includes(sampleCard.cardNumber),
    hasKeywordsSection: detailText.includes(zh.card_detail_keywords),
    hasExternalLinksHeader: detailText.includes(zh.card_detail_external_links),
  },
  login: {
    usesStoreDescription: loginText.includes(zh.login_description_store),
    usesFullDescription: loginText.includes(zh.login_description),
  },
  // Scan surfaces (DIC-1258 CR blocker → DIC-1256 → DIC-1319).
  scanResult: {
    // Gated (absent when STORE_MVP=1): cross-printing comparison only.
    hasVariantsSection: scanResultHtml.includes('scan-result-variants'),
    // Retained (present in BOTH modes). The scanned printing's own sale price
    // rides on FEATURES.sellPrice since DIC-1319 — a blank here is the v21
    // closed-test defect.
    hasPricesSection: scanResultHtml.includes('scan-result-prices'),
    hasPriceLikeText: containsPriceLike(scanResultText),
    hasCardName: scanResultText.includes(scanCard.nameZh),
    hasCardNumber: scanResultText.includes(scanCard.cardNumber),
    hasRarityBadge: scanResultText.includes(scanCard.rarity),
  },
  scanCandidate: {
    // Retained in BOTH modes since DIC-1319: the price is often what tells the
    // user which candidate is the printing in their hand.
    hasPriceLikeInMeta: containsPriceLike(scanCandidateText),
    hasCardNumber: scanCandidateText.includes(scanCard.cardNumber),
    hasCandidateTitle: scanCandidateText.includes(zh.scan_candidate_mid_title),
    hasRescanAction: scanCandidateText.includes(zh.scan_rescan),
  },
  searchResult: {
    // Retained in BOTH modes since DIC-1319 (per-card sale price / no-trade).
    hasPriceBadgeRow: searchResultCardHtml.includes('search-result-price-row'),
    hasNoTradeBadge: searchResultCardHtml.includes('search-result-no-trade'),
    hasPriceLikeText: containsPriceLike(searchResultCardText),
    hasCardName: searchResultCardText.includes(searchResultCard.nameZh),
    hasCardNumber: searchResultCardText.includes(searchResultCard.cardNumber),
  },
  deckEditor: {
    // Gated (absent when STORE_MVP=1). deck-gap-totals / gap-subtotal-JPY are
    // marketData-gated; price-alert-open-* is watchlist-gated.
    hasGapPrice: deckEditorHtml.includes(`gap-price-${DECK_ANCHOR_CARD_NUMBER}|${DECK_ANCHOR_PRINTING}`),
    hasGapTotals: deckEditorHtml.includes('deck-gap-totals'),
    hasGapSubtotalJPY: deckEditorHtml.includes('gap-subtotal-JPY'),
    hasAlertOpen: deckEditorHtml.includes(`price-alert-open-${DECK_ANCHOR_CARD_NUMBER}|${DECK_ANCHOR_PRINTING}`),
    hasGapSourceCopy: deckEditorText.includes('yuyu-tei.jp'),
    // The estimate title (`缺卡預估（參考售價）`) contains the store title
    // (`缺卡預估`) as a prefix, so guard against the substring collision by
    // requiring the exact estimate title for the estimate branch and the
    // store title WITHOUT the estimate distinguishing token for the store
    // branch.
    hasEstimateTitle: deckEditorText.includes(zh.deck_gap_title),
    hasStoreTitle: deckEditorText.includes(zh.deck_gap_title_store)
      && !deckEditorText.includes(zh.deck_gap_title),
    // Retained (present in BOTH modes): gap panel still shows the missing card
    // number so deck-editing help is preserved.
    hasCardNumber: deckEditorText.includes(DECK_ANCHOR_CARD_NUMBER),
  },
  scanSession: {
    // Header (WITH-CARDS state — shows session count and, under !STORE_MVP,
    // the running total price)
    hasHeaderTotalPrice: scanSessionHtml.includes('scan-session-total-price'),
    // The title text only surfaces in the cardCount===0 branch; snapshot AFTER
    // clearing the session while expanded is retained.
    hasStoreTitle: scanSessionEmptyText.includes(zh.scan_session_title_store),
    hasEstimateTitle: scanSessionEmptyText.includes(zh.scan_session_title),
    // Expanded body
    hasCurrencyRow: scanSessionHtml.includes('scan-session-currency-row'),
    hasTotalRow: scanSessionHtml.includes('scan-session-total-row'),
    hasCopyResultsBtn: scanSessionHtml.includes('scan-session-copy-results'),
    hasStoreVersionHint: scanSessionText.includes(zh.scan_version_select_hint_store),
    hasEstimateVersionHint: scanSessionText.includes(zh.scan_version_select_hint),
    hasPriceLikeText: containsPriceLike(scanSessionText),
    // Retained: session count, continue-scanning, clear.
    hasSessionCount: scanSessionText.includes('1'),
    hasClearAction: scanSessionText.includes(zh.scan_clear),
  },
};

process.stdout.write(JSON.stringify(result));
