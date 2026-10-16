/**
 * Scan result sheet (scan best-match fix 2026-10-15). Pen
 * `docs/pen-scan/holohunter-scan-best-match.pen`: B 最佳結果預覽 (n3W78w),
 * C 已辨識卡片・版本未定 (nHtew), D 找不到相符卡牌 (BrI2U).
 *
 * Pure presentation: every action is a callback, and the only one that adds a card
 * (and uses a scan) is `onAdd`. It disables itself after the first tap so a double tap
 * cannot add or charge twice. No percentage is ever shown — the ranker's score is not
 * a calibrated probability; the sheet shows the evidence that was read instead.
 */
import React, { useEffect, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { convertPrice } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useTranslation } from '../i18n';
import { resolveCardDisplayName } from '../utils/cardDisplayName';
import type { ScanPresentation } from '../services/scanPresentation';
import { LOCAL_OCR_EVIDENCE } from '../services/scanPresentation';
import type { CardInfo } from '../services/cardRecognition';

export interface ScanMatchSheetProps {
  presentation: ScanPresentation | null;
  onAdd: (card: CardInfo) => void;
  onCorrect: () => void;
  onPickPrinting: () => void;
  onManualSearch: () => void;
  onRetake: () => void;
  preferredCurrency?: string;
  preferredLanguage?: string;
}

export default function ScanMatchSheet({
  presentation,
  onAdd,
  onCorrect,
  onPickPrinting,
  onManualSearch,
  onRetake,
  preferredCurrency = 'TWD',
  preferredLanguage = 'zh',
}: ScanMatchSheetProps) {
  const { t } = useTranslation();
  const [added, setAdded] = useState(false);
  useEffect(() => { setAdded(false); }, [presentation]);
  if (!presentation) return null;

  const formatPrice = (price: number | null | undefined): string => {
    if (price == null) return t('scan_no_trade');
    if (preferredCurrency === 'JPY') return `¥${price.toLocaleString()}`;
    const { value, symbol } = convertPrice(price, preferredCurrency);
    return value == null ? t('scan_no_trade') : `${symbol}${value.toLocaleString()}`;
  };

  const evidenceText = (card: CardInfo, evidence: string[]): string => evidence
    .map((e) => {
      if (e === LOCAL_OCR_EVIDENCE) return t('scan_evidence_local');
      if (e.startsWith('cardNumber')) return t('scan_evidence_number', { number: card.cardNumber });
      if (e === 'rarity') return t('scan_evidence_rarity', { rarity: card.rarity });
      if (e.startsWith('character') || e.startsWith('title')) return t('scan_evidence_name');
      return null;
    })
    .filter((x, i, a): x is string => !!x && a.indexOf(x) === i)
    .join(' · ');

  if (presentation.kind === 'best') {
    const { card, evidence, alternatives } = presentation;
    const { primary: name } = resolveCardDisplayName(card, preferredLanguage);
    const why = evidenceText(card, evidence);
    return (
      <View style={styles.sheet} testID="scan-match-best">
        <Text style={styles.name} numberOfLines={1}>{name}</Text>
        <Text style={styles.meta}>{[card.cardNumber, card.rarity, card.series].filter(Boolean).join(' · ')}</Text>
        {FEATURES.sellPrice ? <Text style={styles.price}>{formatPrice(card.sellPrice)}</Text> : null}
        {why ? (
          <View style={styles.evidence} testID="scan-match-evidence">
            <Text style={styles.evidenceText}>{t('scan_match_evidence', { evidence: why })}</Text>
          </View>
        ) : null}
        <TouchableOpacity
          style={[styles.primary, added && styles.disabled]}
          disabled={added}
          onPress={() => { if (added) return; setAdded(true); onAdd(card); }}
          accessibilityRole="button"
          testID="scan-match-add"
        >
          <Text style={styles.primaryText}>{t('scan_match_add')}</Text>
        </TouchableOpacity>
        <View style={styles.secondaryRow}>
          <TouchableOpacity onPress={alternatives.length ? onCorrect : onManualSearch} disabled={added} testID="scan-match-correct">
            <Text style={styles.link}>{t('scan_match_correct')}</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={onRetake} disabled={added} testID="scan-match-retake">
            <Text style={styles.muted}>{t('scan_match_retake')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  if (presentation.kind === 'identity') {
    const { card } = presentation;
    const { primary: name } = resolveCardDisplayName(card, preferredLanguage);
    return (
      <View style={styles.sheet} testID="scan-match-identity">
        <Text style={styles.title}>{t('scan_identity_title', { name, number: card.cardNumber })}</Text>
        <Text style={styles.body} testID={presentation.numberCorrected ? 'scan-match-number-corrected' : undefined}>
          {t(presentation.numberCorrected ? 'scan_identity_body_corrected' : 'scan_identity_body')}
        </Text>
        <View style={styles.pill}><Text style={styles.pillText}>{t('scan_identity_price')}</Text></View>
        <TouchableOpacity style={styles.primary} onPress={onPickPrinting} testID="scan-match-pick">
          <Text style={styles.primaryText}>{t('scan_identity_pick')}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.secondary} onPress={onManualSearch} testID="scan-match-manual">
          <Text style={styles.secondaryText}>{t('scan_match_manual')}</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const bodyKey = presentation.reason === 'number_not_in_database' ? 'scan_none_body_not_in_db'
    : presentation.reason === 'number_name_conflict' ? 'scan_none_body_conflict'
      : presentation.reason === 'low_evidence' ? 'scan_none_body_low'
        : 'scan_none_body_no_number';
  return (
    <View style={styles.sheet} testID="scan-match-none">
      <Text style={styles.title}>{t('scan_none_title')}</Text>
      <Text style={styles.body}>{t(bodyKey)}</Text>
      <TouchableOpacity style={styles.primary} onPress={onRetake} testID="scan-match-retake">
        <Text style={styles.primaryText}>{t('scan_match_retake')}</Text>
      </TouchableOpacity>
      <TouchableOpacity style={styles.secondary} onPress={onManualSearch} testID="scan-match-manual">
        <Text style={styles.secondaryText}>{t('scan_match_manual')}</Text>
      </TouchableOpacity>
      {presentation.suggestions.length ? (
        <TouchableOpacity onPress={onCorrect} testID="scan-match-suggestions">
          <Text style={styles.link}>{t('scan_none_suggestions', { count: presentation.suggestions.length })}</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    backgroundColor: '#14111C', borderTopLeftRadius: 24, borderTopRightRadius: 24,
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 28, gap: 12,
  },
  name: { color: '#FFFFFF', fontSize: 18, fontWeight: '700' },
  meta: { color: '#A79FBA', fontSize: 13 },
  price: { color: '#F4C26B', fontSize: 15, fontWeight: '700' },
  evidence: { alignSelf: 'flex-start', backgroundColor: '#1F2A22', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  evidenceText: { color: '#B9E8C8', fontSize: 12 },
  title: { color: '#FFFFFF', fontSize: 17, fontWeight: '700' },
  body: { color: '#A79FBA', fontSize: 13, lineHeight: 19 },
  pill: { alignSelf: 'flex-start', backgroundColor: '#2A2438', borderRadius: 8, paddingHorizontal: 10, paddingVertical: 6 },
  pillText: { color: '#D8D2E6', fontSize: 12 },
  primary: { height: 48, borderRadius: 12, backgroundColor: '#E5487F', alignItems: 'center', justifyContent: 'center' },
  primaryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  disabled: { opacity: 0.5 },
  secondary: { height: 48, borderRadius: 12, backgroundColor: '#2A2438', alignItems: 'center', justifyContent: 'center' },
  secondaryText: { color: '#D8D2E6', fontSize: 15, fontWeight: '700' },
  secondaryRow: { flexDirection: 'row', justifyContent: 'space-between' },
  link: { color: '#C9B8FF', fontSize: 14, paddingVertical: 4 },
  muted: { color: '#8E879E', fontSize: 14, paddingVertical: 4 },
});
