import React, { Component, ReactNode } from 'react';
import { View, Text, StyleSheet, TouchableOpacity, Linking, ViewStyle } from 'react-native';
import { useAuthStore } from '../store/authStore';
import { COLORS } from '../constants';
import { UserRole } from '../types/auth';

/**
 * Production Ad Traffic Gate Flag (DIC-1157 CR §1)
 * Default is FALSE: Production traffic is OFF by default until owner policy review.
 */
export const PRODUCTION_ADS_ENABLED = false;

export interface AdSlotProps {
  slotId?: string;
  format?: 'banner' | 'inline' | 'native';
  testProvider?: boolean;
  style?: ViewStyle;
  hasConsent?: boolean;
  // Optional explicit entitlement override for server-authoritative verification
  serverValidatedRole?: UserRole | null;
}

interface ErrorBoundaryProps {
  children: ReactNode;
  fallback?: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

/**
 * Real Class Error Boundary for AdSlot (DIC-1157 CR §1)
 * Guarantees that any unexpected rendering or component error fails closed safely by rendering null.
 */
export class AdSlotErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(_: Error): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Fail-closed logging seam: log error without surfacing banner or blocking application execution
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[AdSlot] Fail-closed caught error in AdSlot component:', error, errorInfo);
    }
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return this.props.fallback ?? null;
    }
    return this.props.children;
  }
}

/**
 * Core AdSlot Inner Component (DIC-1157 Commercialization Prep & CR §1)
 */
export const AdSlotInner: React.FC<AdSlotProps> = ({
  slotId = 'default_footer_banner',
  format = 'banner',
  testProvider = false,
  style,
  hasConsent = false,
  serverValidatedRole,
}) => {
  const storeRole = useAuthStore((s) => s.role);
  const isAuthenticated = useAuthStore((s) => s.isAuthenticated);

  // 1. Consent Gate: Unknown / missing CMP consent MUST fail closed (DIC-1157 CR §1)
  if (hasConsent !== true) {
    return null;
  }

  // 2. Production Traffic Gate: Production ads are off by default.
  // Unless explicitly in staging testProvider mode, non-production ads fail closed.
  if (!PRODUCTION_ADS_ENABLED && testProvider !== true) {
    return null;
  }

  // 3. Entitlement Resolution (DIC-1157 CR Blocker 1):
  // AdSlot MUST NOT fall back to persisted authStore.role when serverValidatedRole is absent.
  // Undefined, null, loading, or unverified entitlement MUST fail closed to null.
  // Only an explicit server-validated non-subscriber result ('free_user' | 'guest') may allow an ad.
  if (serverValidatedRole === undefined || serverValidatedRole === null) {
    return null;
  }

  // Pro Subscribers have zero ads (entitlement check)
  if (serverValidatedRole === 'subscriber') {
    return null;
  }

  // Fail closed if serverValidatedRole is not free_user or guest
  if (serverValidatedRole !== 'free_user' && serverValidatedRole !== 'guest') {
    return null;
  }

  return (
    <View style={[styles.container, style]} testID={`ad-slot-${slotId}`}>
      <View style={styles.adBadge}>
        <Text style={styles.adBadgeText}>贊助廣告 (測試與沙盒)</Text>
      </View>
      
      {testProvider ? (
        <TouchableOpacity
          style={styles.testAdContent}
          onPress={() => {
            Linking.openURL('https://holohunter.dicoge.com/pricing.html');
          }}
        >
          <Text style={styles.testAdTitle}>🌸 HoloHunter 低干擾測試廣告版位</Text>
          <Text style={styles.testAdSub}>正式流量預設關閉．Pro 訂閱帳號享純淨無廣告體驗</Text>
        </TouchableOpacity>
      ) : (
        <View style={styles.placeholderContent}>
          <Text style={styles.placeholderText}>廣告載入中...</Text>
        </View>
      )}
    </View>
  );
};

/**
 * Exported AdSlot Wrapped in Real Error Boundary
 */
export const AdSlot: React.FC<AdSlotProps> = (props) => {
  return (
    <AdSlotErrorBoundary fallback={null}>
      <AdSlotInner {...props} />
    </AdSlotErrorBoundary>
  );
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
