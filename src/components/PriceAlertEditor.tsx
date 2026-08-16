/**
 * Desired-purchase-price interval editor for ONE exact printing (DIC-1023).
 *
 * Shared by the deck editor's missing-card rows and the alert list so both
 * surfaces validate, persist and sync identically.
 */
import React, { useEffect, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../constants';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { syncAlertUpsert, syncAlertRemove, pushAlertAvailable } from '../services/priceAlertSync';
import {
  validateInterval, evaluateAlertStatus, formatAlertAmount, formatInterval,
  priceAlertKey, ALERT_STATUS_LABELS,
} from '../utils/priceAlerts';

export interface PriceAlertTarget {
  cardNumber: string;
  printing: string;
  printingLabel: string;
  name: string;
  currency: string;
  /** exact-version reference SELL price, or null when this printing is unpriced */
  currentPrice: number | null;
}

interface Props {
  target: PriceAlertTarget | null;
  onClose: () => void;
}

export default function PriceAlertEditor({ target, onClose }: Props) {
  const alerts = usePriceAlertStore((s) => s.alerts);
  const upsertAlert = usePriceAlertStore((s) => s.upsertAlert);
  const removeAlert = usePriceAlertStore((s) => s.removeAlert);

  const existing = target
    ? alerts[priceAlertKey(target.cardNumber, target.printing)] ?? null
    : null;

  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [error, setError] = useState<string | null>(null);

  // Re-seed the fields each time a row opens the editor.
  useEffect(() => {
    if (!target) return;
    setLower(existing?.lowerPrice != null ? String(existing.lowerPrice) : '');
    setUpper(existing?.upperPrice != null ? String(existing.upperPrice) : '');
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.cardNumber, target?.printing]);

  if (!target) return null;

  const priceLabel = target.currentPrice === null
    ? '無精確版本價格'
    : formatAlertAmount(target.currentPrice, target.currency);

  const status = existing
    ? evaluateAlertStatus(
        existing,
        target.currentPrice === null ? null : { price: target.currentPrice, currency: target.currency },
      )
    : null;

  function save() {
    if (!target) return;
    const interval = validateInterval(lower, upper);
    if (!interval.ok) {
      setError(interval.message);
      return;
    }
    const saved = upsertAlert({
      cardNumber: target.cardNumber,
      printing: target.printing,
      printingLabel: target.printingLabel,
      name: target.name,
      currency: target.currency,
      lowerPrice: interval.lowerPrice,
      upperPrice: interval.upperPrice,
    });
    // Server mirror is best-effort: the alert is already saved locally, and an
    // offline device must not lose the edit.
    if (saved) void syncAlertUpsert(saved);
    onClose();
  }

  function remove() {
    if (!target) return;
    removeAlert(target.cardNumber, target.printing);
    void syncAlertRemove(target.cardNumber, target.printing);
    onClose();
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal testID="price-alert-editor">
          <Text style={styles.title}>期望入手價格區間</Text>
          <Text style={styles.cardName}>{target.name}</Text>
          <Text style={styles.meta}>
            {target.cardNumber} · {target.printingLabel || target.printing}
          </Text>
          <Text style={styles.meta} testID="price-alert-current-price">
            目前參考售價（{target.currency}）：{priceLabel}
          </Text>
          <Text style={styles.hint}>
            僅比對此精確版本的玩家「參考售價」；不採用店家收購價、最高價或跨版本價格。
          </Text>

          <View style={styles.fieldRow}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>下限（可選）</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                inputMode="numeric"
                placeholder="不限"
                placeholderTextColor={COLORS.textSecondary}
                value={lower}
                onChangeText={(t) => { setLower(t); setError(null); }}
                testID="price-alert-lower"
                accessibilityLabel="期望入手價下限"
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>上限（必填）</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                inputMode="numeric"
                placeholder="例如 1200"
                placeholderTextColor={COLORS.textSecondary}
                value={upper}
                onChangeText={(t) => { setUpper(t); setError(null); }}
                onSubmitEditing={save}
                testID="price-alert-upper"
                accessibilityLabel="期望入手價上限"
              />
            </View>
          </View>

          {error && <Text style={styles.error} testID="price-alert-error">{error}</Text>}

          {existing && status && (
            <Text style={styles.status} testID="price-alert-status">
              目前設定 {formatInterval(existing)} · {ALERT_STATUS_LABELS[status]}
            </Text>
          )}

          <Text style={styles.hint} testID="price-alert-push-note">
            {pushAlertAvailable()
              ? '此裝置已取得推播權杖：價格進入區間時會發送推播（同一次進入只通知一次）。'
              : '此裝置沒有推播權杖（Web 或未開啟通知權限），提醒只會在本機顯示狀態，不會有背景推播。'}
          </Text>

          <View style={styles.actions}>
            {existing && (
              <TouchableOpacity
                onPress={remove}
                testID="price-alert-remove"
                accessibilityRole="button"
                accessibilityLabel="移除到價提醒"
              >
                <Text style={styles.destructive}>移除提醒</Text>
              </TouchableOpacity>
            )}
            <View style={styles.actionsRight}>
              <TouchableOpacity
                onPress={onClose}
                testID="price-alert-cancel"
                accessibilityRole="button"
                accessibilityLabel="取消"
              >
                <Text style={styles.link}>取消</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={save}
                testID="price-alert-save"
                accessibilityRole="button"
                accessibilityLabel="儲存到價提醒"
              >
                <Text style={styles.primaryBtnText}>儲存</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  card: { width: '100%', maxWidth: 440, backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  title: { fontSize: 17, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  cardName: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  meta: { color: COLORS.textSecondary, fontSize: 12, marginTop: 3 },
  hint: { color: COLORS.textSecondary, fontSize: 11, marginTop: 8, lineHeight: 16 },
  fieldRow: { flexDirection: 'row', gap: 10, marginTop: 12 },
  field: { flex: 1 },
  fieldLabel: { color: COLORS.textSecondary, fontSize: 12, marginBottom: 4 },
  input: { backgroundColor: COLORS.surfaceLight, color: COLORS.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: COLORS.border },
  error: { color: COLORS.error, fontSize: 12, marginTop: 8 },
  status: { color: COLORS.primaryLight, fontSize: 12, marginTop: 8 },
  actions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 16, gap: 12 },
  actionsRight: { flexDirection: 'row', alignItems: 'center', gap: 16, marginLeft: 'auto' },
  destructive: { color: COLORS.error, fontSize: 14 },
  link: { color: COLORS.primary, fontSize: 14 },
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  primaryBtnText: { color: '#fff', fontWeight: 'bold' },
});
