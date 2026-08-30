// DIC-1256 render probe.
//
// Actually renders CardDetailScreen and LoginScreen through react-native-web
// under the current process env (EXPO_PUBLIC_STORE_MVP), and prints a JSON
// describing FEATURES + which gated surfaces landed in the DOM. The
// coordinator (test-store-mvp-behavior.mjs) invokes this probe once with
// EXPO_PUBLIC_STORE_MVP=1 and once with =0 to prove the same source file
// hides everything on the review build and leaves everything intact on
// staging/dev. This is the build-time-define proof the owner asked for.
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
// — pin them so the desktop/mobile layout branch is deterministic.
Object.defineProperty(dom.window, 'innerWidth', { value: 375, configurable: true });
Object.defineProperty(dom.window, 'innerHeight', { value: 812, configurable: true });

// A minimal ResizeObserver stub — react-native-web uses it for layout events.
class RO { observe() {} unobserve() {} disconnect() {} }
globalThis.ResizeObserver = RO;
dom.window.ResizeObserver = RO;

// Belt-and-suspenders: neutralise any accidental network fetch attempted by
// stores on import so a green run really proves the render, not a masked I/O
// failure.
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

let detailContainer, loginContainer;
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

const detailHtml = detailContainer.innerHTML;
const detailText = detailContainer.textContent;
const loginText = loginContainer.textContent;

const result = {
  features: FEATURES,
  storeMvpEnv: process.env.EXPO_PUBLIC_STORE_MVP ?? null,
  detail: {
    // Gated surfaces (must be absent when STORE_MVP=1, present when =0)
    hasCollectionCard: detailHtml.includes('card-detail-collection'),                    // FEATURES.favorites
    hasPriceSection: detailHtml.includes('card-detail-price-section'),                   // FEATURES.marketData
    hasMarketDataTitle: detailText.includes(zh.card_detail_market_data),                 // FEATURES.marketData
    hasYuyuLink: detailText.includes(zh.card_detail_yuyu_link),                          // FEATURES.externalPriceLinks
    hasCarousellLink: detailText.includes(zh.card_detail_carousell_link),                // FEATURES.externalPriceLinks
    hasWatchlistChip: detailHtml.includes('card-price-alert-chip'),                      // FEATURES.watchlist
    hasWatchlistBtn: detailHtml.includes('card-price-alert-button'),                     // FEATURES.watchlist
    // Retained surfaces (must be present in BOTH modes — regression guard)
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
};

process.stdout.write(JSON.stringify(result));
