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
import CollectionScreen from '../screens/CollectionScreen';
import DeckEditorScreen from '../screens/DeckEditorScreen';
import TournamentReportScreen from '../screens/TournamentReportScreen';
import WatchlistScreen from '../screens/WatchlistScreen';
import SettingsScreen from '../screens/SettingsScreen';
import CardDetailScreen from '../screens/CardDetailScreen';
import SearchResultsScreen from '../screens/SearchResultsScreen';
import LoginScreen from '../screens/LoginScreen';

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
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🏠</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Scan" 
        component={ScanScreen}
        options={{ 
          title: t('nav_scan'),
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
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🔍</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Collection"
        component={CollectionScreen}
        options={{ 
          title: t('nav_favorites'),
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>❤️</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="DeckEditor"
        component={DeckEditorScreen}
        options={{
          title: t('nav_deck_editor'),
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
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>⚙️</Text>
          ),
        }}
      />
    </Drawer.Navigator>
  );
}

// Stack Navigator for screens that need navigation (CardDetail, SearchResults)
function StackNavigator() {
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
        options={{ title: t('nav_card_detail') }}
      />
      <Stack.Screen
        name="SearchResults"
        component={SearchResultsScreen}
        options={{ title: t('nav_search_results') }}
      />
      <Stack.Screen
        name="TutorialDetail"
        component={TutorialDetailScreen}
        options={{ title: t('nav_tutorial_detail') }}
      />
      <Stack.Screen
        name="TutorialSimulation"
        component={TutorialSimulationScreen}
        options={{ title: t('nav_tutorial_simulation') }}
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

  return (
    <NavigationContainer>
      <AuthStack.Navigator screenOptions={{ headerShown: false }}>
        {isAuthenticated || isGuest ? (
          <AuthStack.Screen name="Main" component={StackNavigator} />
        ) : (
          <AuthStack.Screen name="Login" component={LoginScreen} />
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
