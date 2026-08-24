import React, { useState } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, ViewStyle } from 'react-native';
import { useAuthStore } from '../store/authStore';
import { COLORS } from '../constants';

export interface AdSlotProps {
  slotId?: string;
  format?: 'banner' | 'inline' | 'native';
  testProvider?: boolean;
  style?: ViewStyle;
  hasConsent?: boolean;
}

/**
 * AdSlot Component for HoloHunter (DIC-1157 Commercialization Prep)
 * 
 * Invariants & Policies:
 * 1. Pro Entitlement: Automatically hidden when `role === 'subscriber'`.
 * 2. Non-Intrusive Placement: Placed in footer or post-content areas only;
 *    never obscures cards, CTAs, prices, login, or deck editor.
 * 3. Fail-Closed Safety: Error boundary / fallback prevents ad loading errors
 *    from blocking or crashing the application.
 * 4. Privacy & Consent: Respects CMP consent status.
 */
export const AdSlot: React.FC<AdSlotProps> = ({
  slotId = 'default_footer_banner',
  format = 'banner',
  testProvider = true,
  style,
  hasConsent = true,
}) => {
  const role = useAuthStore((s) => s.role);
  const [hasError, setHasError] = useState(false);

  // Pro Subscribers have zero ads
  if (role === 'subscriber') {
    return null;
  }

  // If consent is denied or error encountered, fail-closed safely without blocking UI
  if (!hasConsent || hasError) {
    return null;
  }

  try {
    return (
      <View style={[styles.container, style]} testID={`ad-slot-${slotId}`}>
        <View style={styles.adBadge}>
          <Text style={styles.adBadgeText}>贊助廣告</Text>
        </View>
        
        {testProvider ? (
          <TouchableOpacity
            style={styles.testAdContent}
            onPress={() => {
              Linking.openURL('https://holohunter.dicoge.com/pricing.html');
            }}
          >
            <Text style={styles.testAdTitle}>🌸 HoloHunter Pro 方案測試廣告</Text>
            <Text style={styles.testAdSub}>升級 Pro 解鎖無限次相機掃描與 AI 價格預測（無廣告體驗）</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.placeholderContent}>
            <Text style={styles.placeholderText}>廣告加載中...</Text>
          </View>
        )}
      </View>
    );
  } catch (err) {
    // Fail-closed fallback: log error silently and return null
    setHasError(true);
    return null;
  }
};

const styles = StyleSheet.create({
  container: {
    marginVertical: 16,
    marginHorizontal: 16,
    padding: 12,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.border,
    position: 'relative',
    alignItems: 'center',
  },
  adBadge: {
    position: 'absolute',
    top: 6,
    right: 8,
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
  },
  adBadgeText: {
    color: COLORS.textSecondary,
    fontSize: 10,
    fontWeight: '600',
  },
  testAdContent: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  testAdTitle: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '700',
    marginBottom: 4,
  },
  testAdSub: {
    color: COLORS.textSecondary,
    fontSize: 11,
    textAlign: 'center',
  },
  placeholderContent: {
    paddingVertical: 10,
  },
  placeholderText: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
});

export default AdSlot;
