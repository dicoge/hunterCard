import React from 'react';
import { View, StyleSheet, ScrollView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { PALETTE, LAYOUT, SPACING } from '../../theme/tokensV2';
import { AppBar, AppBarProps } from './AppBar';
import { BottomTabBar, BottomTabBarProps } from './BottomTabBar';

export interface AppShellProps {
  children?: React.ReactNode;
  appBar?: AppBarProps | false;
  bottomTabBar?: BottomTabBarProps | false;
  scrollable?: boolean;
  contentPadding?: boolean;
  testID?: string;
  contentTestID?: string;
}

/**
 * Cross-platform shell used by every top-level screen in Phase 2/3. Layers:
 *   • App bar (Pen `App Bar`, 390×56)
 *   • Scrollable content region
 *   • Bottom tab bar (Pen `C / Tab Bar`, 390×96 with scan FAB)
 *
 * DIC-1452: no simulated device chrome — the OS status bar outside the app
 * (or the browser's own UI) is the only status treatment on every platform;
 * the top safe-area inset keeps the spacing where the OS draws over the app.
 *
 * Layout mirrors the Pen bounds exactly at 390 and stretches for wider
 * viewports without breaking the `content-desktop 1328` clamp.
 */
export function AppShell({
  children,
  appBar,
  bottomTabBar,
  scrollable = true,
  contentPadding = true,
  testID = 'shell-root',
  contentTestID = 'shell-content',
}: AppShellProps) {
  const insets = useSafeAreaInsets();
  const topInset = Math.max(insets.top, Platform.OS === 'web' ? 0 : LAYOUT.safeMobile);
  const bottomInset = Math.max(insets.bottom, Platform.OS === 'web' ? 0 : LAYOUT.safeMobile);

  const top = appBar === false ? null : <AppBar {...(appBar ?? {})} />;
  const tabs = bottomTabBar === false || !bottomTabBar ? null : (
    <BottomTabBar {...bottomTabBar} />
  );

  // DIC-1452: the tab bar is a flex sibling BELOW the content region, so it
  // already reserves its own height — re-padding the content by the bar's
  // height on top of that was the ~110px dead void under the last row. With
  // tabs, SPACING.md plus the content's own trailing rhythm (e.g. the Pen
  // 14px grid row gap → 8+14 = 22px) keeps the last row 16–24px above the
  // navigation frame. The COMPUTED bottom inset (reported inset, floored at
  // LAYOUT.safeMobile on native where a zero/unavailable report still needs
  // clearance) is applied once, on the bottom stack; only a tabless shell
  // (content reaching the screen edge) absorbs it into the content.
  const contentPaddingBottom = tabs ? SPACING.md : SPACING['3xl'] + bottomInset;
  const contentStyle = [
    styles.contentInner,
    contentPadding && { paddingHorizontal: LAYOUT.safeMobile },
    { paddingBottom: contentPaddingBottom },
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
        {top}
      </View>
      {content}
      {tabs ? (
        <View
          style={[styles.bottomStack, { paddingBottom: bottomInset }]}
          testID={`${testID}-bottom`}
        >
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
