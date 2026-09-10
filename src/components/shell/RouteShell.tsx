import React, { useMemo } from 'react';
import { Text, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { AppShell } from './AppShell';
import { buildShellTabs, activeTabForRoute } from './tabRegistry';
import { SEMANTIC, FONTS } from '../../theme/tokensV2';
import { useTranslation } from '../../i18n';

export interface RouteShellNavigation {
  navigate?: (route: string, params?: object) => void;
  goBack?: () => void;
  openDrawer?: () => void;
}

export interface RouteShellProps {
  navigation?: RouteShellNavigation | null;
  /** Route name as registered in AppNavigator — resolves the active tab. */
  routeName: string;
  title: string;
  children?: React.ReactNode;
  testID?: string;
}

/**
 * DIC-1409 Phase 5 — the shared chrome every Pen App/08–16 frame uses: back
 * arrow + centered-weight title in the app bar (Pen nodes `kINuV`/`E0HjM5`/
 * `gGf2d`/`WLytG`/`tTuQW`), status bar, bottom tab bar with the tab that
 * `activeTabForRoute` folds the route onto. Screens keep their own content
 * containers; RouteShell only provides the shell.
 */
export function RouteShell({
  navigation,
  routeName,
  title,
  children,
  testID = 'route-shell',
}: RouteShellProps) {
  const { t } = useTranslation();
  const tabs = useMemo(
    () => buildShellTabs({ navigation: navigation?.navigate ? (navigation as any) : { navigate: () => {} } }),
    [navigation],
  );
  return (
    <AppShell
      appBar={{
        showBrand: false,
        title,
        leading: (
          <TouchableOpacity
            onPress={() => (navigation?.goBack ? navigation.goBack() : navigation?.navigate?.('Home'))}
            accessibilityRole="button"
            accessibilityLabel={t('common_back')}
            style={styles.backButton}
            testID={`${testID}-back`}
          >
            <Text style={styles.backGlyph}>‹</Text>
          </TouchableOpacity>
        ),
      }}
      bottomTabBar={{ items: tabs, activeKey: activeTabForRoute(routeName) }}
      scrollable={false}
      contentPadding={false}
      testID={testID}
    >
      {children}
    </AppShell>
  );
}

const styles = StyleSheet.create({
  backButton: {
    width: 32,
    height: 32,
    alignItems: 'center',
    justifyContent: 'center',
    marginLeft: -6,
  },
  backGlyph: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: 26,
    lineHeight: 28,
    color: SEMANTIC.onBgMuted,
  },
});

export default RouteShell;
