// DIC-1160 Phase 1: single accessible icon component.
//
// Renders an entry from `iconRegistry` as an inline SVG via `react-native-svg`,
// which resolves to a real DOM <svg> on web and a native Skia-backed SVG on
// iOS/Android — so migrated surfaces render the same shape on every platform
// (unlike the previous OS emoji glyphs, which drifted per-OS).
//
// Accessibility rules:
//  - `decorative` (default true) marks the icon `aria-hidden` and hides it from
//    the RN accessibility tree, because these icons sit next to a text label
//    (drawer item, trend label). A screen reader announces the label; the icon
//    would duplicate that reading.
//  - Set `decorative={false}` and pass `accessibilityLabel` when the icon is
//    the only affordance (an icon-only button). AppIcon then exposes an
//    `image` role with the given label.
//
// Any unknown name renders nothing and warns once in dev; production has no
// fallback glyph on purpose, so a missing icon is visible as a gap instead of
// silently regressing to an emoji.

import React from 'react';
import { View, StyleProp, ViewStyle } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { DESIGN_TOKENS, type IconSizeToken } from '../../constants/tokens';
import { iconRegistry, type IconName } from './iconRegistry';

export interface AppIconProps {
  name: IconName;
  size?: IconSizeToken | number;
  color?: string;
  strokeWidth?: number;
  decorative?: boolean;
  accessibilityLabel?: string;
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

function resolveSize(size: AppIconProps['size']): number {
  if (typeof size === 'number') return size;
  if (size && size in DESIGN_TOKENS.iconSize) return DESIGN_TOKENS.iconSize[size];
  return DESIGN_TOKENS.iconSize.md;
}

const warnedIcons = new Set<string>();

export function AppIcon({
  name,
  size = 'md',
  color = DESIGN_TOKENS.colors.textSecondary,
  strokeWidth = 1.8,
  decorative = true,
  accessibilityLabel,
  style,
  testID,
}: AppIconProps): React.ReactElement | null {
  const paths = iconRegistry[name];
  if (!paths) {
    if (!warnedIcons.has(name)) {
      warnedIcons.add(name);
      // eslint-disable-next-line no-console
      console.warn(`[AppIcon] unknown icon "${name}" — registry miss, rendering nothing`);
    }
    return null;
  }
  const numericSize = resolveSize(size);

  // Decorative icons: hide from every accessibility surface. Meaningful icons:
  // expose `image` role and the caller-provided label.
  const a11yProps = decorative
    ? {
        accessibilityElementsHidden: true,
        importantForAccessibility: 'no-hide-descendants' as const,
        accessible: false,
      }
    : {
        accessibilityRole: 'image' as const,
        accessible: true,
        accessibilityLabel,
      };

  return (
    <View
      style={[{ width: numericSize, height: numericSize }, style]}
      testID={testID}
      {...a11yProps}
    >
      <Svg
        width={numericSize}
        height={numericSize}
        viewBox="0 0 24 24"
        fill="none"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        // aria-hidden on the SVG DOM node is the web-side equivalent of
        // accessibilityElementsHidden; kept in lock-step so screen readers on
        // holohunter.dicoge.com match the mobile behavior.
        {...(decorative ? { 'aria-hidden': true, focusable: false } : { role: 'img', 'aria-label': accessibilityLabel })}
      >
        {paths.map((d, index) => (
          <Path key={index} d={d} />
        ))}
      </Svg>
    </View>
  );
}

export default AppIcon;
