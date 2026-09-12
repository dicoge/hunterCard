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

/**
 * Pen `C / Status Bar` (id `lELzX`, 390×54). Renders the mocked status row
 * used above `AppBar` on the marketing / preview surfaces so the shipped web
 * build matches the Pen frames. On native this is layered above the real OS
 * status bar via a 54px band.
 */
export function AppStatusBar({
  time = '9:41',
  showTime = true,
  showIndicators = true,
  tintColor = PALETTE.textPrimary,
  testID = 'shell-status-bar',
}: StatusBarProps) {
  return (
    <View style={styles.root} testID={testID} accessibilityRole="header">
      <View style={styles.time}>
        {showTime && (
          <Text
            style={[styles.timeText, { color: tintColor }]}
            testID={`${testID}-time`}
            accessibilityLabel={`time ${time}`}
          >
            {time}
          </Text>
        )}
      </View>
      <View style={styles.indicators} testID={`${testID}-indicators`}>
        {showIndicators && (
          <>
            <Glyph tint={tintColor} label="signal" testID={`${testID}-signal`} />
            <Glyph tint={tintColor} label="wifi" testID={`${testID}-wifi`} />
            <Glyph tint={tintColor} label="battery" testID={`${testID}-battery`} />
          </>
        )}
      </View>
    </View>
  );
}

function Glyph({ tint, label, testID }: { tint: string; label: string; testID: string }) {
  return (
    <View
      style={[styles.glyph, { borderColor: tint }]}
      testID={testID}
      accessibilityLabel={label}
    />
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
    alignItems: 'center',
    gap: 6,
    minWidth: 60,
    justifyContent: 'flex-end',
  },
  glyph: {
    width: 16,
    height: 16,
    borderRadius: 3,
    borderWidth: 1.4,
    opacity: 0.85,
  },
});

export default AppStatusBar;
