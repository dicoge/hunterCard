import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Platform, StatusBar } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import ScanQuotaBanner from './ScanQuotaBanner';
import { useTranslation } from '../i18n';
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
/** Height of the bar's row below the inset (styles.row minHeight). */
export const SCAN_TOP_BAR_HEIGHT = 56;
/** Minimum touch target (Android 48dp); the Pen circle stays 34 inside it. */
export const SCAN_TOP_BAR_TOUCH = 48;

/**
 * Top inset the scan chrome must clear. The Scan route is full-bleed under Android
 * edge-to-edge (app.base.json), so y = 0 is under the status bar: v39 put the ✕ there,
 * too high to reach (user report 2026-10-16). StatusBar.currentHeight backs up an
 * inset the provider has not measured yet; web has neither.
 */
export function useScanTopInset(): number {
  const insets = useSafeAreaInsets();
  const statusBar = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 0) : 0;
  return Math.max(insets.top || 0, statusBar);
}

export default function ScanTopBar({
  onClose,
  onFlash,
  flashOn = false,
  flashDisabled = false,
  testID = 'scan-top-bar',
}: ScanTopBarProps) {
  const { t } = useTranslation();
  const topInset = useScanTopInset();
  return (
    <View style={[styles.row, { paddingTop: topInset }]} testID={testID}>
      <TouchableOpacity
        style={styles.touch}
        onPress={onClose}
        disabled={!onClose}
        accessibilityRole="button"
        accessibilityLabel={t('scan_close_a11y')}
        testID={`${testID}-close`}
      >
        <View style={styles.roundBtn}>
          <Text style={styles.roundBtnGlyph}>✕</Text>
        </View>
      </TouchableOpacity>
      <ScanQuotaBanner />
      <TouchableOpacity
        style={styles.touch}
        onPress={onFlash}
        disabled={flashDisabled || !onFlash}
        accessibilityRole="button"
        accessibilityLabel={flashOn ? t('scan_flash_on') : t('scan_flash')}
        accessibilityState={{ selected: flashOn, disabled: flashDisabled }}
        testID={`${testID}-flash`}
      >
        <View style={[styles.roundBtn, flashOn && styles.roundBtnActive, flashDisabled && styles.roundBtnDisabled]}>
          <Text style={styles.roundBtnGlyph}>⚡︎</Text>
        </View>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: SCAN_TOP_BAR_HEIGHT,
    paddingHorizontal: LAYOUT.safeMobile - 11,
    gap: 1,
  },
  touch: {
    width: SCAN_TOP_BAR_TOUCH,
    height: SCAN_TOP_BAR_TOUCH,
    alignItems: 'center',
    justifyContent: 'center',
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
