import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity } from 'react-native';
import { COLORS } from '../constants';
import { useAuthStore } from '../store/authStore';
import { getRoleLabel } from '../services/permissionService';

interface Props {
  feature: string;
  children: React.ReactNode;
}

export default function PremiumGate({ feature, children }: Props) {
  const role = useAuthStore((s) => s.role);
  const hasAccess = role === 'subscriber';

  if (hasAccess) {
    return <>{children}</>;
  }

  return (
    <View style={styles.gate}>
      <View style={styles.lockIcon}>
        <Text style={styles.lockEmoji}>🔒</Text>
      </View>
      <Text style={styles.title}>Premium 功能</Text>
      <Text style={styles.description}>{feature}</Text>
      <Text style={styles.hint}>
        目前帳號：{getRoleLabel(role)}
      </Text>
      <TouchableOpacity style={styles.upgradeButton} activeOpacity={0.8}>
        <Text style={styles.upgradeText}>升級訂閱</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  gate: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    borderWidth: 1,
    borderColor: COLORS.accent + '44',
    padding: 24,
    alignItems: 'center',
    margin: 16,
  },
  lockIcon: {
    width: 56,
    height: 56,
    borderRadius: 28,
    backgroundColor: COLORS.accent + '22',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 12,
  },
  lockEmoji: {
    fontSize: 28,
  },
  title: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 6,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 20,
    marginBottom: 12,
  },
  hint: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 16,
  },
  upgradeButton: {
    backgroundColor: COLORS.accent,
    paddingVertical: 12,
    paddingHorizontal: 32,
    borderRadius: 24,
  },
  upgradeText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
