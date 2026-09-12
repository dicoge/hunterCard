import React from 'react';
import { View } from 'react-native';

// DIC-1427: the Pen v2 frames use lucide glyphs (house / search / layers /
// user / scan-line / sliders-horizontal / chevron-down / x) but the app ships
// no icon or SVG dependency. These are the same glyphs drawn from Views so the
// shared shell can match the Pen `C / Tab Bar` (H8TW7) and `App / 02 搜尋結果`
// (Z6jlE) chrome on Web/Android/iOS without a new native module.

export interface GlyphProps {
  color: string;
  size?: number;
  testID?: string;
}

/** lucide `search` — ring + angled handle (Pen node b0YrH / Gy1Xf). */
export function SearchGlyph({ color, size = 16, testID }: GlyphProps) {
  const ring = Math.round(size * 0.62);
  const stroke = Math.max(1.5, size / 11);
  return (
    <View style={{ width: size, height: size }} testID={testID}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: stroke,
          borderColor: color,
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: ring - stroke / 2,
          top: ring - stroke / 2,
          width: Math.round(size * 0.4),
          height: stroke,
          borderRadius: stroke,
          backgroundColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

/** lucide `sliders-horizontal` — three rails with offset knobs (Pen w5jzG9). */
export function SlidersGlyph({ color, size = 21, testID }: GlyphProps) {
  const rail = Math.max(1.5, size / 12);
  const knob = Math.round(size * 0.3);
  const rows: Array<{ knobLeft: number }> = [
    { knobLeft: Math.round(size * 0.55) },
    { knobLeft: Math.round(size * 0.15) },
    { knobLeft: Math.round(size * 0.45) },
  ];
  return (
    <View style={{ width: size, height: size, justifyContent: 'space-between', paddingVertical: rail }} testID={testID}>
      {rows.map((row, i) => (
        <View key={i} style={{ height: knob, justifyContent: 'center' }}>
          <View style={{ height: rail, borderRadius: rail, backgroundColor: color, opacity: 0.9 }} />
          <View
            style={{
              position: 'absolute',
              left: row.knobLeft,
              width: knob,
              height: knob,
              borderRadius: knob / 2,
              borderWidth: rail,
              borderColor: color,
              backgroundColor: 'transparent',
            }}
          />
        </View>
      ))}
    </View>
  );
}

/** lucide `chevron-down` (Pen sort node JUOl0). */
export function ChevronDownGlyph({ color, size = 14, testID }: GlyphProps) {
  const arm = Math.round(size * 0.5);
  const stroke = Math.max(1.5, size / 9);
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }} testID={testID}>
      <View
        style={{
          width: arm,
          height: arm,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          transform: [{ rotate: '45deg' }, { translateY: -arm / 4 }],
        }}
      />
    </View>
  );
}

/** lucide `x` — chip dismiss cross (Pen chip nodes Kh7y3 / WvlGb). */
export function XGlyph({ color, size = 12, testID }: GlyphProps) {
  const stroke = Math.max(1.5, size / 8);
  const bar = {
    position: 'absolute' as const,
    left: 0,
    top: (size - stroke) / 2,
    width: size,
    height: stroke,
    borderRadius: stroke,
    backgroundColor: color,
  };
  return (
    <View style={{ width: size, height: size }} testID={testID}>
      <View style={[bar, { transform: [{ rotate: '45deg' }] }]} />
      <View style={[bar, { transform: [{ rotate: '-45deg' }] }]} />
    </View>
  );
}

/** lucide `house` (Pen tab node y8M9Eb). */
export function HouseGlyph({ color, size = 22, testID }: GlyphProps) {
  const stroke = Math.max(1.5, size / 12);
  const body = Math.round(size * 0.58);
  const roof = Math.round(size * 0.52);
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }} testID={testID}>
      <View
        style={{
          width: roof,
          height: roof,
          borderTopWidth: stroke,
          borderLeftWidth: stroke,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
          position: 'absolute',
          top: Math.round(size * 0.14),
        }}
      />
      <View
        style={{
          position: 'absolute',
          bottom: Math.round(size * 0.05),
          width: body,
          height: Math.round(size * 0.42),
          borderLeftWidth: stroke,
          borderRightWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          borderBottomLeftRadius: stroke,
          borderBottomRightRadius: stroke,
        }}
      />
    </View>
  );
}

/** lucide `layers` — stacked diamonds (Pen tab node h73l4L). */
export function LayersGlyph({ color, size = 22, testID }: GlyphProps) {
  const stroke = Math.max(1.5, size / 12);
  const diamond = Math.round(size * 0.44);
  const layer = (top: number, opacity = 1) => (
    <View
      style={{
        position: 'absolute',
        top,
        alignSelf: 'center',
        width: diamond,
        height: diamond,
        borderWidth: stroke,
        borderColor: color,
        opacity,
        transform: [{ rotate: '45deg' }, { scaleY: 0.62 }],
      }}
    />
  );
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }} testID={testID}>
      {layer(Math.round(size * 0.05))}
      {layer(Math.round(size * 0.28), 0.75)}
      {layer(Math.round(size * 0.51), 0.5)}
    </View>
  );
}

/** lucide `user` (Pen tab node CYqRT). */
export function UserGlyph({ color, size = 22, testID }: GlyphProps) {
  const stroke = Math.max(1.5, size / 12);
  const head = Math.round(size * 0.34);
  const torso = Math.round(size * 0.6);
  return (
    <View style={{ width: size, height: size, alignItems: 'center' }} testID={testID}>
      <View
        style={{
          width: head,
          height: head,
          borderRadius: head / 2,
          borderWidth: stroke,
          borderColor: color,
          marginTop: Math.round(size * 0.08),
        }}
      />
      <View
        style={{
          width: torso,
          height: Math.round(size * 0.34),
          borderTopLeftRadius: torso / 2,
          borderTopRightRadius: torso / 2,
          borderWidth: stroke,
          borderBottomWidth: 0,
          borderColor: color,
          marginTop: Math.round(size * 0.06),
        }}
      />
    </View>
  );
}

/** lucide `scan-line` — corner brackets + mid line (Pen FAB node Dvk56). */
export function ScanLineGlyph({ color, size = 28, testID }: GlyphProps) {
  const stroke = Math.max(2, size / 12);
  const arm = Math.round(size * 0.3);
  const corner = (style: object) => (
    <View
      style={[{ position: 'absolute', width: arm, height: arm, borderColor: color }, style]}
    />
  );
  return (
    <View style={{ width: size, height: size }} testID={testID}>
      {corner({ left: 0, top: 0, borderLeftWidth: stroke, borderTopWidth: stroke, borderTopLeftRadius: stroke * 2 })}
      {corner({ right: 0, top: 0, borderRightWidth: stroke, borderTopWidth: stroke, borderTopRightRadius: stroke * 2 })}
      {corner({ left: 0, bottom: 0, borderLeftWidth: stroke, borderBottomWidth: stroke, borderBottomLeftRadius: stroke * 2 })}
      {corner({ right: 0, bottom: 0, borderRightWidth: stroke, borderBottomWidth: stroke, borderBottomRightRadius: stroke * 2 })}
      <View
        style={{
          position: 'absolute',
          left: Math.round(size * 0.14),
          right: Math.round(size * 0.14),
          top: (size - stroke) / 2,
          height: stroke,
          borderRadius: stroke,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

/** lucide `arrow-left` (Pen back node A2SWo). */
export function ArrowLeftGlyph({ color, size = 22, testID }: GlyphProps) {
  const stroke = Math.max(1.5, size / 11);
  const head = Math.round(size * 0.4);
  return (
    <View style={{ width: size, height: size, justifyContent: 'center' }} testID={testID}>
      <View
        style={{
          width: Math.round(size * 0.78),
          height: stroke,
          borderRadius: stroke,
          backgroundColor: color,
          alignSelf: 'center',
        }}
      />
      <View
        style={{
          position: 'absolute',
          left: Math.round(size * 0.1),
          top: (size - head) / 2,
          width: head,
          height: head,
          borderLeftWidth: stroke,
          borderBottomWidth: stroke,
          borderColor: color,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}
