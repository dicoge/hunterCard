import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createDrawerNavigator, DrawerContentScrollView, DrawerItemList, DrawerContentComponentProps } from '@react-navigation/drawer';
import { Text, View, StyleSheet, ActivityIndicator } from 'react-native';
import { COLORS } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';

// Screens
import HomeScreen from '../screens/HomeScreen';
import SearchScreen from '../screens/SearchScreen';
import ScanScreen from '../screens/ScanScreen';
import ScanScreenErrorBoundary from '../components/ScanScreenErrorBoundary';
import CollectionScreen from '../screens/CollectionScreen';
import FavoritesScreen from '../screens/FavoritesScreen';
import DeckEditorScreen from '../screens/DeckEditorScreen';
import TournamentReportScreen from '../screens/TournamentReportScreen';
import WatchlistScreen from '../screens/WatchlistScreen';
import SettingsScreen from '../screens/SettingsScreen';
import CardDetailScreen from '../screens/CardDetailScreen';
import SearchResultsScreen from '../screens/SearchResultsScreen';
import LoginScreen from '../screens/LoginScreen';
import LandingScreen from '../screens/LandingScreen';

import TutorialScreen from '../screens/TutorialScreen';
import TutorialDetailScreen from '../screens/TutorialDetailScreen';
import TutorialSimulationScreen from '../screens/TutorialSimulationScreen';

// Types
import { RootStackParamList, MainDrawerParamList, AuthStackParamList } from '../types';

// Auth
import { useAuthStore } from '../store/authStore';

const Stack = createNativeStackNavigator<RootStackParamList>();
const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const Drawer = createDrawerNavigator<MainDrawerParamList>();

// Custom Drawer Content
function CustomDrawerContent(props: DrawerContentComponentProps) {
  const { t } = useTranslation();
  return (
    <DrawerContentScrollView {...props} contentContainerStyle={styles.drawerContent}>
      <View style={styles.drawerHeader}>
        <Text style={styles.appTitle}>HoloHunter</Text>
        <Text style={styles.appSubtitle}>{t('nav_app_subtitle')}</Text>
      </View>
      <DrawerItemList {...props} />
    </DrawerContentScrollView>
  );
}

// DIC-1286: the shipped Android APK hard-crashes when opening the Scan screen.
// Wrap ScanScreen in a class ErrorBoundary so any synchronous render/mount
// error in the camera subtree renders a recoverable fallback UI instead of
// taking down the entire app. Keeping the wrapper module-scoped preserves
// react-navigation's `component={...}` identity so the Drawer route does not
// re-mount on every drawer render (which would reset the boundary).
function ScanScreenSafe(props: any) {
  return (
    <ScanScreenErrorBoundary
      onGoHome={() => props?.navigation?.navigate?.('Home')}
    >
      <ScanScreen {...props} />
    </ScanScreenErrorBoundary>
  );
}

// Main Drawer Navigator
function MainDrawer() {
  const { isDesktop } = useBreakpoint();
  const { t } = useTranslation();

  return (
    <Drawer.Navigator
      drawerContent={(props) => <CustomDrawerContent {...props} />}
      screenOptions={{
        drawerType: isDesktop ? 'permanent' : 'front',
        drawerActiveTintColor: COLORS.primary,
        drawerInactiveTintColor: COLORS.textSecondary,
        drawerStyle: {
          backgroundColor: COLORS.surface,
          width: isDesktop ? 260 : 280,
          borderRightWidth: isDesktop ? 1 : 0,
          borderRightColor: COLORS.border,
        },
        drawerLabelStyle: {
          marginLeft: 15,
          fontSize: 16,
        },
        headerStyle: {
          backgroundColor: COLORS.surface,
        },
        headerTintColor: COLORS.text,
        headerTitleStyle: {
          fontWeight: 'bold',
        },
      }}
    >
      <Drawer.Screen
        name="Home"
        component={HomeScreen}
        options={{
          title: t('nav_home'),
          // DIC-1409 Phase 3: Home renders the shared Pen v2 AppShell
          // (status bar + app bar + bottom tab bar), so the drawer header is
          // redundant chrome. The drawer itself stays reachable through the
          // shell's brand mark (`onLeadingPress` → openDrawer).
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🏠</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="Scan"
        component={ScanScreenSafe}
        options={{
          title: t('nav_scan'),
          // DIC-1409 CR fix: the scan flow carries the Pen App/04 top
          // action row (close / quota / flash) itself — the legacy drawer
          // header was double chrome over a full-bleed camera surface.
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>📷</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="Search"
        component={SearchScreen}
        options={{
          title: t('nav_search'),
          // DIC-1409 CR fix: Search renders the shared Pen v2 RouteShell.
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🔍</Text>
          ),
        }}
      />
      {/* 收藏 (bookmarks — the independent useFavoritesStore).
          DIC-1380 W7 CR fix: `nav_favorites` now actually routes to
          FavoritesScreen, which reads the store, lists bookmarks, and
          calls removeFavorite (stamping the sync tombstone). Previously
          the label 我的收藏 opened CollectionScreen — an unrelated
          ownership browser. Hidden in Store MVP by the same
          FEATURES.favorites gate. */}
      {FEATURES.favorites && (
        <Drawer.Screen
          name="Favorites"
          component={FavoritesScreen}
          options={{
            title: t('nav_favorites'),
            // DIC-1409 Phase 5: route renders the shared Pen v2 shell.
            headerShown: false,
            drawerIcon: ({ focused }) => (
              <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>❤️</Text>
            ),
          }}
        />
      )}
      {/* Card Collection ownership browser (browse-by-owned) — hidden in
          Store MVP (DIC-1256). Kept as its own drawer entry so it can be
          exposed independently of the bookmarks screen above. */}
      {FEATURES.favorites && (
        <Drawer.Screen
          name="Collection"
          component={CollectionScreen}
          options={{
            title: t('nav_collection'),
            // DIC-1409 Phase 5: route renders the shared Pen v2 shell.
            headerShown: false,
            drawerIcon: ({ focused }) => (
              <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>📚</Text>
            ),
          }}
        />
      )}
      <Drawer.Screen
        name="DeckEditor"
        component={DeckEditorScreen}
        options={{
          title: t('nav_deck_editor'),
          // DIC-1409 Phase 4: DeckEditor renders the shared Pen v2 shell
          // (status bar + its own Pen app bar + bottom tab bar).
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🃏</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="TournamentReport"
        component={TournamentReportScreen}
        options={{
          title: t('nav_tournament_report'),
          // DIC-1409 Phase 5: route renders the shared Pen v2 shell.
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🏆</Text>
          ),
        }}
      />
      {/* 到價提醒 — hidden in Store MVP (DIC-908). Removing the Drawer.Screen
          unregisters the route so nav + deep link are both blocked, not just
          visually hidden. */}
      {FEATURES.watchlist && (
        <Drawer.Screen
          name="Watchlist"
          component={WatchlistScreen}
          options={{
            title: t('nav_watchlist'),
            // DIC-1409 Phase 5: route renders the shared Pen v2 shell.
            headerShown: false,
            drawerIcon: ({ focused }) => (
              <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🔔</Text>
            ),
          }}
        />
      )}
      <Drawer.Screen
        name="Tutorial"
        component={TutorialScreen}
        options={{ 
          title: t('nav_tutorial'),
          // DIC-1409 Phase 5: route renders the shared Pen v2 shell.
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>📚</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Settings" 
        component={SettingsScreen}
        options={{ 
          title: t('nav_settings'),
          // DIC-1409 Phase 4: 我的 renders the shared Pen v2 shell.
          headerShown: false,
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>⚙️</Text>
          ),
        }}
      />
    </Drawer.Navigator>
  );
}

// Stack Navigator for screens that need navigation (CardDetail, SearchResults)
// Exported for the DIC-1409 shell-tab navigation regression, which mounts
// the REAL nested stack+drawer tree (not a stub) to prove bottom-tab
// presses resolve from both drawer children and root-stack screens.
export function StackNavigator() {
  const { t } = useTranslation();

  return (
    <Stack.Navigator
      screenOptions={{
        headerStyle: {
          backgroundColor: COLORS.surface,
        },
        headerTintColor: COLORS.text,
        headerTitleStyle: {
          fontWeight: 'bold',
        },
        contentStyle: {
          backgroundColor: COLORS.background,
        },
      }}
    >
      <Stack.Screen
        name="MainDrawer"
        component={MainDrawer}
        options={{ headerShown: false }}
      />
      <Stack.Screen
        name="CardDetail"
        component={CardDetailScreen}
        // DIC-1409 Phase 3: these two routes render the shared Pen v2 shell
        // with their own back-arrow app bar, so the stack header is hidden.
        options={{ title: t('nav_card_detail'), headerShown: false }}
      />
      <Stack.Screen
        name="SearchResults"
        component={SearchResultsScreen}
        options={{ title: t('nav_search_results'), headerShown: false }}
      />
      <Stack.Screen
        name="TutorialDetail"
        component={TutorialDetailScreen}
        // DIC-1409 Phase 6: route renders the shared Pen v2 shell.
        options={{ title: t('nav_tutorial_detail'), headerShown: false }}
      />
      <Stack.Screen
        name="TutorialSimulation"
        component={TutorialSimulationScreen}
        // DIC-1409 Phase 6: route renders the shared Pen v2 shell.
        options={{ title: t('nav_tutorial_simulation'), headerShown: false }}
      />
    </Stack.Navigator>
  );
}

export default function AppNavigator() {
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);
  const isGuest = useAuthStore((s) => s.isGuest);
  const hasHydrated = useAuthStore((s) => s.hasHydrated);

  if (!hasHydrated) {
    return (
      <View style={styles.loading}>
        <ActivityIndicator color={COLORS.primary} size="large" />
      </View>
    );
  }

  // DIC-1380 W5b: unauthenticated visitors now land on the Pen artifact's
  // accepted marketing Landing (LandingScreen) at `/`, not on the bare
  // LoginScreen auth card that shipped before. LoginScreen is retained as
  // an internal seam kept out of the visible surface (kept referenced so
  // the bundler and the future settings-linked login flow keep it live).
  const LoginScreenRef = LoginScreen;
  void LoginScreenRef;

  return (
    <NavigationContainer>
      <AuthStack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated || isGuest ? (
          <AuthStack.Screen name="Main" component={StackNavigator} />
        ) : (
          <AuthStack.Screen name="Login" component={LandingScreen} />
        )}
      </AuthStack.Navigator>
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loading: {
    flex: 1,
    backgroundColor: COLORS.background,
    alignItems: 'center',
    justifyContent: 'center',
  },
  drawerContent: {
    flex: 1,
  },
  drawerHeader: {
    padding: 20,
    marginBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  appTitle: {
    fontSize: 24,
    fontWeight: 'bold',
    color: COLORS.primary,
  },
  appSubtitle: {
    fontSize: 14,
    color: COLORS.textSecondary,
    marginTop: 4,
  },
  drawerIcon: {
    fontSize: 20,
    marginRight: 15,
    opacity: 0.6,
  },
  drawerIconFocused: {
    opacity: 1,
  },
  iconContainer: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  icon: {
    fontSize: 20,
    opacity: 0.6,
  },
  iconFocused: {
    opacity: 1,
  },
});
