// Stands in for react-native-safe-area-context, which reaches for the Flow-typed
// `react-native` package through CJS `require` — a path the ESM alias hook cannot
// intercept, so importing it crashes module load.
//
// It contributes nothing but device inset padding, and on web the shipped build
// resolves those insets to zero anyway, so a screen renders the same tree here as
// it does in the browser.
import React from 'react';
import { View } from 'react-native-web';

const ZERO_INSETS = { top: 0, right: 0, bottom: 0, left: 0 };

// DIC-1452: the AppShell inset-fallback regression needs to render under
// device-reported inset values other than the web zero default. Tests may
// override the hook's return per render; passing null restores the default.
let currentInsets = ZERO_INSETS;
export function __setSafeAreaInsetsForTest(insets) {
  currentInsets = insets ? { ...ZERO_INSETS, ...insets } : ZERO_INSETS;
}

export const SafeAreaView = React.forwardRef((props, ref) =>
  React.createElement(View, { ...props, ref }));
SafeAreaView.displayName = 'SafeAreaView';

export const SafeAreaProvider = ({ children }) => children;
export const SafeAreaInsetsContext = React.createContext(ZERO_INSETS);
export const useSafeAreaInsets = () => currentInsets;
export const useSafeAreaFrame = () => ({ x: 0, y: 0, width: 0, height: 0 });
export const initialWindowMetrics = { insets: ZERO_INSETS, frame: { x: 0, y: 0, width: 0, height: 0 } };
