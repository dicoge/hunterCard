import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Dimensions, TouchableOpacity, Image } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, convertPrice } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { openUrl } from '../utils/openUrl';
import { useSettingsStore } from '../store/settingsStore';
import { useDeckStore } from '../store/deckStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { buildSourcePrintings } from '../utils/printingIdentity';
import { PRICE_CURRENCY } from '../utils/deckCardData';
import { formatInterval } from '../utils/priceAlerts';
import type { PrintingOption } from '../utils/alertMigration';
import PriceTrendBadge from '../components/PriceTrendBadge';
import { useTrendStore, TrendPrediction } from '../store/trendStore';
import { hasDisplayableSubscriberStats, isValidatedTrendPrediction, bloomLevelBadgeColor, categoryBadgeColor } from '../utils/cardNormalization';
import { computeValidatedPriceTrend } from '../utils/priceTrend';
import { PriceTrend } from '../components/PriceTrend';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
import { useTranslation } from '../i18n';
import { ownershipKey } from '../utils/deckRules';

const { width } = Dimensions.get('window');

const gradeLabels: Record<string, string> = { debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot' };
const rarityColors: Record<string, string> = { N: '#6b7280', C: '#6b7280', U: '#10b981', R: '#3b82f6', SR: '#f59e0b' };
const japaneseKanaRegex = /[\u3040-\u309F\u30A0-\u30FF]/;

function containsJapaneseKana(value: unknown): boolean {
  if (typeof value === 'string') return japaneseKanaRegex.test(value);
  if (Array.isArray(value)) return value.some(containsJapaneseKana);
  if (value && typeof value === 'object') return Object.values(value).some(containsJapaneseKana);
  return false;
}

function parseEffects(keywords: string[]): string[] {
  if (!keywords) return [];
  // Keywords: [0]=JP name, [1]=TW name, [2]=EN name, [3+]=effects
  return keywords.slice(3).filter((kw) => {
    const t = kw.trim();
    if (t.length < 5) return false;
    // Filter out keywords that are just names/tags
    const gameTerms = ['給予', '抽', '傷害', '牌組', '手札', '成員', '中央', '藝能', 'HP', '生命',
      '階段', '回合', '特殊', '公開', '聯動', '擊倒', '剩餘', '持有', '超過', '以下', '以上',
      '最多', '備', '骰子', '奇數', '偶數', '回復', '存檔', '聲援', '舞台', '成本', '效果',
      '能力', '選擇', '丟棄', '放置', '移動', '觸發', '永續'];
    // Also check if it's a real JP effect (contains JP characters + game terms)
    const hasJpChars = /[\u3040-\u309F\u30A0-\u30FF\u4E00-\u9FAF]/.test(t);
    return gameTerms.some(term => t.includes(term)) && hasJpChars;
  });
}

function buildImageUrl(cardNumber: string, seriesCode: string, versions: string[], cardType: string): string {
  let version = '_OSR.png';

  if (versions && versions.length > 0) {
    if (cardType === 'Oshi') {
      version = versions.find((v) => v.includes('_OSR') || v.includes('_OUR')) || versions[0] || '_OSR.png';
    } else if (cardType === 'Support') {
      version = versions.find((v) => v.includes('_S') || v.includes('_P')) || versions.find((v) => v.includes('.png')) || versions[0] || '_U.png';
    } else {
      // Member card: prefer _U (unique), _R, then _C (common)
      version = versions.find((v) => v.startsWith('_U.') || v.startsWith('_R.') || v.startsWith('_C.'))
        || versions.find((v) => v.includes('.png') || v.includes('.jpg'))
        || versions[0] || '_U.png';
      // Remove any leading underscore version prefix duplicates
      if (version.includes('_U._U') || version.includes('_R._R')) {
        version = version.replace(/_(U|R)\._(U|R)\./, '_$1.');
      }
    }
  }

  return `https://hololive-official-cardgame.com/wp-content/images/cardlist/${seriesCode}/${cardNumber}${version}`;
}

export default function CardDetailScreen({ route, navigation }: any) {
  const { card } = route.params || {};
  const [imageError, setImageError] = useState(false);
  const insets = useSafeAreaInsets();
  const { preferredCurrency, preferredLanguage } = useSettingsStore();
  const { isDesktop } = useBreakpoint();
  const { t } = useTranslation();
  const collection = useDeckStore((state) => state.collection);
  const adjustOwned = useDeckStore((state) => state.adjustOwned);
  const setOwned = useDeckStore((state) => state.setOwned);

  if (!card) {
    return (
      <View style={styles.center}>
        <Text style={{ color: COLORS.text }}>{t('card_detail_load_failed')}</Text>
      </View>
    );
  }

  const id = card.cardNumber || card.id || '';
  const collectionVersions = buildPriceVersions(card);
  const collectionResolution = resolveVersionForCard(collectionVersions);
  const collectionVersion = card.printing
    ? { printing: card.printing, name: card.printingLabel || card.printing }
    : collectionResolution.confident
      ? collectionVersions[collectionResolution.index]
      : null;
  const ownedQuantity = collectionVersion
    ? collection[ownershipKey(id, collectionVersion.printing)] || 0
    : 0;
  const allKW = card.searchKeywords || [];
  const nameJP = allKW[0] || card.name || '';
  const nameZH = card.nameZh || allKW[1] || '';
  const nameEN = allKW[2] || '';
  const displayName = preferredLanguage === 'zh' && nameZH ? nameZH : nameJP;
  const displayNameSub = preferredLanguage === 'zh' ? '' : nameZH;
  const rarityKey = card.rarity || (card.grade === 'buzz' ? 'SR' : card.grade === 'debut' ? 'C' : card.grade === '1st' ? 'U' : 'R');
  const typeLabels: Record<string, string> = {
    Oshi: t('card_detail_type_oshi'), Member: t('card_detail_type_member'),
    Support: t('card_detail_type_support'), Energy: t('card_detail_type_energy'), Buzz: 'Buzz',
  };
  const typeLabel = card.normalized?.categoryLabel || typeLabels[card.type] || card.type || '-';
  const skillsZhContainsJapanese = containsJapaneseKana(card.skillsZh);
  const displaySkills = preferredLanguage === 'zh'
    ? (skillsZhContainsJapanese ? (card.skillsJp || card.skillsZh) : (card.skillsZh || card.skillsJp))
    : (card.skillsJp || card.skillsZh);
  const skillsFallbackNote = preferredLanguage === 'zh' && skillsZhContainsJapanese && card.skillsJp
    ? t('card_detail_translation_unavailable')
    : undefined;

  const effects = card.effects || parseEffects(allKW);
  const colorNames = card.colorNames && card.colorNames.length > 0
    ? card.colorNames
    : (card.color ? (Array.isArray(card.color) ? card.color : [card.color]).filter(Boolean).map((c: string) => {
        const map: Record<string, string> = Object.fromEntries(
          ['white', 'blue', 'green', 'red', 'purple', 'yellow', 'colorless', 'multicolor']
            .map((color) => [color, t(`color_${color}` as Parameters<typeof t>[0])]),
        );
        return map[c] || c;
      }) : []);
  
  const seriesNames = card.seriesNames || [];
  const tags = card.tags || [];
  const versions = card.versions || [];

  // Use card.images[0] when available, otherwise use API-provided imageUrl, or build from pattern
  const cardSeries = (Array.isArray(card.series) ? card.series[0] : card.series) || (id?.split('-')[0] || '');
  const imageUrl = (card.images && card.images[0]) || card.imageUrl || buildImageUrl(id, cardSeries, versions, card.type || '');
  const officialUrl = `https://hololive-official-cardgame.com/cardlist/?keyword=${encodeURIComponent(id)}&view=image`;
  const yuyuUrl = `https://yuyu-tei.jp/sell/hocg/s/search?search_word=${encodeURIComponent(id)}`;

  // Use actual yuyu-tei price from API response
  const actualPrice = card.yuyuPrice;
  const priceName = card.yuyuPriceName || '';
  const hasActualPrice = actualPrice != null && actualPrice > 0;

  // Handle multiple price variants (signed vs unsigned)
  const priceVariants = card.prices || [];
  const hasMultipleVariants = priceVariants.length > 1;
  const detailVersions = buildPriceVersions(card);
  const detailPriceTrend = detailVersions.length === 1
    ? computeValidatedPriceTrend({
        priceHistory: card.priceHistory,
        meta: card.priceHistoryMeta,
        cardNumber: card.cardNumber,
        printing: detailVersions[0].printing,
        currency: 'JPY',
      })
    : null;

  // ── Trend prediction ──
  const [trend, setTrend] = useState<TrendPrediction | null>(null);
  const { fetchTrendForCard, getTrendForCard } = useTrendStore();

  useEffect(() => {
    // Store MVP: never fetch or read trend/prediction data — gate the execution
    // path, not only the render, so no forbidden network call fires (CR DIC-913 #3).
    if (!FEATURES.trendPrediction) return;
    const cardId = card.id || card.cardNumber || '';
    if (cardId) {
      // Check cache first
      const cached = getTrendForCard(cardId);
      if (cached) {
        setTrend(cached);
      } else {
        fetchTrendForCard(cardId).then(t => setTrend(t));
      }
    }
  }, [card.id, card.cardNumber]);

  // ── 到價提醒 ──
  // The card page knows a card NUMBER, and an alert is about one exact printing,
  // so the button opens the editor with this number's real listings and lets the
  // player choose. Which printing is never decided here.
  const alerts = usePriceAlertStore((s) => s.alerts);
  const [alertTarget, setAlertTarget] = useState<PriceAlertTarget | null>(null);

  const printingChoices: PrintingOption[] = useMemo(
    () => buildSourcePrintings(priceVariants).map((p) => ({
      printing: p.printing,
      printingLabel: p.label,
      sellPrice: p.sellPrice,
      currency: PRICE_CURRENCY,
      imageUrl: p.imageUrl,
    })),
    [priceVariants],
  );

  const cardAlerts = useMemo(
    () => Object.values(alerts).filter((a) => a.cardNumber === id),
    [alerts, id],
  );

  const openAlertEditor = () => {
    if (!id) return;
    // One existing alert on this card number edits in place; anything else makes
    // the player name the printing.
    const only = cardAlerts.length === 1 ? cardAlerts[0] : null;
    setAlertTarget({
      cardNumber: id,
      printing: only ? only.printing : null,
      printingLabel: only?.printingLabel ?? '',
      name: nameZH || nameJP || displayName,
      currency: only?.currency || PRICE_CURRENCY,
      currentPrice: printingChoices.find((c) => c.printing === only?.printing)?.sellPrice ?? null,
      imageUrl: only
        ? printingChoices.find((choice) => choice.printing === only.printing)?.imageUrl
        : undefined,
      choices: printingChoices,
    });
  };

  const alertButtonLabel = cardAlerts.length === 1
    ? t('card_detail_alert_one', { interval: formatInterval(cardAlerts[0]) })
    : cardAlerts.length > 1
      ? t('card_detail_alert_many', { count: cardAlerts.length })
      : t('card_detail_alert_set');

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background, paddingBottom: insets.bottom }}>
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      <ScrollView style={styles.container} contentContainerStyle={isDesktop ? styles.scrollDesktop : undefined}>
      <View style={isDesktop ? styles.twoCol : styles.oneCol}>
      <View style={isDesktop ? styles.leftCol : undefined}>
      {/* ====== CARD IMAGE ====== */}
      <View style={[styles.imageArea, { backgroundColor: rarityColors[rarityKey] + '0a' }]}>
        {!imageError ? (
          <View style={styles.imgContainer}>
            {/* Image: official source is 400×559, cap at 400px wide for sharpness on desktop */}
            {/* @ts-ignore */}
            <Image
              source={{ uri: imageUrl }}
              style={{ width: Math.min(width * 0.7, 400), height: Math.min(width * 0.85, 559), borderRadius: 12, margin: 12 }}
              resizeMode="contain"
              onError={() => setImageError(true)}
            />
          </View>
        ) : (
          /* Fallback when image fails */
          <TouchableOpacity style={styles.fallbackArea} activeOpacity={0.8} onPress={() => openUrl(officialUrl)}>
            <Text style={styles.fallbackId}>{id}</Text>
            <Text style={styles.fallbackName}>{displayName}</Text>
            {displayNameSub && <Text style={styles.fallbackTw}>{displayNameSub}</Text>}
            <Text style={styles.fallbackHint}>{t('card_detail_official_image')}</Text>
          </TouchableOpacity>
        )}
      </View>
      </View>
      <View style={isDesktop ? styles.rightCol : undefined}>

      {collectionVersion && (
        <View style={styles.collectionCard} testID="card-detail-collection">
          <View style={styles.collectionCopy}>
            <Text style={styles.collectionTitle}>{t('deck_collection_title')}</Text>
            <Text style={styles.collectionVersion} numberOfLines={2}>{collectionVersion.name}</Text>
          </View>
          <View style={styles.collectionControls}>
            <TouchableOpacity
              style={styles.collectionButton}
              onPress={() => adjustOwned(id, collectionVersion.printing, -1)}
              disabled={ownedQuantity <= 0}
              accessibilityRole="button"
              accessibilityLabel={t('deck_collection_decrease_a11y', { name: displayName })}
              testID="card-detail-collection-dec"
            >
              <Text style={[styles.collectionButtonText, ownedQuantity <= 0 && styles.collectionButtonDisabled]}>－</Text>
            </TouchableOpacity>
            <Text style={styles.collectionQuantity} testID="card-detail-collection-qty">{ownedQuantity}</Text>
            <TouchableOpacity
              style={styles.collectionButton}
              onPress={() => adjustOwned(id, collectionVersion.printing, 1)}
              accessibilityRole="button"
              accessibilityLabel={t('deck_collection_increase_a11y', { name: displayName })}
              testID="card-detail-collection-inc"
            >
              <Text style={styles.collectionButtonText}>＋</Text>
            </TouchableOpacity>
            {ownedQuantity > 0 && (
              <TouchableOpacity
                onPress={() => setOwned(id, collectionVersion.printing, 0)}
                accessibilityRole="button"
                accessibilityLabel={t('deck_collection_remove_a11y', { name: displayName })}
                testID="card-detail-collection-remove"
              >
                <Text style={styles.collectionRemove}>{t('common_remove')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      {/* ====== TOP ACTION ROW (到價提醒 — reachable without scrolling) ====== */}
      {FEATURES.watchlist && (
        <View style={styles.topActionRow}>
          <TouchableOpacity
            style={[styles.watchlistChip, cardAlerts.length > 0 ? styles.watchlistChipActive : null]}
            onPress={openAlertEditor}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('card_detail_alert_a11y')}
            testID="card-price-alert-chip"
          >
            <Text style={[styles.watchlistChipText, cardAlerts.length > 0 ? styles.watchlistChipTextActive : null]}>
              {alertButtonLabel}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      {/* ====== PRICE SECTION ====== */}
      <View style={[styles.priceSection, { backgroundColor: COLORS.surface }]}>
        <View style={styles.priceHeader}>
          <Text style={styles.priceSourceName}>🏪 遊々亭</Text>
          <Text style={styles.priceBadge}>
            {hasActualPrice ? t('card_detail_actual_price') : t('card_detail_no_data')}
          </Text>
        </View>
        {hasActualPrice && hasMultipleVariants ? (
          <View style={styles.variantList}>
            {[...priceVariants].sort((a, b) => (a.sellPrice || 0) - (b.sellPrice || 0)).filter((p: any) => p.sellPrice != null && p.sellPrice > 0).map((v: any, i: number) => {
              const converted = convertPrice(v.sellPrice, preferredCurrency);
              return (
              <View key={i} style={styles.variantRow}>
                <Text style={styles.variantName} numberOfLines={1}>{v.rarity ? `[${v.rarity}] ` : ''}{v.name}</Text>
                <Text style={styles.variantPrice}>{converted.symbol}{converted.value?.toLocaleString()}</Text>
              </View>
              );
            })}
            <Text style={styles.variantHint}>
              {FEATURES.priceSpread
                ? t('card_detail_variant_hint_spread')
                : t('card_detail_variant_hint')}
            </Text>
          </View>
        ) : hasActualPrice ? (
          <><View style={styles.priceRow}>
          <Text style={styles.priceValue}>¥{actualPrice.toLocaleString()}</Text>
        </View>
        {(() => {
          const converted = convertPrice(actualPrice, preferredCurrency);
          return (
            <Text style={styles.priceNote}>{t('card_detail_approx_price', { price: `${converted.symbol}${converted.value?.toLocaleString()}`, currency: preferredCurrency })}</Text>
          );
        })()}
        {priceName ? (
          <Text style={styles.priceNote}>📋 {priceName}</Text>
        ) : null}</>
        ) : (
          <Text style={styles.noPriceText}>{t('card_detail_no_data')}</Text>
        )}
        {FEATURES.trendPrediction ? <PriceTrend trend={detailPriceTrend} /> : null}
        <TouchableOpacity style={styles.checkPriceBtn} onPress={() => openUrl(yuyuUrl)}>
          <Text style={styles.checkPriceBtnText}>{t('card_detail_live_price')}</Text>
        </TouchableOpacity>
      </View>

      {/* ====== TREND PREDICTION ====== */}
      {/* 趨勢預測基於卡號層級歷史（單一版本序列）。多版本卡無法歸屬到特定版本 → 隱藏，
          避免用別版走勢推薦本版（DIC-856：禁止跨版本推薦訊號）。
          漲跌預測 / trendScore / 信心度 / YT / 新聞情緒 → Store MVP 隱藏（DIC-908）。 */}
      {FEATURES.trendPrediction && !hasMultipleVariants && trend && isValidatedTrendPrediction(trend, card) && (
        <View style={[styles.section, { backgroundColor: COLORS.surface }]}>
          <Text style={styles.sectionTitle}>{t('card_detail_prediction_title')}</Text>
          <PriceTrendBadge
            trend={trend.trend}
            score={trend.score}
            confidence={trend.confidence}
            compact={false}
          />
          {/* 各項因子貢獻 */}
          <View style={styles.componentSection}>
            <Text style={styles.componentTitle}>{t('card_detail_factors')}</Text>
            <View style={styles.componentRow}>
              <Text style={styles.componentLabel}>{t('card_detail_factor_price')}</Text>
              <View style={styles.componentBarBg}>
                <View style={[styles.componentBarFill, {
                  width: `${Math.min(Math.abs(trend.components.priceTrend) * 100, 100)}%`,
                  backgroundColor: trend.components.priceTrend >= 0 ? '#10b981' : '#ef4444',
                }]} />
              </View>
              <Text style={[styles.componentValue, {
                color: trend.components.priceTrend >= 0 ? '#10b981' : '#ef4444',
              }]}>
                {(trend.components.priceTrend * 100).toFixed(0)}%
              </Text>
            </View>
            <View style={styles.componentRow}>
              <Text style={styles.componentLabel}>{t('card_detail_factor_youtube')}</Text>
              <View style={styles.componentBarBg}>
                <View style={[styles.componentBarFill, {
                  width: `${Math.min(Math.abs(trend.components.ytTrend) * 200, 100)}%`,
                  backgroundColor: trend.components.ytTrend >= 0 ? '#10b981' : '#ef4444',
                }]} />
              </View>
              <Text style={[styles.componentValue, {
                color: trend.components.ytTrend >= 0 ? '#10b981' : '#ef4444',
              }]}>
                {(trend.components.ytTrend * 100).toFixed(0)}%
              </Text>
            </View>
            <View style={styles.componentRow}>
              <Text style={styles.componentLabel}>{t('card_detail_factor_news')}</Text>
              <View style={styles.componentBarBg}>
                <View style={[styles.componentBarFill, {
                  width: `${Math.min(Math.abs(trend.components.newsSentiment) * 100, 100)}%`,
                  backgroundColor: trend.components.newsSentiment >= 0 ? '#10b981' : '#ef4444',
                }]} />
              </View>
              <Text style={[styles.componentValue, {
                color: trend.components.newsSentiment >= 0 ? '#10b981' : '#ef4444',
              }]}>
                {(trend.components.newsSentiment * 100).toFixed(0)}%
              </Text>
            </View>
            <Text style={styles.dataPointsNote}>
              {t('card_detail_data_days', { count: trend.dataPoints })}
            </Text>
          </View>
        </View>
      )}

      {/* ====== CARD BASIC INFO ====== */}
      <View style={styles.section}>
        <View style={styles.headerRow}>
          <Text style={styles.cardNumber}>{id}</Text>
          <DetailIdentityBadges normalized={card.normalized} rarity={rarityKey} t={t} />
        </View>

        <Text style={styles.nameJP}>{displayName}</Text>
        {displayNameSub ? <Text style={styles.nameTW}>{displayNameSub}</Text> : null}
        {nameEN && nameEN !== nameJP && nameEN !== nameZH && <Text style={styles.nameEN}>{nameEN}</Text>}

        {typeLabel && (
          <InfoRow label={t('card_detail_type_label')} value={typeLabel} />
        )}
        {/* DIC-1141: category and Bloom Level live on distinct rows — never
            collapse them into one field, and never impersonate Bloom Level
            with the category label. */}
        {card.normalized?.category === 'holomen' && (
          <InfoRow
            label={t('card_detail_bloom_level_label')}
            value={card.normalized?.stageLabel || t('search_bloom_level_pending')}
          />
        )}
        {colorNames.length > 0 && (
          <InfoRow label={t('card_detail_color_label')} value={colorNames.join(' / ')} />
        )}
        {seriesNames.length > 0 && (
          <InfoRow label={t('card_detail_series_label')} value={seriesNames.join(' / ')} />
        )}
        {tags.length > 0 && (
          <InfoRow label="Tag" value={tags.join(' / ')} />
        )}
      </View>

      {/* ====== SKILLS / EFFECTS ====== */}
      <SkillsPanel skills={displaySkills} fallbackNote={skillsFallbackNote} />

      {/* ====== MARKET DATA ====== */}
      <MarketDataPanel card={card} />

      {/* ====== EFFECT TEXTS ====== */}
      {(effects.length > 0 || card.type === 'Oshi') && (
        <View style={styles.section}>
          <Text style={styles.sectionTitle}>{t('card_detail_effects')}</Text>
          {effects.length > 0 ? (
            effects.map((kw: string, i: number) => (
              <View key={i} style={styles.effectBlock}>
                <Text style={styles.effectText}>{kw}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.noEffectText}>{t('card_detail_oshi_no_effect')}</Text>
          )}
        </View>
      )}

      {/* ====== SEARCH KEYWORDS ====== */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('card_detail_keywords')}</Text>
        <View style={styles.tagWrap}>
          {nameJP && <Tag text={nameJP} />}
          {nameZH && <Tag text={nameZH} />}
          {tags.map((t: string, i: number) => <Tag key={`t${i}`} text={t} />)}
        </View>
      </View>

      {/* ====== EXTERNAL LINKS ====== */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>{t('card_detail_external_links')}</Text>
        <LinkButton icon="🏛️" text={t('card_detail_official_list')} url={officialUrl} />
        <LinkButton icon="🏪" text={t('card_detail_yuyu_link')} url={yuyuUrl} />
        <LinkButton icon="🔄" text={t('card_detail_carousell_link')} url={`https://www.carousell.com.tw/search/?q=${encodeURIComponent(id)}`} />
      </View>

      {/* ====== 到價提醒 BUTTON ====== */}
      {FEATURES.watchlist && (
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.watchlistBtn, cardAlerts.length > 0 ? styles.watchlistBtnActive : null]}
            onPress={openAlertEditor}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel={t('card_detail_alert_a11y')}
            testID="card-price-alert-button"
          >
            <Text style={[styles.watchlistBtnText, cardAlerts.length > 0 ? styles.watchlistBtnTextActive : null]}>
              {alertButtonLabel}
            </Text>
          </TouchableOpacity>
        </View>
      )}

      <View style={{ height: 20 }} />
      </View>
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

// ─── Helper Components ────────────────────────────────

// ─── Skills panel ─────────────────────────────────────
type Skill = { name?: string; cost?: string; effect?: string };
type Art = { name?: string; cost?: string; damage?: string; effect?: string };
type Keyword = { label?: string; effect?: string };
type Skills = {
  oshiSkill?: Skill;
  spOshiSkill?: Skill;
  arts?: Art[];
  keywords?: Keyword[];
  abilityText?: string;
};

function SkillCard({ badge, badgeColor, meta, name, effect }: {
  badge: string; badgeColor?: string; meta?: string; name?: string; effect?: string;
}) {
  return (
    <View style={styles.skillCard}>
      <View style={styles.skillHeader}>
        <Text style={[styles.skillBadge, badgeColor ? { color: badgeColor, borderColor: badgeColor + '66' } : null]}>{badge}</Text>
        {meta ? <Text style={styles.skillMeta}>{meta}</Text> : null}
      </View>
      {name ? <Text style={styles.skillName}>{name}</Text> : null}
      {effect ? <Text style={styles.skillEffect}>{effect}</Text> : null}
    </View>
  );
}

function SkillsPanel({ skills, fallbackNote }: { skills?: Skills; fallbackNote?: string }) {
  const { t } = useTranslation();
  const hasAny = skills && (
    skills.oshiSkill || skills.spOshiSkill ||
    (skills.arts && skills.arts.length) ||
    (skills.keywords && skills.keywords.length) ||
    skills.abilityText
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('card_detail_skills_title')}</Text>
      {!hasAny ? (
        <Text style={styles.noSkillText}>{t('card_detail_no_skills')}</Text>
      ) : (
        <>
          {skills!.oshiSkill && (
            <SkillCard
              badge="推しスキル"
              badgeColor="#f59e0b"
              meta={skills!.oshiSkill.cost ? t('card_detail_holo_power', { cost: skills!.oshiSkill.cost }) : undefined}
              name={skills!.oshiSkill.name}
              effect={skills!.oshiSkill.effect}
            />
          )}
          {skills!.spOshiSkill && (
            <SkillCard
              badge="SP推しスキル"
              badgeColor="#ef4444"
              meta={skills!.spOshiSkill.cost ? t('card_detail_holo_power', { cost: skills!.spOshiSkill.cost }) : undefined}
              name={skills!.spOshiSkill.name}
              effect={skills!.spOshiSkill.effect}
            />
          )}
          {skills!.arts?.map((art, i) => (
            <SkillCard
              key={`art${i}`}
              badge={t('card_detail_art')}
              badgeColor="#3b82f6"
              meta={[art.cost ? `${art.cost}` : '', art.damage ? t('card_detail_damage', { value: art.damage }) : ''].filter(Boolean).join('　')}
              name={art.name}
              effect={art.effect}
            />
          ))}
          {skills!.abilityText ? (
            <SkillCard badge={t('card_detail_ability_text')} badgeColor="#10b981" effect={skills!.abilityText} />
          ) : null}
          {skills!.keywords?.map((kw, i) => (
            <SkillCard key={`kw${i}`} badge={kw.label || t('card_detail_keyword')} effect={kw.effect} />
          ))}
          {fallbackNote ? <Text style={styles.skillFallbackNote}>{fallbackNote}</Text> : null}
        </>
      )}
    </View>
  );
}

// ─── Market data panel ────────────────────────────────
function formatCount(n: number | null | undefined, language: 'zh' | 'ja'): string {
  if (n == null || typeof n !== 'number' || isNaN(n)) return '—';
  return new Intl.NumberFormat(language === 'ja' ? 'ja-JP' : 'zh-TW', {
    notation: Math.abs(n) >= 10_000 ? 'compact' : 'standard',
    maximumFractionDigits: 2,
  }).format(n);
}

function MarketDataPanel({ card }: { card: any }) {
  const { t, language } = useTranslation();
  // 同卡號不同掛牌（原印／重印／パラレル／サイン）的價格都在 card.prices 內；卡號層級的
  // sellPrice 是「所有版本最低價」，直接顯示會混版。改成對齊到來源掛牌的單一版本。
  const versions = buildPriceVersions(card);
  const multiVersion = versions.length > 1;
  const resolution = resolveVersionForCard(versions);
  // null = 尚未手動選擇；此時沿用自動對齊結果。使用者一旦點選版本即視為已確認。
  const [override, setOverride] = useState<number | null>(null);
  const selectedIdx = Math.min(Math.max(override ?? resolution.index, 0), versions.length - 1);
  const selectedVersion = versions[selectedIdx] ?? null;
  // 只有「自動唯一對齊」或「使用者手動選過」才算已對齊；否則版本待確認，不把價格當成本卡版本價。
  const aligned = resolution.confident || override != null;
  const manualPick = override != null && !resolution.confident;
  const sellPrice = aligned ? (selectedVersion?.sellPrice ?? null) : null; // 對齊版本後的遊々亭賣價（買入成本）
  const versionLabel = selectedVersion?.name ?? card?.series ?? '';

  const displayRarity = card?.sourceRarity ?? card?.rarity ?? '';
  // 店家收購價（賣出可得）：依「選中版本」對齊（DIC-856）。未對齊或此版本對不到收購價 → null，
  // 絕不退回卡號層級最高價/別版價（fail closed）。
  const buyPrice = aligned ? (selectedVersion?.buyPrice ?? null) : null;
  const ytStats = card?.ytStats ?? null;
  const hasSpread = typeof sellPrice === 'number' && sellPrice > 0 && typeof buyPrice === 'number' && buyPrice > 0;

  const spreadPct = hasSpread ? ((buyPrice - sellPrice) / sellPrice) * 100 : 0;
  const spreadUp = spreadPct >= 0;
  // 防呆：收購價超過選中版本賣價 10 倍幾乎必是版本對不上。與其顯示假暴利差價，寧可標示待確認。
  const isPriceReliable = !hasSpread || buyPrice <= sellPrice * 10;
  // 已對齊、有賣價，但此版本沒有對到收購價 → fail closed 明示「暫無」，不借別版價。
  const buyMissing = aligned && typeof sellPrice === 'number' && sellPrice > 0 && buyPrice == null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{t('card_detail_market_data')}</Text>

      {/* 版本選擇 — 對齊 rarity/パラレル/サイン 版，避免混版價格 */}
      {aligned && versionLabel ? (
        <Text style={styles.versionLabel}>
          {t('card_detail_price_version', { version: versionLabel, manual: manualPick ? t('card_detail_manual_selected') : '' })}
        </Text>
      ) : null}
      {!aligned ? (
        <View style={styles.versionWarnBox}>
          <Text style={styles.versionWarnTitle}>{t('card_detail_version_pending')}</Text>
          <Text style={styles.versionWarnText}>
            {t('card_detail_version_pending_body', { rarity: displayRarity ? `「${displayRarity}」` : '', reason: resolution.reason })}
          </Text>
        </View>
      ) : null}
      {multiVersion ? (
        <View style={styles.versionRow}>
          {versions.map((v, i) => {
            const active = aligned && i === selectedIdx;
            return (
              <TouchableOpacity
                key={`${v.name}-${i}`}
                style={[styles.versionChip, active ? styles.versionChipActive : null]}
                onPress={() => setOverride(i)}
                activeOpacity={0.8}
              >
                <Text style={[styles.versionChipText, active ? styles.versionChipTextActive : null]} numberOfLines={1}>
                  {v.name}　¥{(v.sellPrice ?? 0).toLocaleString()}
                </Text>
              </TouchableOpacity>
            );
          })}
        </View>
      ) : null}

      {/* 買賣差價 / 店家收購價 — Store MVP 隱藏（DIC-908）；正常售價仍於上方價格區顯示。 */}
      {FEATURES.priceSpread && (hasSpread ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>{t('card_detail_spread_title', { version: versionLabel })}</Text>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_buy_cost')}</Text>
            <Text style={styles.marketValue}>¥{sellPrice.toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_sell_value')}</Text>
            <Text style={styles.marketValue}>¥{buyPrice.toLocaleString()}</Text>
          </View>
          {isPriceReliable ? (
            <View style={styles.marketRow}>
              <Text style={styles.marketLabel}>{t('card_detail_spread')}</Text>
              <Text style={[styles.marketValueStrong, { color: spreadUp ? '#10b981' : '#ef4444' }]}>
                {spreadUp ? '+' : ''}{spreadPct.toFixed(1)}%（¥{(buyPrice - sellPrice).toLocaleString()}）
              </Text>
            </View>
          ) : (
            <Text style={[styles.marketValueStrong, { color: '#f59e0b' }]}>
              {t('card_detail_price_pending')}
            </Text>
          )}
          <Text style={styles.marketNote}>{t('card_detail_same_version_note', { version: versionLabel })}</Text>
        </View>
      ) : buyMissing ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>{t('card_detail_spread_title', { version: versionLabel })}</Text>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_buy_cost')}</Text>
            <Text style={styles.marketValue}>¥{sellPrice.toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_sell_value')}</Text>
            <Text style={[styles.marketValue, { color: COLORS.textSecondary }]}>{t('card_detail_buy_unavailable')}</Text>
          </View>
          <Text style={styles.marketNote}>{t('card_detail_buy_unavailable_note')}</Text>
        </View>
      ) : null)}

      {/* YouTube 成員數據 / 訂閱・觀看成長 — Store MVP 隱藏（DIC-908） */}
      {FEATURES.ytStats && hasDisplayableSubscriberStats(ytStats) && (
      <View style={styles.marketBlock}>
        <Text style={styles.marketBlockTitle}>{t('card_detail_youtube_data')}</Text>
        <View style={styles.marketRow}>
          <Text style={styles.marketLabel}>{t('card_detail_subscribers')}</Text>
          <Text style={styles.marketValue}>{formatCount(ytStats?.subscriberCount, language)}</Text>
        </View>
        <View style={styles.marketRow}>
          <Text style={styles.marketLabel}>{t('card_detail_total_views')}</Text>
          <Text style={styles.marketValue}>{formatCount(ytStats?.totalViewCount, language)}</Text>
        </View>
        {ytStats?.growth_1d != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_growth_day')}</Text>
            <Text style={[styles.marketValue, { color: ytStats.growth_1d >= 0 ? '#10b981' : '#ef4444' }]}>
              {ytStats.growth_1d >= 0 ? '+' : ''}{formatCount(ytStats.growth_1d, language)}
            </Text>
          </View>
        ) : null}
        {ytStats?.growth_7d != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_growth_week')}</Text>
            <Text style={[styles.marketValue, { color: ytStats.growth_7d >= 0 ? '#10b981' : '#ef4444' }]}>
              {ytStats.growth_7d >= 0 ? '+' : ''}{formatCount(ytStats.growth_7d, language)}
            </Text>
          </View>
        ) : null}
        {ytStats?.viewCount_daily != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>{t('card_detail_views_day')}</Text>
            <Text style={styles.marketValue}>{formatCount(ytStats.viewCount_daily, language)}</Text>
          </View>
        ) : null}
      </View>
      )}

    </View>
  );
}

function InfoRow({ label, value }: { label: string; value: string }) {
  return (
    <View style={styles.infoRow}>
      <Text style={styles.infoLabel}>{label}：</Text>
      <Text style={styles.infoValue}>{value}</Text>
    </View>
  );
}

// DIC-1141: header badges on the detail page. Bloom Level (Debut/1st/2nd/Buzz/
// Spot) is the primary badge for Holomen — never the category label, never
// colored by printing rarity. A separate "rarity chip" surfaces the printing
// rarity so it stays legible without impersonating a Bloom Level.
function DetailIdentityBadges({
  normalized,
  rarity,
  t,
}: {
  normalized: any;
  rarity: string;
  t: (k: any, p?: any) => string;
}) {
  const rarityChip = rarity ? (
    <View style={[styles.detailRarityChip, { borderColor: rarityColors[rarity] || '#6b7280' }]} testID="detail-rarity-chip">
      <Text style={[styles.detailRarityChipText, { color: rarityColors[rarity] || '#6b7280' }]}>{rarity}</Text>
    </View>
  ) : null;
  if (!normalized) {
    return rarityChip ? <View style={styles.detailBadgeRow}>{rarityChip}</View> : null;
  }
  const isHolomen = normalized.category === 'holomen';
  const stageLabel = normalized.stageLabel;
  const categoryLabel = normalized.categoryLabel;
  const bloomColor = bloomLevelBadgeColor(normalized.stage);
  const catColor = categoryBadgeColor(normalized.category);
  return (
    <View style={styles.detailBadgeRow}>
      {isHolomen ? (
        stageLabel ? (
          <View style={[styles.detailBloomBadge, { backgroundColor: bloomColor || '#6b7280' }]} testID="detail-bloom-badge">
            <Text style={styles.detailBloomBadgeText}>{stageLabel}</Text>
          </View>
        ) : (
          <View style={styles.detailBloomBadgePending} testID="detail-bloom-badge-pending">
            <Text style={styles.detailBloomBadgePendingText}>{t('search_bloom_level_pending')}</Text>
          </View>
        )
      ) : categoryLabel ? (
        <View style={[styles.detailBloomBadge, { backgroundColor: catColor || '#6b7280' }]}>
          <Text style={styles.detailBloomBadgeText}>{categoryLabel}</Text>
        </View>
      ) : null}
      {isHolomen && categoryLabel ? (
        <View style={[styles.detailCategoryChip, { borderColor: catColor || '#6b7280' }]}>
          <Text style={[styles.detailCategoryChipText, { color: catColor || '#6b7280' }]}>{categoryLabel}</Text>
        </View>
      ) : null}
      {rarityChip}
    </View>
  );
}

function Tag({ text }: { text: string }) {
  return (
    <View style={styles.tag}>
      <Text style={styles.tagText}>{text}</Text>
    </View>
  );
}

function LinkButton({ icon, text, url }: { icon: string; text: string; url: string }) {
  return (
    <TouchableOpacity style={styles.linkButton} onPress={() => openUrl(url)}>
      <Text style={styles.linkText}>{icon} {text}</Text>
    </TouchableOpacity>
  );
}

// ─── Styles ────────────────────────────────

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: COLORS.background, padding: 20 },

  // Desktop two-column layout
  scrollDesktop: { alignItems: 'center' },
  oneCol: { width: '100%' },
  twoCol: { flexDirection: 'row', width: '100%', maxWidth: 1040, alignItems: 'flex-start' },
  leftCol: { width: 420 },
  rightCol: { flex: 1 },

  // Image area
  imageArea: { width: '100%', alignItems: 'center', borderBottomWidth: 1, borderBottomColor: COLORS.border + '44', paddingHorizontal: 12, paddingVertical: 16 },
  imgContainer: { width: '100%', alignItems: 'center' },
  fallbackArea: { alignItems: 'center', padding: 32 },
  fallbackId: { fontSize: 22, fontWeight: 'bold', color: COLORS.text + '99', marginBottom: 8 },
  fallbackName: { fontSize: 20, fontWeight: 'bold', color: COLORS.text, marginBottom: 4 },
  fallbackTw: { fontSize: 15, color: COLORS.primary, marginBottom: 12 },
  fallbackHint: { fontSize: 13, color: COLORS.primary },

  // Price section
  collectionCard: { marginHorizontal: 20, marginTop: 14, padding: 12, borderRadius: 10, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surface, flexDirection: 'row', alignItems: 'center', gap: 12 },
  collectionCopy: { flex: 1, minWidth: 0 },
  collectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  collectionVersion: { color: COLORS.textSecondary, fontSize: 11, marginTop: 3 },
  collectionControls: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  collectionButton: { width: 38, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  collectionButtonText: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  collectionButtonDisabled: { color: COLORS.border },
  collectionQuantity: { minWidth: 24, color: COLORS.text, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  collectionRemove: { color: COLORS.error, fontSize: 12, fontWeight: '700' },
  priceSection: { paddingHorizontal: 20, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: COLORS.border + '44' },
  priceHeader: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  priceSourceName: { fontSize: 17, fontWeight: '700', color: COLORS.text },
  priceBadge: { marginLeft: 10, backgroundColor: COLORS.surfaceLight, color: COLORS.textSecondary, fontSize: 11, paddingHorizontal: 8, paddingVertical: 3, borderRadius: 4 },
  priceRow: { flexDirection: 'row', alignItems: 'baseline', marginBottom: 4 },
  priceValue: { fontSize: 28, fontWeight: 'bold', color: '#10b981' },
  priceRange: { fontSize: 13, color: COLORS.textSecondary, marginLeft: 6 },
  priceNote: { fontSize: 11, color: COLORS.textSecondary + 'bb', marginBottom: 12 },
  checkPriceBtn: { backgroundColor: COLORS.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center' },
  checkPriceBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  noPriceText: { fontSize: 20, fontWeight: '600', color: COLORS.textSecondary + '99', paddingVertical: 8 },
  variantList: { marginBottom: 12 },
  variantRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 6, paddingHorizontal: 10, backgroundColor: COLORS.surfaceLight, borderRadius: 8, marginBottom: 6 },
  variantName: { color: COLORS.text, fontSize: 13, fontWeight: '600', flex: 1, marginRight: 8 },
  variantPrice: { color: COLORS.success, fontSize: 15, fontWeight: 'bold' },
  variantHint: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2, paddingHorizontal: 4 },

  // Info section
  section: { paddingHorizontal: 20, paddingVertical: 18, borderBottomWidth: 1, borderBottomColor: COLORS.border + '44' },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: COLORS.text, marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardNumber: { fontSize: 14, color: COLORS.textSecondary, fontWeight: '700' },
  rarityBadge: { paddingHorizontal: 12, paddingVertical: 4, borderRadius: 6, minWidth: 48, alignItems: 'center' },
  rarityText: { fontSize: 12, fontWeight: '800', color: COLORS.text },
  detailBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailBloomBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, minWidth: 50, alignItems: 'center' },
  detailBloomBadgeText: { fontSize: 12, fontWeight: '800', color: '#ffffff', letterSpacing: 0.3 },
  detailBloomBadgePending: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.border, backgroundColor: 'transparent' },
  detailBloomBadgePendingText: { fontSize: 11, fontWeight: '700', color: COLORS.textSecondary },
  detailCategoryChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, backgroundColor: 'transparent' },
  detailCategoryChipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  detailRarityChip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1, backgroundColor: 'transparent' },
  detailRarityChipText: { fontSize: 11, fontWeight: '800' },
  nameJP: { fontSize: 26, fontWeight: 'bold', color: COLORS.text, marginBottom: 3 },
  nameTW: { fontSize: 17, color: COLORS.primary, marginBottom: 3 },
  nameEN: { fontSize: 13, color: COLORS.text + '88', marginBottom: 12, fontStyle: 'italic' },
  infoRow: { flexDirection: 'row', marginBottom: 5 },
  infoLabel: { fontSize: 14, color: COLORS.textSecondary, marginRight: 6 },
  infoValue: { fontSize: 14, color: COLORS.text, flex: 1 },

  // Effects
  effectBlock: { backgroundColor: COLORS.surfaceLight + 'cc', padding: 14, borderRadius: 10, marginBottom: 8, borderLeftWidth: 3, borderLeftColor: COLORS.primary },
  effectText: { fontSize: 14, lineHeight: 22, color: COLORS.text },
  noEffectText: { fontSize: 13, lineHeight: 20, color: COLORS.textSecondary + 'bb', fontStyle: 'italic' },

  // Skills
  skillCard: { backgroundColor: COLORS.surfaceLight + '55', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 10, padding: 12, marginBottom: 10 },
  skillHeader: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', marginBottom: 6 },
  skillBadge: { fontSize: 12, fontWeight: '700', color: COLORS.textSecondary, borderWidth: 1, borderColor: COLORS.border + '88', borderRadius: 5, paddingHorizontal: 8, paddingVertical: 2, marginRight: 8, overflow: 'hidden' },
  skillMeta: { fontSize: 12, color: COLORS.textSecondary, fontWeight: '600' },
  skillName: { fontSize: 15, fontWeight: 'bold', color: COLORS.text, marginBottom: 4 },
  skillEffect: { fontSize: 13, lineHeight: 21, color: COLORS.text + 'cc' },
  skillFallbackNote: { fontSize: 12, color: COLORS.textSecondary, marginTop: 8 },
  noSkillText: { fontSize: 13, color: COLORS.textSecondary + 'aa', fontStyle: 'italic' },

  // Tags
  tagWrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  tag: { backgroundColor: COLORS.surfaceLight, paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6 },
  tagText: { fontSize: 12, color: COLORS.textSecondary },

  // Links
  linkButton: { backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border + '88', paddingVertical: 14, paddingHorizontal: 16, borderRadius: 10, marginBottom: 8 },
  linkText: { fontSize: 15, fontWeight: '600', color: COLORS.text },

  // Watchlist button
  watchlistBtn: { backgroundColor: COLORS.primary, paddingVertical: 15, borderRadius: 12, alignItems: 'center' },
  watchlistBtnActive: { backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.primary },
  topActionRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: 20, paddingTop: 12 },
  watchlistChip: { backgroundColor: COLORS.primary, paddingVertical: 10, paddingHorizontal: 16, borderRadius: 20 },
  watchlistChipActive: { backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.primary },
  watchlistChipText: { color: '#fff', fontSize: 14, fontWeight: '600' },
  watchlistChipTextActive: { color: COLORS.primary },
  watchlistBtnText: { fontSize: 16, fontWeight: '800', color: '#fff' },
  watchlistBtnTextActive: { color: COLORS.primary },

  // Market data section
  marketBlock: { backgroundColor: COLORS.surfaceLight + '55', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 10, padding: 12, marginBottom: 10 },
  marketBlockTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  marketRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  marketLabel: { fontSize: 13, color: COLORS.textSecondary, flex: 1, marginRight: 8 },
  marketValue: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  marketValueStrong: { fontSize: 15, fontWeight: 'bold' },
  marketNote: { fontSize: 11, color: COLORS.textSecondary + '99', marginTop: 6, lineHeight: 16 },

  // Version selector (market data)
  versionLabel: { fontSize: 12, color: COLORS.textSecondary, marginBottom: 8, fontWeight: '600' },
  versionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginBottom: 12 },
  versionChip: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border + '88' },
  versionChipText: { fontSize: 12, fontWeight: '600', color: COLORS.textSecondary },
  versionChipActive: { backgroundColor: COLORS.primary + '22', borderColor: COLORS.primary },
  versionChipTextActive: { color: COLORS.primary },
  versionWarnBox: { backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: '#f59e0b' + '44', borderRadius: 10, padding: 12, marginBottom: 10 },
  versionWarnTitle: { fontSize: 13, fontWeight: '700', color: '#f59e0b', marginBottom: 4 },
  versionWarnText: { fontSize: 12, lineHeight: 18, color: COLORS.textSecondary },

  // Trend prediction section
  componentSection: { marginTop: 12, paddingTop: 12, borderTopWidth: 1, borderTopColor: COLORS.border + '44' },
  componentTitle: { fontSize: 13, fontWeight: '600', color: COLORS.textSecondary, marginBottom: 8 },
  componentRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 6 },
  componentLabel: { fontSize: 12, color: COLORS.textSecondary, width: 130 },
  componentBarBg: { flex: 1, height: 6, backgroundColor: COLORS.border, borderRadius: 3, marginHorizontal: 8, overflow: 'hidden' },
  componentBarFill: { height: '100%', borderRadius: 3 },
  componentValue: { fontSize: 12, fontWeight: '700', width: 45, textAlign: 'right' },
  dataPointsNote: { fontSize: 11, color: COLORS.textSecondary + '88', marginTop: 6, textAlign: 'center' },
});
