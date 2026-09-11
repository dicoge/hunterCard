import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import ScanQuotaBanner from './ScanQuotaBanner';
import { PALETTE, SEMANTIC, LAYOUT } from '../theme/tokensV2';

export interface ScanTopBarProps {
  onClose?: () => void;
  onFlash?: () => void;
  flashOn?: boolean;
  /** Camera not active yet (permission / gallery states): flash is inert. */
  flashDisabled?: boolean;
  testID?: string;
}

/**
 * Pen App/04 `x7iIL` Top Bar — Close ✕ / quota pill / Flash, shared by the
 * live camera overlay AND the pre-camera surfaces (permission gate,
 * gallery mode, loading) so the scan route always carries the Pen top
 * action row. DIC-1409 CR fix: this row was missing from the shipped
 * route (the drawer header stood in for it).
 */
export default function ScanTopBar({
  onClose,
  onFlash,
  flashOn = false,
  flashDisabled = false,
  testID = 'scan-top-bar',
}: ScanTopBarProps) {
  return (
    <View style={styles.row} testID={testID}>
      <TouchableOpacity
        style={styles.roundBtn}
        onPress={onClose}
        disabled={!onClose}
        accessibilityRole="button"
        accessibilityLabel="關閉掃描"
        testID={`${testID}-close`}
      >
        <Text style={styles.roundBtnGlyph}>✕</Text>
      </TouchableOpacity>
      <ScanQuotaBanner />
      <TouchableOpacity
        style={[styles.roundBtn, flashOn && styles.roundBtnActive, flashDisabled && styles.roundBtnDisabled]}
        onPress={onFlash}
        disabled={flashDisabled || !onFlash}
        accessibilityRole="button"
        accessibilityLabel="閃光燈"
        accessibilityState={{ selected: flashOn, disabled: flashDisabled }}
        testID={`${testID}-flash`}
      >
        <Text style={styles.roundBtnGlyph}>⚡︎</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 56,
    paddingHorizontal: LAYOUT.safeMobile - 4,
    gap: 8,
  },
  roundBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(20,20,31,0.85)',
    borderWidth: 1,
    borderColor: PALETTE.border,
  },
  roundBtnActive: {
    backgroundColor: PALETTE.accent,
    borderColor: PALETTE.accent,
  },
  roundBtnDisabled: {
    opacity: 0.4,
  },
  roundBtnGlyph: {
    color: SEMANTIC.onBg,
    fontSize: 14,
    fontWeight: '700',
  },
});
