// DIC-1160 Phase 1: SVG path registry for the shared AppIcon component.
//
// Each entry is a set of stroke-based <path d="..."/> definitions on a 24x24
// viewBox. Paths are hand-picked so every icon renders as a single-color,
// rounded, Koboyo-style outline (`strokeLinecap="round" strokeLinejoin="round"`
// applied by AppIcon). Do not add filled shapes here; the entire foundation is
// currentColor-driven so a screen can pass any tint.
//
// Paths derive from the open-source Feather icon set (MIT). We inline them so
// no extra runtime dependency is introduced and the registry stays a pure data
// module — safe for the emoji-free assertion in
// scripts/test-app-icon-registry.mjs to prove there is no glyph fallback path.

export const iconRegistry = {
  // Navigation icons (AppNavigator drawer)
  home: [
    'M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1z',
  ],
  camera: [
    'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z',
    'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  ],
  search: [
    'M21 21l-4.35-4.35',
    'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16z',
  ],
  heart: [
    'M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z',
  ],
  layers: [
    'M12 2 2 7l10 5 10-5-10-5z',
    'M2 17l10 5 10-5',
    'M2 12l10 5 10-5',
  ],
  trophy: [
    'M8 21h8',
    'M12 17v4',
    'M17 4h4v3a4 4 0 0 1-4 4',
    'M7 4H3v3a4 4 0 0 0 4 4',
    'M17 4H7v6a5 5 0 0 0 10 0z',
  ],
  bell: [
    'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9',
    'M13.73 21a2 2 0 0 1-3.46 0',
  ],
  'book-open': [
    'M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z',
    'M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z',
  ],
  settings: [
    'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],

  // Status / trend icons (PriceTrendBadge)
  'trending-up': [
    'M23 6l-9.5 9.5-5-5L1 18',
    'M17 6h6v6',
  ],
  'trending-down': [
    'M23 18l-9.5-9.5-5 5L1 6',
    'M17 18h6v-6',
  ],
  minus: [
    'M5 12h14',
  ],
  'bar-chart-2': [
    'M18 20V10',
    'M12 20V4',
    'M6 20v-6',
  ],

  // Generic states — reserved for future migrations; kept in Phase 1 so
  // downstream screens can reach for the same registry without a follow-up PR.
  'check-circle': [
    'M22 11.08V12a10 10 0 1 1-5.93-9.14',
    'M22 4L12 14.01l-3-3',
  ],
  'alert-triangle': [
    'M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z',
    'M12 9v4',
    'M12 17h.01',
  ],
  'external-link': [
    'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6',
    'M15 3h6v6',
    'M10 14 21 3',
  ],
  x: [
    'M18 6 6 18',
    'M6 6l12 12',
  ],
} as const;

export type IconName = keyof typeof iconRegistry;

export function isKnownIcon(name: string): name is IconName {
  return Object.prototype.hasOwnProperty.call(iconRegistry, name);
}
