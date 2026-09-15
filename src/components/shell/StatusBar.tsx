import React from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { PALETTE, LAYOUT, FONTS, TYPE_SCALE } from '../../theme/tokensV2';

export interface StatusBarProps {
  time?: string;
  showTime?: boolean;
  showIndicators?: boolean;
  tintColor?: string;
  testID?: string;
}

function liveClock(): string {
  const now = new Date();
  return `${now.getHours()}:${String(now.getMinutes()).padStart(2, '0')}`;
}

/**
 * Pen `C / Status Bar` (id `lELzX`, 390×54). DIC-1427 QA rework:
 *  • Web renders the Pen status row with the REAL current time and properly
 *    drawn signal / wifi / battery glyphs (the old bordered squares were the
 *    "empty □□□" P1) — a browser tab/standalone PWA has no OS status row of
 *    its own, so this is the single status treatment, not a duplicate.
 *  • Native renders NOTHING here: the OS already draws its own status bar
 *    over the safe-area inset, and doubling it was the user's original
 *    duplicate-status-bar P0. AppShell's top inset keeps the spacing.
 */
export function AppStatusBar({
  time,
  showTime = true,
  showIndicators = true,
  tintColor = PALETTE.textPrimary,
  testID = 'shell-status-bar',
}: StatusBarProps) {
  if (Platform.OS !== 'web') return null;
  return (
    <View style={styles.root} testID={testID} accessibilityRole="header">
      <View style={styles.time}>
        {showTime && (
          <Text
            style={[styles.timeText, { color: tintColor }]}
            testID={`${testID}-time`}
            accessibilityLabel={`time ${time ?? liveClock()}`}
          >
            {time ?? liveClock()}
          </Text>
        )}
      </View>
      <View style={styles.indicators} testID={`${testID}-indicators`}>
        {showIndicators && (
          <>
            <SignalGlyph tint={tintColor} testID={`${testID}-signal`} />
            <WifiGlyph tint={tintColor} testID={`${testID}-wifi`} />
            <BatteryGlyph tint={tintColor} testID={`${testID}-battery`} />
          </>
        )}
      </View>
    </View>
  );
}

/** lucide `signal-high` — four ascending bars (Pen node BVQVL). */
function SignalGlyph({ tint, testID }: { tint: string; testID: string }) {
  return (
    <View style={styles.glyphBox} testID={testID} accessibilityLabel="signal">
      {[5, 8, 11, 14].map((h, i) => (
        <View
          key={i}
          style={{
            width: 2.5,
            height: h,
            borderRadius: 1,
            backgroundColor: tint,
            opacity: i === 3 ? 0.35 : 0.9,
          }}
        />
      ))}
    </View>
  );
}

/** lucide `wifi` — three nested arcs over a dot (Pen node L86PFW). */
function WifiGlyph({ tint, testID }: { tint: string; testID: string }) {
  const arc = (size: number, opacity: number) => (
    <View
      style={{
        position: 'absolute',
        bottom: 1,
        alignSelf: 'center',
        width: size,
        height: size,
        borderRadius: size / 2,
        borderWidth: 1.6,
        borderColor: tint,
        borderBottomColor: 'transparent',
        borderLeftColor: 'transparent',
        borderRightColor: 'transparent',
        transform: [{ translateY: size / 2 }],
        opacity,
      }}
    />
  );
  return (
    <View style={[styles.glyphBox, { justifyContent: 'center' }]} testID={testID} accessibilityLabel="wifi">
      {arc(14, 0.5)}
      {arc(9, 0.75)}
      <View
        style={{
          position: 'absolute',
          bottom: 2,
          alignSelf: 'center',
          width: 3,
          height: 3,
          borderRadius: 1.5,
          backgroundColor: tint,
        }}
      />
    </View>
  );
}

/** lucide `battery-full` — outline shell, nub, filled level (Pen jfouI). */
function BatteryGlyph({ tint, testID }: { tint: string; testID: string }) {
  return (
    <View style={[styles.glyphBox, { flexDirection: 'row', alignItems: 'center', gap: 1 }]} testID={testID} accessibilityLabel="battery">
      <View
        style={{
          width: 14,
          height: 9,
          borderRadius: 2.5,
          borderWidth: 1.2,
          borderColor: tint,
          padding: 1.2,
          justifyContent: 'center',
        }}
      >
        <View style={{ flex: 1, borderRadius: 1, backgroundColor: tint, opacity: 0.9 }} />
      </View>
      <View style={{ width: 1.6, height: 4, borderRadius: 1, backgroundColor: tint, opacity: 0.8 }} />
    </View>
  );
}

const styles = StyleSheet.create({
  root: {
    width: '100%',
    height: LAYOUT.statusBar.height,
    paddingHorizontal: LAYOUT.safeMobile,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'transparent',
  },
  time: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 40,
  },
  timeText: {
    fontFamily: Platform.OS === 'web' ? FONTS.display : undefined,
    fontSize: TYPE_SCALE.body.size,
    fontWeight: '600',
    letterSpacing: 0.4,
  },
  indicators: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 7,
    minWidth: 60,
    justifyContent: 'flex-end',
  },
  glyphBox: {
    width: 17,
    height: 16,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'center',
    gap: 1.5,
    overflow: 'visible',
  },
});

export default AppStatusBar;
