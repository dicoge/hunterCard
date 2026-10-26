import { Platform } from 'react-native';

export const PALETTE = {
  bg: '#08080F',
  surface: '#12121D',
  surface2: '#1A1A2A',
  border: '#282838',
  textPrimary: '#F6F6FB',
  textSecondary: '#9494B0',
  textMuted: '#6A6A85',
  accent: '#FF4D9D',
  accent2: '#3DE0FF',
  accent3: '#8B5CF6',
  cWhite: '#E4E4EE',
  cBlue: '#4C8DFF',
  cGreen: '#34D399',
  cRed: '#F87171',
  cPurple: '#C084FC',
  cYellow: '#FBBF24',
  appBg: '#0A0A13',
  appSurface: '#14141F',
  appElev: '#1C1C2B',
  stateDefault: '#F6F6FB',
  stateHover: '#FFFFFF',
  stateFocus: '#FF4D9D',
  stateDisabled: '#4B4B60',
  stateLoading: '#9494B0',
  stateError: '#F87171',
  comingSoonBg: '#3D2547',
  comingSoonFg: '#FFB4D9',
} as const;

export type PaletteToken = keyof typeof PALETTE;

export const SEMANTIC = {
  background: PALETTE.appBg,
  surface: PALETTE.appSurface,
  elev: PALETTE.appElev,
  border: PALETTE.border,
  divider: PALETTE.border,
  brand: PALETTE.accent,
  brandInk: PALETTE.textPrimary,
  brandCool: PALETTE.accent2,
  brandDeep: PALETTE.accent3,
  onBg: PALETTE.textPrimary,
  onBgMuted: PALETTE.textSecondary,
  onBgDim: PALETTE.textMuted,
  onBrand: '#FFFFFF',
  focusRing: PALETTE.stateFocus,
  disabled: PALETTE.stateDisabled,
  loading: PALETTE.stateLoading,
  error: PALETTE.stateError,
  success: PALETTE.cGreen,
  info: PALETTE.cBlue,
  warning: PALETTE.cYellow,
} as const;

export const CATEGORY_COLORS = {
  white: PALETTE.cWhite,
  blue: PALETTE.cBlue,
  green: PALETTE.cGreen,
  red: PALETTE.cRed,
  purple: PALETTE.cPurple,
  yellow: PALETTE.cYellow,
} as const;

export const FONTS = {
  display: Platform.select({
    web: '"Outfit", "Noto Sans TC", system-ui, -apple-system, sans-serif',
    ios: 'Outfit',
    android: 'Outfit',
    default: 'Outfit',
  }) as string,
  body: Platform.select({
    web: '"Noto Sans TC", "Outfit", system-ui, -apple-system, sans-serif',
    ios: 'Noto Sans TC',
    android: 'NotoSansTC',
    default: 'Noto Sans TC',
  }) as string,
} as const;

export const TYPE_SCALE = {
  micro: { size: 11, lineHeight: 15, weight: '400' as const },
  small: { size: 12, lineHeight: 16, weight: '400' as const },
  caption: { size: 13, lineHeight: 18, weight: '400' as const },
  label: { size: 14, lineHeight: 20, weight: '500' as const },
  body: { size: 15, lineHeight: 22, weight: '400' as const },
  bodyStrong: { size: 15, lineHeight: 22, weight: '600' as const },
  subtitle: { size: 16, lineHeight: 24, weight: '500' as const },
  title: { size: 18, lineHeight: 24, weight: '600' as const },
  heading: { size: 20, lineHeight: 28, weight: '600' as const },
  display: { size: 24, lineHeight: 30, weight: '700' as const },
  displayLg: { size: 28, lineHeight: 34, weight: '700' as const },
  hero: { size: 32, lineHeight: 40, weight: '800' as const },
} as const;

export type TypeScaleKey = keyof typeof TYPE_SCALE;

export const SPACING = {
  none: 0,
  xxs: 2,
  xs: 4,
  sm: 6,
  md: 8,
  lg: 12,
  xl: 16,
  '2xl': 20,
  '3xl': 24,
  '4xl': 32,
  '5xl': 40,
  '6xl': 48,
} as const;

export const RADII = {
  none: 0,
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 20,
  '2xl': 24,
  pill: 999,
} as const;

export const SHADOWS = {
  none: {
    shadowColor: 'transparent',
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffset: { width: 0, height: 0 },
    elevation: 0,
  },
  sm: {
    shadowColor: '#000000',
    shadowOpacity: 0.30,
    shadowRadius: 4,
    shadowOffset: { width: 0, height: 1 },
    elevation: 2,
  },
  md: {
    shadowColor: '#000000',
    shadowOpacity: 0.40,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 4 },
    elevation: 4,
  },
  lg: {
    shadowColor: '#000000',
    shadowOpacity: 0.50,
    shadowRadius: 16,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  glowPink: {
    shadowColor: PALETTE.accent,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  },
  glowCyan: {
    shadowColor: PALETTE.accent2,
    shadowOpacity: 0.30,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
} as const;

export const LAYOUT = {
  minTouch: 44,
  safeMobile: 20,
  contentMobile: 358,
  contentTabletMax: 720,
  contentDesktop: 1328,
  bp: {
    mobile: 0,
    tablet: 768,
    desktop: 1100,
    wide: 1440,
  },
  statusBar: {
    height: 54,
  },
  appBar: {
    height: 56,
  },
  bottomTab: {
    height: 84,
    fab: 64,
  },
  cardTile: {
    width: 112,
    artHeight: 156,
    fullHeight: 199,
  },
  seriesCard: {
    width: 175,
    height: 69,
  },
} as const;

export const OPACITY = {
  disabled: 0.4,
  overlayLight: 0.15,
  overlayHeavy: 0.6,
  scrim: 0.75,
} as const;

export const GRADIENTS = {
  brandPinkPurple: {
    colors: [PALETTE.accent, PALETTE.accent3],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  brandPinkCyan: {
    colors: [PALETTE.accent, PALETTE.accent2],
    start: { x: 0, y: 0 },
    end: { x: 1, y: 1 },
  },
  glowPurple: {
    colors: [PALETTE.accent3, PALETTE.accent],
    start: { x: 0, y: 0 },
    end: { x: 0, y: 1 },
  },
  heroBackdrop: {
    colors: [PALETTE.accent3 + 'A6', PALETTE.appBg],
    start: { x: 0.5, y: 0 },
    end: { x: 0.5, y: 1 },
  },
} as const;

export const TOKEN_ORIGIN = {
  penFile: 'docs/pen-v2/holohunter-landing-v2-updated.pen',
  penFileSha256: '6fbf0c06b15d726573871357bd7119c4d0046aa5d6eb3949aa735bd727d9272f',
  ticket: 'DIC-1409',
  phase: 2,
} as const;

export const tokensV2 = {
  palette: PALETTE,
  semantic: SEMANTIC,
  category: CATEGORY_COLORS,
  fonts: FONTS,
  type: TYPE_SCALE,
  spacing: SPACING,
  radii: RADII,
  shadows: SHADOWS,
  layout: LAYOUT,
  opacity: OPACITY,
  gradients: GRADIENTS,
  origin: TOKEN_ORIGIN,
} as const;

export type TokensV2 = typeof tokensV2;

export default tokensV2;
