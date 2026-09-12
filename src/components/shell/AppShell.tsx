import React from 'react';
import { View, StyleSheet, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PALETTE, LAYOUT, SPACING } from '../../theme/tokensV2';
import { AppStatusBar, StatusBarProps } from './StatusBar';
import { AppBar, AppBarProps } from './AppBar';
import { BottomTabBar, BottomTabBarProps } from './BottomTabBar';

export interface AppShellProps {
  children?: React.ReactNode;
  appBar?: AppBarProps | false;
  statusBar?: StatusBarProps | false;
  bottomTabBar?: BottomTabBarProps | false;
  scrollable?: boolean;
  contentPadding?: boolean;
  testID?: string;
  contentTestID?: string;
}

/**
 * Cross-platform shell used by every top-level screen in Phase 2/3. Layers:
 *   • Status bar strip (Pen `C / Status Bar`, 390×54)
 *   • App bar (Pen `App Bar`, 390×56)
 *   • Scrollable content region
 *   • Bottom tab bar (Pen `C / Tab Bar`, 390×96 with scan FAB)
 *
 * Layout mirrors the Pen bounds exactly at 390 and stretches for wider
 * viewports without breaking the `content-desktop 1328` clamp.
 */
export function AppShell({
  children,
  appBar,
  statusBar,
  bottomTabBar,
  scrollable = true,
  contentPadding = true,
  testID = 'shell-root',
  contentTestID = 'shell-content',
}: AppShellProps) {
  const insets = useSafeAreaInsets();
  const topInset = Math.max(insets.top, Platform.OS === 'web' ? 0 : LAYOUT.safeMobile);
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'web' ? 0 : LAYOUT.safeMobile);

  const bar = statusBar === false ? null : <AppStatusBar {...(statusBar ?? {})} />;
  const top = appBar === false ? null : <AppBar {...(appBar ?? {})} />;
  const tabs = bottomTabBar === false || !bottomTabBar ? null : (
    <BottomTabBar {...bottomTabBar} />
  );

  const contentPaddingBottom = tabs ? LAYOUT.bottomTab.height + SPACING['3xl'] : SPACING['3xl'];
  const contentStyle = [
    styles.contentInner,
    contentPadding && { paddingHorizontal: LAYOUT.safeMobile },
    { paddingBottom: contentPaddingBottom + bottomInset },
  ];

  const content = scrollable ? (
    <ScrollView
      style={styles.scroll}
      contentContainerStyle={contentStyle}
      showsVerticalScrollIndicator={false}
      testID={contentTestID}
    >
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.scroll, contentStyle]} testID={contentTestID}>
      {children}
    </View>
  );

  return (
    <View style={styles.root} testID={testID}>
      <View style={[styles.topStack, { paddingTop: topInset }]}
        testID={`${testID}-top`}
      >
        {bar}
        {top}
      </View>
      {content}
      {tabs ? (
        <View style={styles.bottomStack} testID={`${testID}-bottom`}>
          {tabs}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    flex: 1,
    backgroundColor: PALETTE.appBg,
  },
  topStack: {
    width: '100%',
    backgroundColor: PALETTE.appBg,
    zIndex: 2,
  },
  scroll: {
    flex: 1,
  },
  contentInner: {
    width: '100%',
    maxWidth: LAYOUT.contentDesktop,
    alignSelf: 'center',
    paddingTop: SPACING.xl,
  },
  bottomStack: {
    width: '100%',
    zIndex: 3,
  },
});

export default AppShell;
