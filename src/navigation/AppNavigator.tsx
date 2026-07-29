import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { createDrawerNavigator, DrawerContentScrollView, DrawerItemList, DrawerContentComponentProps } from '@react-navigation/drawer';
import { Text, View, StyleSheet, Image, Platform, ActivityIndicator } from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import AuthScreen from '../screens/AuthScreen';

// Screens
import HomeScreen from '../screens/HomeScreen';
import SearchScreen from '../screens/SearchScreen';
import ScanScreen from '../screens/ScanScreen';
import FavoritesScreen from '../screens/FavoritesScreen';
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
  return (
    <DrawerContentScrollView {...props} contentContainerStyle={styles.drawerContent}>
      <View style={styles.drawerHeader}>
        <Text style={styles.appTitle}>HoloHunter</Text>
        <Text style={styles.appSubtitle}>卡牌獵人</Text>
      </View>
      <DrawerItemList {...props} />
    </DrawerContentScrollView>
  );
}

// Main Drawer Navigator
function MainDrawer() {
  const { isDesktop } = useBreakpoint();
  return (
    <Drawer.Navigator
      drawerContent={(props) => <CustomDrawerContent {...props} />}
      screenOptions={{
        // PC (>= 768px): permanent sidebar always visible. Mobile keeps the slide-out drawer.
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
          title: '首頁',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🏠</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Scan" 
        component={ScanScreen}
        options={{ 
          title: '掃描卡牌',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>📷</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Search" 
        component={SearchScreen}
        options={{ 
          title: '搜尋',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🔍</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Favorites" 
        component={FavoritesScreen}
        options={{ 
          title: '收藏',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>❤️</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="Watchlist"
        component={WatchlistScreen}
        options={{
          title: '入手提醒',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>🔔</Text>
          ),
        }}
      />
      <Drawer.Screen
        name="Tutorial"
        component={TutorialScreen}
        options={{ 
          title: '規則教學',
          drawerIcon: ({ focused }) => (
            <Text style={[styles.drawerIcon, focused && styles.drawerIconFocused]}>📚</Text>
          ),
        }}
      />
      <Drawer.Screen 
        name="Settings" 
        component={SettingsScreen}
        options={{ 
          title: '設定',
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
        options={{ title: '卡牌詳情' }}
      />
      <Stack.Screen
        name="SearchResults"
        component={SearchResultsScreen}
        options={{ title: '搜尋結果' }}
      />
      <Stack.Screen
        name="TutorialDetail"
        component={TutorialDetailScreen}
        options={{ title: '規則詳解' }}
      />
      <Stack.Screen
        name="TutorialSimulation"
        component={TutorialSimulationScreen}
        options={{ title: '模擬實戰' }}
      />
    </Stack.Navigator>
  );
}

// iOS 上架若提供社群登入，必須提供 Sign in with Apple，因此 iOS 強制登入。
// Web / Android 的 Google 登入尚未接線，暫時以訪客模式進入（見 docs/AUTH_SETUP.md）。
const REQUIRE_AUTH = Platform.OS === 'ios';

// Root Navigator
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