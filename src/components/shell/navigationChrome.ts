import { createContext, useContext } from 'react';
import { Platform } from 'react-native';
import { useBreakpoint } from '../../hooks/useBreakpoint';

/**
 * Responsive navigation chrome (2026-11-03).
 *
 * On web at the desktop breakpoint, MainDrawer is a PERMANENT 260px sidebar
 * (AppNavigator: `drawerType: isDesktop ? 'permanent' : 'front'`, same
 * useBreakpoint source). A screen inside that drawer must not also draw the
 * mobile bottom tab bar — that was the duplicated, stretched navigation.
 * Root-stack screens (CardDetail / SearchResults / TutorialDetail /
 * TutorialSimulation) live OUTSIDE the drawer, so they keep the shared tab
 * registry as a compact centred dock: their only global navigation besides
 * their own back arrow.
 *
 * Native keeps the mobile bar everywhere; since R2 its drawer is also always
 * the overlay drawer (no permanent sidebar on native, see isPermanentDrawer).
 */
export type ShellNavMode = 'bottom-tabs' | 'dock' | 'drawer';

/** True for screens rendered inside MainDrawer (provided by AppNavigator). */
export const DrawerHostContext = createContext(false);

/**
 * The ONE condition for a permanent sidebar, shared by MainDrawer and the
 * shell. Native (phones in landscape ≥768, tablets) keeps the touch bottom
 * tabs plus an overlay ('front') drawer at every width, so it never shows a
 * permanent sidebar next to the bottom tabs. Web ≥768 keeps the permanent
 * drawer as before.
 */
export function isPermanentDrawer(params: { platform: string; isDesktop: boolean }): boolean {
  return params.platform === 'web' && params.isDesktop;
}

export function resolveShellNavMode(params: { platform: string; isDesktop: boolean; inDrawer: boolean }): ShellNavMode {
  if (!isPermanentDrawer(params)) return 'bottom-tabs';
  return params.inDrawer ? 'drawer' : 'dock';
}

/** MainDrawer presentation derived from the same rule (exported for tests). */
export function drawerPresentation(params: { platform: string; isDesktop: boolean }) {
  const permanent = isPermanentDrawer(params);
  return { drawerType: permanent ? ('permanent' as const) : ('front' as const), width: permanent ? 260 : 280, borderRightWidth: permanent ? 1 : 0 };
}

export function useShellNavMode(): ShellNavMode {
  const inDrawer = useContext(DrawerHostContext);
  const { isDesktop } = useBreakpoint();
  return resolveShellNavMode({ platform: Platform.OS, isDesktop, inDrawer });
}
