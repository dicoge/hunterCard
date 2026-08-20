/**
 * The one 到價提醒 editor (DIC-1087).
 *
 * Every surface that creates or changes an alert goes through here — the deck
 * editor's missing-card rows, the alert list, the card page and the rows
 * migrated from the old card-number tracking list — so all of them validate,
 * persist and sync identically.
 *
 * A target may arrive without a printing (a card page, or a migrated row). The
 * editor then makes the user pick one from the card number's real listings; it
 * never defaults to a printing, because a price alert on a printing the player
 * did not choose is an alert about a different physical card.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Modal, View, Text, TextInput, TouchableOpacity, ScrollView, StyleSheet } from 'react-native';
import { COLORS } from '../constants';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { syncAlertUpsert, syncAlertRemove, pushAlertAvailable } from '../services/priceAlertSync';
import {
  validateInterval, evaluateAlertStatus, formatAlertAmount, formatInterval,
  priceAlertKey,
} from '../utils/priceAlerts';
import { useTranslation } from '../i18n';
import type { PrintingOption } from '../utils/alertMigration';

export interface PriceAlertTarget {
  cardNumber: string;
  /** null when the user must still choose which printing this alert is for */
  printing: string | null;
  printingLabel: string;
  name: string;
  currency: string;
  /** exact-version reference SELL price, or null when this printing is unpriced */
  currentPrice: number | null;
  imageUrl?: string;
  /** the card number's real printings; required when `printing` is null */
  choices?: readonly PrintingOption[];
  /** suggested upper bound for a row migrated from the old tracking list */
  suggestedUpper?: number | null;
}

interface Props {
  target: PriceAlertTarget | null;
  onClose: () => void;
}

export default function PriceAlertEditor({ target, onClose }: Props) {
  const { t } = useTranslation();
  const alerts = usePriceAlertStore((s) => s.alerts);
  const upsertAlert = usePriceAlertStore((s) => s.upsertAlert);
  const removeAlert = usePriceAlertStore((s) => s.removeAlert);

  const [chosen, setChosen] = useState<string | null>(null);
  const [lower, setLower] = useState('');
  const [upper, setUpper] = useState('');
  const [error, setError] = useState<string | null>(null);

  const printing = target?.printing ?? chosen;
  const choices = useMemo(() => target?.choices ?? [], [target]);
  const selectedChoice = choices.find((c) => c.printing === printing) ?? null;

  const existing = target && printing
    ? alerts[priceAlertKey(target.cardNumber, printing)] ?? null
    : null;

  // Re-seed each time a row opens the editor, and again when the user picks a
  // different printing — the interval belongs to the printing, not to the modal.
  useEffect(() => {
    if (!target) return;
    setChosen(null);
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.cardNumber, target?.printing]);

  useEffect(() => {
    if (!target) return;
    const current = printing ? alerts[priceAlertKey(target.cardNumber, printing)] ?? null : null;
    setLower(current?.lowerPrice != null ? String(current.lowerPrice) : '');
    setUpper(
      current?.upperPrice != null ? String(current.upperPrice)
        : target.suggestedUpper != null ? String(target.suggestedUpper)
          : '',
    );
    setError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target?.cardNumber, printing]);

  if (!target) return null;

  const needsChoice = target.printing === null;
  const printingLabel = selectedChoice?.printingLabel || target.printingLabel || printing || '';
  const currency = selectedChoice ? selectedChoice.currency || target.currency : target.currency;
  const currentPrice = selectedChoice ? selectedChoice.sellPrice : target.currentPrice;
  // Once a choice exists, its exact-listing provenance is authoritative. An
  // absent exact image must stay absent rather than falling back to a generic
  // card image that may depict another printing.
  const imageUrl = selectedChoice ? selectedChoice.imageUrl : target.imageUrl;

  const priceLabel = currentPrice === null || currentPrice === undefined
    ? t('price_alert_no_exact_price')
    : formatAlertAmount(currentPrice, currency);

  const status = existing
    ? evaluateAlertStatus(
        existing,
        currentPrice === null || currentPrice === undefined ? null : { price: currentPrice, currency },
      )
    : null;

  function save() {
    if (!target) return;
    if (!printing) {
      setError(t('price_alert_choose_printing_error'));
      return;
    }
    const interval = validateInterval(lower, upper);
    if (!interval.ok) {
      setError(t(`price_alert_error_${interval.code.toLowerCase()}` as Parameters<typeof t>[0]));
      return;
    }
    const saved = upsertAlert({
      cardNumber: target.cardNumber,
      printing,
      printingLabel,
      name: target.name,
      currency,
      lowerPrice: interval.lowerPrice,
      upperPrice: interval.upperPrice,
      imageUrl,
    });
    if (!saved) {
      setError(t('price_alert_unrecognized_printing_error'));
      return;
    }
    // Server mirror is best-effort: the alert is already saved locally, and an
    // offline device must not lose the edit.
    void syncAlertUpsert(saved);
    onClose();
  }

  function remove() {
    if (!target || !printing) return;
    removeAlert(target.cardNumber, printing);
    void syncAlertRemove(target.cardNumber, printing);
    onClose();
  }

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <View style={styles.card} accessibilityViewIsModal testID="price-alert-editor">
          <Text style={styles.title}>{t('price_alert_title')}</Text>
          <Text style={styles.cardName}>{target.name}</Text>
          <Text style={styles.meta}>
            {printing ? `${target.cardNumber} · ${printingLabel}` : target.cardNumber}
          </Text>

          {needsChoice && (
            <View style={styles.choices} testID="price-alert-printing-choices">
              <Text style={styles.fieldLabel}>{t('price_alert_choose_printing')}</Text>
              {choices.length === 0 ? (
                <Text style={styles.hint} testID="price-alert-no-printings">
                  {t('price_alert_no_printings')}
                </Text>
              ) : (
                <ScrollView style={styles.choiceScroll}>
                  {choices.map((choice) => {
                    const active = choice.printing === printing;
                    return (
                      <TouchableOpacity
                        key={choice.printing}
                        style={[styles.choice, active && styles.choiceActive]}
                        onPress={() => { setChosen(choice.printing); setError(null); }}
                        accessibilityRole="button"
                        accessibilityState={{ selected: active }}
                        accessibilityLabel={t('price_alert_choose_printing_a11y', {
                          printing: choice.printingLabel || choice.printing,
                        })}
                        testID={`price-alert-printing-${choice.printing}`}
                      >
                        <Text style={[styles.choiceLabel, active && styles.choiceLabelActive]} numberOfLines={1}>
                          {choice.printingLabel || choice.printing}
                        </Text>
                        <Text style={styles.choicePrice}>
                          {choice.sellPrice === null
                            ? t('price_alert_no_reference_price')
                            : formatAlertAmount(choice.sellPrice, choice.currency)}
                        </Text>
                      </TouchableOpacity>
                    );
                  })}
                </ScrollView>
              )}
            </View>
          )}

          <Text style={styles.meta} testID="price-alert-current-price">
            {t('price_alert_current', { currency, price: priceLabel })}
          </Text>
          <Text style={styles.hint}>
            {t('price_alert_hint')}
          </Text>

          <View style={styles.fieldRow}>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('price_alert_lower')}</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                inputMode="numeric"
                placeholder={t('price_alert_no_limit')}
                placeholderTextColor={COLORS.textSecondary}
                value={lower}
                onChangeText={(t) => { setLower(t); setError(null); }}
                testID="price-alert-lower"
                accessibilityLabel={t('price_alert_lower_a11y')}
              />
            </View>
            <View style={styles.field}>
              <Text style={styles.fieldLabel}>{t('price_alert_upper')}</Text>
              <TextInput
                style={styles.input}
                keyboardType="number-pad"
                inputMode="numeric"
                placeholder={t('price_alert_example')}
                placeholderTextColor={COLORS.textSecondary}
                value={upper}
                onChangeText={(t) => { setUpper(t); setError(null); }}
                onSubmitEditing={save}
                testID="price-alert-upper"
                accessibilityLabel={t('price_alert_upper_a11y')}
              />
            </View>
          </View>

          {error && <Text style={styles.error} testID="price-alert-error">{error}</Text>}

          {existing && status && (
            <Text style={styles.status} testID="price-alert-status">
              {t('price_alert_current_setting', {
                interval: formatInterval(existing),
                status: t(`watchlist_status_${status.toLowerCase()}` as Parameters<typeof t>[0]),
              })}
            </Text>
          )}

          <Text style={styles.hint} testID="price-alert-push-note">
            {pushAlertAvailable()
              ? t('price_alert_push_available')
              : t('price_alert_push_unavailable')}
          </Text>

          <View style={styles.actions}>
            {existing && (
              <TouchableOpacity
                onPress={remove}
                testID="price-alert-remove"
                accessibilityRole="button"
                accessibilityLabel={t('watchlist_remove_alert')}
              >
                <Text style={styles.destructive}>{t('price_alert_remove')}</Text>
              </TouchableOpacity>
            )}
            <View style={styles.actionsRight}>
              <TouchableOpacity
                onPress={onClose}
                testID="price-alert-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('common_cancel')}
              >
                <Text style={styles.link}>{t('common_cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.primaryBtn}
                onPress={save}
                testID="price-alert-save"
                accessibilityRole="button"
                accessibilityLabel={t('price_alert_save_a11y')}
              >
                <Text style={styles.primaryBtnText}>{t('common_save')}</Text>
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
  choices: { marginTop: 12 },
  choiceScroll: { maxHeight: 168 },
  choice: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10,
    backgroundColor: COLORS.surfaceLight, borderRadius: 8, paddingHorizontal: 12,
    minHeight: 44, borderWidth: 1, borderColor: COLORS.border, marginBottom: 6,
  },
  choiceActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '22' },
  choiceLabel: { color: COLORS.text, fontSize: 13, flexShrink: 1 },
  choiceLabelActive: { color: COLORS.primary, fontWeight: '700' },
  choicePrice: { color: COLORS.textSecondary, fontSize: 12 },
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
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10, minHeight: 44, justifyContent: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: 'bold' },
});
