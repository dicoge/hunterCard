// DIC-1160 Phase 1: shared visual tokens for the HoloHunter design system.
//
// Screens should reference DESIGN_TOKENS rather than hardcoding hex values or
// magic numbers. The existing `COLORS` export in `./index.ts` remains the
// backwards-compatible entrypoint for legacy call sites; new work should reach
// for DESIGN_TOKENS. The palette is a superset of COLORS with the WCAG-AA
// contrast pairs the DIC-1151 spec requires, so a screen migrating from COLORS
// to DESIGN_TOKENS.colors will keep the same brand look.

const space = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  '2xl': 32,
  '3xl': 48,
} as const;

const radius = {
  none: 0,
  sm: 4,
  md: 8,
  lg: 12,
  xl: 16,
  full: 9999,
} as const;

const colors = {
  background: '#0f0f23',
  surface: '#1a1a2e',
  surfaceLight: '#252542',
  surfaceHover: '#2e2e50',
  primary: '#ff6b9d',
  primaryHover: '#ff8fb3',
  primaryMuted: 'rgba(255, 107, 157, 0.15)',
  secondary: '#6366f1',
  infoAction: '#4285F4',
  success: '#10b981',
  successMuted: 'rgba(16, 185, 129, 0.15)',
  warning: '#f59e0b',
  warningMuted: 'rgba(245, 158, 11, 0.15)',
  error: '#ef4444',
  errorMuted: 'rgba(239, 68, 68, 0.15)',
  textPrimary: '#ffffff',
  textSecondary: '#a0aec0',
  textMuted: '#718096',
  border: '#2d3748',
  borderFocused: '#ff6b9d',
} as const;

const typography = {
  display: { fontSize: 32, lineHeight: 40, fontWeight: '700' as const },
  h1: { fontSize: 24, lineHeight: 32, fontWeight: '700' as const },
  h2: { fontSize: 20, lineHeight: 28, fontWeight: '600' as const },
  h3: { fontSize: 16, lineHeight: 24, fontWeight: '600' as const },
  body: { fontSize: 14, lineHeight: 20, fontWeight: '400' as const },
  bodySmall: { fontSize: 12, lineHeight: 16, fontWeight: '400' as const },
  caption: { fontSize: 11, lineHeight: 14, fontWeight: '500' as const },
} as const;

const iconSize = {
  sm: 16,
  md: 20,
  lg: 24,
  xl: 40,
  '2xl': 48,
} as const;

export const DESIGN_TOKENS = {
  space,
  radius,
  colors,
  typography,
  iconSize,
} as const;

export type IconSizeToken = keyof typeof iconSize;
export type SpaceToken = keyof typeof space;
export type RadiusToken = keyof typeof radius;
