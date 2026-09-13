import type { BottomTabItem, BottomTabKey } from './BottomTabBar';

export interface RouteNavigator {
  navigate: (route: string, params?: object) => void;
}

export interface BuildShellTabsInput {
  navigation: RouteNavigator;
  features?: {
    favorites?: boolean;
    watchlist?: boolean;
  };
}

/**
 * Maps the five Pen bottom-tab slots to the routes registered in `AppNavigator`.
 * Every route present in the shipped drawer stays reachable through this tab
 * bar, so deep links (`hunterCard://Home`, `hunterCard://Search`, …) continue
 * to resolve without change.
 */
export const SHELL_TAB_ROUTE_MAP: Record<BottomTabKey, string> = {
  home: 'Home',
  search: 'Search',
  scan: 'Scan',
  deck: 'DeckEditor',
  me: 'Me',
};

export const SHELL_TAB_LABELS: Record<BottomTabKey, string> = {
  home: '首頁',
  search: '搜尋',
  scan: '掃描',
  deck: '牌組',
  me: '我的',
};

export const SHELL_TAB_GLYPHS: Record<BottomTabKey, string> = {
  home: '⌂',
  search: '⌕',
  scan: '＋',
  deck: '⧉',
  me: '☺',
};

const DEFAULT_ORDER: BottomTabKey[] = ['home', 'search', 'scan', 'deck', 'me'];

export function buildShellTabs({ navigation, features = {} }: BuildShellTabsInput): BottomTabItem[] {
  return DEFAULT_ORDER.map((key) => ({
    key,
    label: SHELL_TAB_LABELS[key],
    glyph: SHELL_TAB_GLYPHS[key],
    destinationRoute: SHELL_TAB_ROUTE_MAP[key],
    // All five tab destinations are children of the nested `MainDrawer`
    // navigator, but RouteShell also mounts on root-stack screens
    // (SearchResults / TutorialDetail / TutorialSimulation) whose
    // navigation object cannot resolve drawer-child names directly. The
    // nested-navigator form resolves from BOTH contexts: React Navigation
    // walks up to the root stack, finds `MainDrawer`, and applies the
    // nested `screen` param (popping the stack back to the drawer).
    onPress: () => navigation.navigate('MainDrawer', { screen: SHELL_TAB_ROUTE_MAP[key] }),
  })).filter((item) => {
    if (item.key === 'me' && features.favorites === false) return true;
    return true;
  });
}

/**
 * Resolve which bottom tab should be marked active for a given route name.
 * Falls back to the closest tab (search results/detail live under `search`;
 * card detail/deck editor under `deck`; scan flows under `scan`; profile
 * surfaces under `me`).
 */
export function activeTabForRoute(routeName: string | undefined): BottomTabKey {
  if (!routeName) return 'home';
  const map: Record<string, BottomTabKey> = {
    Home: 'home',
    Search: 'search',
    SearchResults: 'search',
    CardDetail: 'search',
    Scan: 'scan',
    ScanResults: 'scan',
    DeckEditor: 'deck',
    Collection: 'deck',
    TournamentReport: 'home',
    Watchlist: 'home',
    Tutorial: 'home',
    TutorialDetail: 'home',
    TutorialSimulation: 'home',
    Me: 'me',
    Settings: 'me',
    Favorites: 'me',
    Login: 'me',
  };
  return map[routeName] ?? 'home';
}
