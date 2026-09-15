import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Image, Platform } from 'react-native';
import { COLORS, convertPrice } from '../constants';
import { AppShell } from '../components/shell';
import { PALETTE, SEMANTIC, FONTS, CATEGORY_COLORS } from '../theme/tokensV2';
import { FEATURES } from '../config/releaseFlags';
import { openUrl } from '../utils/openUrl';
import { useSettingsStore } from '../store/settingsStore';
import { useDeckStore } from '../store/deckStore';
import { useFavoritesStore } from '../store/favoritesStore';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { buildSourcePrintings } from '../utils/printingIdentity';
import { PRICE_CURRENCY } from '../utils/deckCardData';
import { formatInterval } from '../utils/priceAlerts';
import type { PrintingOption } from '../utils/alertMigration';
import PriceTrendBadge from '../components/PriceTrendBadge';
import { useTrendStore, TrendPrediction } from '../store/trendStore';
import { hasDisplayableSubscriberStats, isValidatedTrendPrediction, bloomLevelBadgeColor, categoryBadgeColor, resolveCardColorsWithNestedFallback, PRINTING_RARITY_COLORS } from '../utils/cardNormalization';
import { computeValidatedPriceTrend } from '../utils/priceTrend';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
import { useTranslation } from '../i18n';
import { ownershipKey } from '../utils/deckRules';
import { resolveCardDisplayName } from '../utils/cardDisplayName';

const gradeLabels: Record<string, string> = { debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot' };
// DIC-1141 CR: printing rarity palette imported from the shared source in
// cardNormalization.ts so the palette-collision regression is authoritative.
const rarityColors = PRINTING_RARITY_COLORS;
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

// Pen o7WO3r tabs (node EFhFr): 技能與效果 / 市場價格 / 成員數據.
type DetailTab = 'skills' | 'market' | 'member';

export default function CardDetailScreen({ route, navigation }: any) {
  const { card } = route.params || {};
  const [imageError, setImageError] = useState(false);
  const { preferredCurrency, preferredLanguage } = useSettingsStore();
  const { isDesktop } = useBreakpoint();
  const { t } = useTranslation();
  const collection = useDeckStore((state) => state.collection);
  const adjustOwned = useDeckStore((state) => state.adjustOwned);
  const setOwned = useDeckStore((state) => state.setOwned);
  // DIC-1380 W6: wire the independent favorites store into the card
  // detail so the store actually round-trips per user action (a static
  // FavoritesScreen placeholder is not "favorites round-trip").
  const favorites = useFavoritesStore((state) => state.favorites);
  const toggleFavorite = useFavoritesStore((state) => state.toggleFavorite);
  // Pen EFhFr: 市場價格 is the active segment in the reference frame; fall
  // back to 技能與效果 on profiles where the price surface is gated off.
  const [activeTab, setActiveTab] = useState<DetailTab>(FEATURES.sellPrice ? 'market' : 'skills');

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
  // DIC-1380: route the primary/subtitle choice through the shared helper so
  // CardDetail, SearchResults, ScanResultCard and DeckEditor stay in lock-step.
  const { primary: displayName, secondary: displayNameSub } = resolveCardDisplayName(
    { name: nameJP, nameZh: nameZH },
    preferredLanguage,
  );
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
  // DIC-1159 + DIC-1192 + CR #1: route every source through the composed
  // canonical → permissive helper so a non-canonical value (`◇`, `blue_red`
  // before splitting, `mystery`) can never reach `t(\`color_${color}\`)`
  // AND the DIC-1192 `◇ → colorless` render still lands. When top-level
  // `card.color` / `card.colors` produces nothing — which happens on the
  // real hBP04-087/088 / hBP06-084 winners post-2026-08-28 catalog sync
  // (top-level rewritten to `"null"`) — the helper falls back to the
  // authoritative token in `card.skillsJp.color` / `card.skillsZh.color`
  // so the detail row still says `無色` instead of dropping the label.
  const canonicalColorIds = resolveCardColorsWithNestedFallback(card);
  const colorNames = canonicalColorIds.map((c) => t(`color_${c}` as Parameters<typeof t>[0]));

  const seriesNames = card.seriesNames || [];
  const tags = card.tags || [];
  const versions = card.versions || [];

  // Use card.images[0] when available, otherwise the payload's own imageUrl, or
  // build one from the card-number pattern.
  //
  // DIC-1430: `buildImageUrl` derives art from the CARD NUMBER, so it produces
  // the same picture for every printing of that number. On an exact-printing
  // payload (`card.printing` is set) that is precisely the representative-art
  // substitution the canonical resolver now refuses to make — reconstructing it
  // here would undo the fail-closed decision one layer down and put an unproven
  // picture next to a proven price. An exact printing therefore shows only the
  // art its own listing proved; with none, the hero renders its honest
  // unavailable state rather than a card-number guess.
  const cardSeries = (Array.isArray(card.series) ? card.series[0] : card.series) || (id?.split('-')[0] || '');
  const provenImageUrl = (card.images && card.images[0]) || card.imageUrl || '';
  const imageUrl = provenImageUrl
    || (card.printing ? '' : buildImageUrl(id, cardSeries, versions, card.type || ''));
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

  // Pen AKxk8 mini chart: one bar per validated history point. Only the
  // exact-identity single-printing series that already passed
  // computeValidatedPriceTrend feeds the bars — a multi-version card renders
  // no chart rather than a mixed-printing curve (DIC-856 / DIC-1084).
  const chartPoints = useMemo(() => {
    if (!detailPriceTrend) return [] as { time: number; price: number }[];
    return Object.entries(card.priceHistory || {})
      .map(([timestamp, rawPrice]) => ({ time: Date.parse(timestamp), price: Number(rawPrice) }))
      .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price) && point.price > 0)
      .sort((a, b) => a.time - b.time)
      .slice(-14);
  }, [card.priceHistory, detailPriceTrend]);

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

  const cardIsFav = FEATURES.favorites && collectionVersion
    ? favorites.some((f) => f.cardNumber === id && f.printing === collectionVersion.printing)
    : false;
  const onToggleFavorite = collectionVersion
    ? () => toggleFavorite({ cardNumber: id, printing: collectionVersion.printing, cardId: card?.id })
    : undefined;

  // Pen j8ywIo 加入牌組: hand the card number to the real deck editor, whose
  // picker opens pre-filtered on this exact number (route param, no new UI).
  const onAddToDeck = () => navigation?.navigate?.('DeckEditor', { addCardNumber: id });

  const bloomBadgeLabel = card.normalized?.category === 'holomen'
    ? (card.normalized?.stageLabel || gradeLabels[card.grade] || null)
    : null;
  const setLine = card.sourceProductName || (seriesNames.length > 0 ? `${seriesNames.join(' / ')} ${cardSeries}` : cardSeries);
  const statHp = card.hp != null && `${card.hp}`.trim() !== '' ? `${card.hp}` : null;
  const statLife = card.life != null && `${card.life}`.trim() !== '' ? `${card.life}` : null;

  const TAB_ITEMS: { key: DetailTab; label: string }[] = [
    { key: 'skills', label: t('card_detail_tab_skills') },
    { key: 'market', label: t('card_detail_tab_market') },
    { key: 'member', label: t('card_detail_tab_member') },
  ];

  const deltaChip = FEATURES.trendPrediction && detailPriceTrend ? (() => {
    const up = detailPriceTrend.direction === 'up';
    const flat = detailPriceTrend.direction === 'flat';
    const chipBg = flat ? PALETTE.appElev : up ? 'rgba(34,197,94,0.12)' : 'rgba(248,113,113,0.12)';
    const chipFg = flat ? PALETTE.textSecondary : up ? '#4ADE80' : '#FF8A8A';
    const arrow = up ? '↗' : flat ? '→' : '↘';
    return (
      <View style={[styles.priceDeltaChip, { backgroundColor: chipBg }]} testID="card-detail-price-delta">
        <Text style={[styles.priceDeltaText, { color: chipFg }]}>
          {arrow} {Math.abs(detailPriceTrend.percentage).toFixed(1)}%
        </Text>
      </View>
    );
  })() : null;

  const chartMin = chartPoints.length > 0 ? Math.min(...chartPoints.map((p) => p.price)) : 0;
  const chartMax = chartPoints.length > 0 ? Math.max(...chartPoints.map((p) => p.price)) : 0;
  const chartSpan = Math.max(chartMax - chartMin, 1);

  // DIC-1409 Phase 3 + DIC-1427 QA P0: Pen `App / 03 卡牌詳情` (frame o7WO3r).
  // Back arrow + card number + heart/external actions in the app bar, compact
  // Card Hero (jzuT9), 技能/市場/成員 segmented tabs (EFhFr), Pen price card
  // (qJqlm) with the validated-history delta/compare/chart, 到價提醒 banner
  // (jB05M), and the fixed 收藏/加入牌組 action bar (Mst3p). No bottom tab bar.
  return (
    <AppShell
      appBar={{
        showBrand: false,
        title: id,
        leading: (
          <TouchableOpacity
            onPress={() => (navigation?.goBack ? navigation.goBack() : navigation?.navigate?.('Home'))}
            accessibilityRole="button"
            accessibilityLabel={t('common_back')}
            style={styles.shellBackButton}
            testID="card-detail-back"
          >
            <Text style={styles.shellBackGlyph}>‹</Text>
          </TouchableOpacity>
        ),
        actions: [
          ...(FEATURES.favorites && collectionVersion ? [{
            key: 'favorite',
            label: cardIsFav
              ? t('favorites_remove_a11y', { name: displayName })
              : t('favorites_add_a11y', { name: displayName }),
            icon: <Text style={[styles.shellActionGlyph, cardIsFav ? { color: PALETTE.accent } : null]}>{cardIsFav ? '♥' : '♡'}</Text>,
            onPress: () => onToggleFavorite?.(),
          }] : []),
          {
            key: 'official',
            label: t('card_detail_official_list'),
            icon: <Text style={styles.shellActionGlyph}>↗</Text>,
            onPress: () => openUrl(officialUrl),
          },
        ],
      }}
      scrollable={false}
      contentPadding={false}
      testID="card-detail-shell"
    >
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      <View style={styles.bodyWrap}>
        <ScrollView style={styles.container} contentContainerStyle={[styles.scrollContent, isDesktop ? styles.scrollDesktop : null]}>
          <View style={isDesktop ? styles.desktopColumn : undefined}>

            {/* ====== CARD HERO (Pen jzuT9: compact art + identity column) ====== */}
            <View style={styles.hero} testID="card-detail-hero">
              <View style={[styles.heroArt, { backgroundColor: rarityColors[rarityKey] ? rarityColors[rarityKey] + '14' : PALETTE.appElev }]} testID="card-detail-hero-art">
                {imageUrl && !imageError ? (
                  /* @ts-ignore */
                  <Image
                    source={{ uri: imageUrl }}
                    style={styles.heroArtImage}
                    resizeMode="cover"
                    onError={() => setImageError(true)}
                  />
                ) : (
                  /* Reached on a broken image AND, since DIC-1430, whenever an
                   * exact printing has no source-proven art. Same honest state:
                   * the card number plus a link to the official image, never a
                   * borrowed picture. */
                  <TouchableOpacity
                    style={styles.heroArtFallback}
                    activeOpacity={0.8}
                    onPress={() => openUrl(officialUrl)}
                    accessibilityRole="button"
                    testID="card-detail-hero-art-unavailable"
                  >
                    <Text style={styles.heroArtFallbackId}>{id}</Text>
                    <Text style={styles.heroArtFallbackHint}>{t('card_detail_official_image')}</Text>
                  </TouchableOpacity>
                )}
                <View style={styles.heroArtFoot}>
                  <Text style={styles.heroArtFootText}>{rarityKey}</Text>
                </View>
              </View>
              <View style={styles.heroInfo}>
                <Text style={styles.heroName} numberOfLines={2}>{displayName}</Text>
                {displayNameSub ? <Text style={styles.heroNameSub} numberOfLines={1}>{displayNameSub}</Text> : null}
                <Text style={styles.heroSet} numberOfLines={2}>{setLine}</Text>
                <View style={styles.heroBadges}>
                  {canonicalColorIds.map((colorId, i) => (
                    <View key={`c${colorId}`} style={styles.heroBadge} testID={`card-detail-badge-color-${colorId}`}>
                      <View style={[styles.heroBadgeDot, { backgroundColor: (CATEGORY_COLORS as Record<string, string>)[colorId] || PALETTE.textMuted }]} />
                      <Text style={styles.heroBadgeText}>{colorNames[i]}</Text>
                    </View>
                  ))}
                  {typeLabel ? (
                    <View style={styles.heroBadge} testID="card-detail-badge-category">
                      <Text style={styles.heroBadgeText}>{typeLabel}</Text>
                    </View>
                  ) : null}
                  {bloomBadgeLabel ? (
                    <View style={styles.heroBadge} testID="card-detail-badge-bloom">
                      <Text style={styles.heroBadgeText}>{`Bloom ${bloomBadgeLabel}`}</Text>
                    </View>
                  ) : null}
                </View>
                {(statHp || statLife) ? (
                  <View style={styles.heroStats}>
                    {statHp ? (
                      <View style={styles.heroStatCell} testID="card-detail-stat-hp">
                        <Text style={styles.heroStatLabel}>HP</Text>
                        <Text style={styles.heroStatValue}>{statHp}</Text>
                      </View>
                    ) : null}
                    {statLife ? (
                      <View style={styles.heroStatCell} testID="card-detail-stat-life">
                        <Text style={styles.heroStatLabel}>LIFE</Text>
                        <Text style={styles.heroStatValue}>{statLife}</Text>
                      </View>
                    ) : null}
                  </View>
                ) : null}
              </View>
            </View>

            {/* ====== TABS (Pen EFhFr) ====== */}
            <View style={styles.tabsRow} testID="card-detail-tabs">
              {TAB_ITEMS.map((tab) => {
                const active = activeTab === tab.key;
                const ariaProps: Record<string, unknown> = { 'aria-selected': active };
                return (
                  <TouchableOpacity
                    key={tab.key}
                    style={[styles.tabSeg, active ? styles.tabSegActive : null]}
                    onPress={() => setActiveTab(tab.key)}
                    accessibilityRole="tab"
                    accessibilityState={{ selected: active }}
                    testID={`card-detail-seg-${tab.key}`}
                    activeOpacity={0.85}
                    {...ariaProps}
                  >
                    <Text style={[styles.tabSegText, active ? styles.tabSegTextActive : null]}>{tab.label}</Text>
                  </TouchableOpacity>
                );
              })}
            </View>

            {/* ====== 市場價格 PANE (Pen qJqlm price card + jB05M alert row) ======
                All three panes stay mounted and toggle `display` so the
                alignment override / scroll state survive tab switches and the
                static store-profile probe still sees every gated marker. */}
            <View style={activeTab === 'market' ? null : styles.paneHidden} testID="card-detail-market-panel">
                {/* 售價 / 版本價格 — Store MVP 也顯示 (DIC-1319)：這是這張卡自己的
                    掛牌售價，屬於基本查價。漲跌走勢仍由 FEATURES.trendPrediction 擋著，
                    「查即時價」外連仍由 FEATURES.externalPriceLinks 擋著，買賣差價與
                    MarketDataPanel 仍由 FEATURES.marketData 擋著。 */}
                {FEATURES.sellPrice && (
                  <View style={styles.priceSection} testID="card-detail-price-section">
                    <View style={styles.priceHead}>
                      <Text style={styles.priceSourceLabel}>{t('card_detail_reference_price')}</Text>
                      {hasActualPrice && !hasMultipleVariants ? (
                        <View style={styles.priceVersionChip}>
                          <Text style={styles.priceVersionChipText}>{card.sourceRarity || rarityKey}</Text>
                        </View>
                      ) : null}
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
                        {/* Both non-store hints tell the user to pick a version down in
                            「市場數據」, but MarketDataPanel is gated on FEATURES.marketData.
                            Since DIC-1319 un-gated this list, the store build would render
                            an instruction pointing at a section that is not there — so the
                            hint that names a gated section is itself gated. */}
                        <Text style={styles.variantHint} testID="card-detail-variant-hint">
                          {!FEATURES.marketData
                            ? t('card_detail_variant_hint_store')
                            : FEATURES.priceSpread
                              ? t('card_detail_variant_hint_spread')
                              : t('card_detail_variant_hint')}
                        </Text>
                      </View>
                    ) : hasActualPrice ? (
                      <>
                        <View style={styles.priceValueRow}>
                          <Text style={styles.priceValue}>¥{actualPrice.toLocaleString()}</Text>
                          {deltaChip}
                        </View>
                        {FEATURES.trendPrediction && detailPriceTrend ? (
                          <Text style={styles.priceCompare} testID="card-detail-price-compare">
                            {t('card_detail_compare_line', {
                              recent: `¥${Math.round(detailPriceTrend.recentAverage).toLocaleString()}`,
                              prior: `¥${Math.round(detailPriceTrend.priorAverage).toLocaleString()}`,
                            })}
                          </Text>
                        ) : null}
                        {(() => {
                          const converted = convertPrice(actualPrice, preferredCurrency);
                          return (
                            <Text style={styles.priceNote}>{t('card_detail_approx_price', { price: `${converted.symbol}${converted.value?.toLocaleString()}`, currency: preferredCurrency })}</Text>
                          );
                        })()}
                        {priceName ? (
                          <Text style={styles.priceNote}>📋 {priceName}</Text>
                        ) : null}
                        {FEATURES.trendPrediction && chartPoints.length >= 3 ? (
                          <View style={styles.priceChart} testID="card-detail-price-chart">
                            {chartPoints.map((point, i) => {
                              const h = 24 + Math.round(((point.price - chartMin) / chartSpan) * 38);
                              return (
                                <View
                                  key={`${point.time}-${i}`}
                                  style={[
                                    styles.priceChartBar,
                                    { height: h },
                                    Platform.OS === 'web'
                                      ? ({ backgroundImage: `linear-gradient(180deg, ${PALETTE.accent} 0%, rgba(255,77,157,0.25) 100%)` } as object)
                                      : { backgroundColor: PALETTE.accent },
                                  ]}
                                  testID={`card-detail-price-bar-${i}`}
                                />
                              );
                            })}
                          </View>
                        ) : null}
                      </>
                    ) : (
                      <Text style={styles.noPriceText}>{t('card_detail_no_data')}</Text>
                    )}
                    {/* 「查即時價」把使用者送到遊々亭 — 外部價格連結，維持 Store MVP 隱藏
                        (DIC-1256)；DIC-1319 只放行卡片自己的售價數字，不放行外連。 */}
                    {FEATURES.externalPriceLinks && (
                      <TouchableOpacity style={styles.checkPriceBtn} onPress={() => openUrl(yuyuUrl)}>
                        <Text style={styles.checkPriceBtnText}>{t('card_detail_live_price')}</Text>
                      </TouchableOpacity>
                    )}
                  </View>
                )}

                {/* ====== MARKET DATA (version alignment + Pen UhG5Z spread cells) ====== */}
                {/* 市場數據區塊 — Store MVP 隱藏 (DIC-1256): 版本 pills、賣價、店家收購、
                    買賣差價全部不展示。 */}
                {FEATURES.marketData && <MarketDataPanel card={card} section="market" />}

                {/* ====== 到價提醒 BANNER (Pen jB05M) ====== */}
                {FEATURES.watchlist && (
                  <TouchableOpacity
                    style={styles.alertBanner}
                    onPress={openAlertEditor}
                    activeOpacity={0.85}
                    accessibilityRole="button"
                    accessibilityLabel={t('card_detail_alert_a11y')}
                    testID="card-price-alert-chip"
                  >
                    <Text style={styles.alertBell}>🔔</Text>
                    <View style={styles.alertCopy}>
                      <Text style={styles.alertTitle}>{alertButtonLabel}</Text>
                      <Text style={styles.alertSub} numberOfLines={1}>
                        {cardAlerts.length > 0 ? t('card_detail_alert_banner_active') : t('card_detail_alert_banner_hint')}
                      </Text>
                    </View>
                    <Text style={styles.alertEdit}>✎</Text>
                  </TouchableOpacity>
                )}

                {/* ====== TREND PREDICTION ====== */}
                {/* 趨勢預測基於卡號層級歷史（單一版本序列）。多版本卡無法歸屬到特定版本 → 隱藏，
                    避免用別版走勢推薦本版（DIC-856：禁止跨版本推薦訊號）。
                    漲跌預測 / trendScore / 信心度 / YT / 新聞情緒 → Store MVP 隱藏（DIC-908）。 */}
                {FEATURES.trendPrediction && !hasMultipleVariants && trend && isValidatedTrendPrediction(trend, card) && (
                  <View style={styles.sectionCard}>
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
            </View>

            {/* ====== 技能與效果 PANE ====== */}
            <View style={activeTab === 'skills' ? null : styles.paneHidden} testID="card-detail-skills-panel">
                <SkillsPanel skills={displaySkills} fallbackNote={skillsFallbackNote} />
                {(effects.length > 0 || card.type === 'Oshi') && (
                  <View style={styles.sectionCard}>
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
            </View>

            {/* ====== 成員數據 PANE ====== */}
            <View style={activeTab === 'member' ? null : styles.paneHidden} testID="card-detail-member-panel">
                {/* YT 成員數據 — Store MVP 隱藏（DIC-908/DIC-1256）。 */}
                {FEATURES.marketData && <MarketDataPanel card={card} section="member" />}

                {/* ====== CARD BASIC INFO ====== */}
                <View style={styles.sectionCard}>
                  <View style={styles.headerRow}>
                    <Text style={styles.cardNumber}>{id}</Text>
                    <DetailIdentityBadges normalized={card.normalized} rarity={rarityKey} t={t} />
                  </View>
                  {nameEN && nameEN !== nameJP && nameEN !== nameZH ? <Text style={styles.nameEN}>{nameEN}</Text> : null}
                  {typeLabel ? (
                    <InfoRow label={t('card_detail_type_label')} value={typeLabel} />
                  ) : null}
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

                {/* ====== SEARCH KEYWORDS ====== */}
                <View style={styles.sectionCard}>
                  <Text style={styles.sectionTitle}>{t('card_detail_keywords')}</Text>
                  <View style={styles.tagWrap}>
                    {nameJP ? <Tag text={nameJP} /> : null}
                    {nameZH ? <Tag text={nameZH} /> : null}
                    {tags.map((t: string, i: number) => <Tag key={`t${i}`} text={t} />)}
                  </View>
                </View>

                {/* ====== EXTERNAL LINKS ====== */}
                {/* 官方卡表永遠保留；遊々亭 / Carousell 兩個價格查詢外連 Store MVP 隱藏
                    (DIC-1256)。這區還會有官方卡表所以永遠 render。 */}
                <View style={styles.sectionCard}>
                  <Text style={styles.sectionTitle}>{t('card_detail_external_links')}</Text>
                  <LinkButton icon="🏛️" text={t('card_detail_official_list')} url={officialUrl} />
                  {FEATURES.externalPriceLinks && (
                    <>
                      <LinkButton icon="🏪" text={t('card_detail_yuyu_link')} url={yuyuUrl} />
                      <LinkButton icon="🔄" text={t('card_detail_carousell_link')} url={`https://www.carousell.com.tw/search/?q=${encodeURIComponent(id)}`} />
                    </>
                  )}
                </View>
            </View>

            {/* 收藏 (per-card ownership +/- widget) — hidden in Store MVP (DIC-1256).
                The deck editor keeps its own ownership editing; this card-detail
                shortcut is a favorites/collection surface and disappears with the
                drawer entry. Persistent under every tab pane. */}
            {FEATURES.favorites && collectionVersion && (
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

            <View style={{ height: 108 }} />
          </View>
        </ScrollView>

        {/* ====== ACTION BAR (Pen Mst3p: 加入收藏 c0EK58 + 加入牌組 j8ywIo) ====== */}
        <View style={styles.actionBar} testID="card-detail-action-bar">
          {FEATURES.favorites && collectionVersion ? (
            <TouchableOpacity
              style={[styles.actionBtnGhost, cardIsFav ? styles.actionBtnGhostActive : null]}
              onPress={onToggleFavorite}
              accessibilityRole="button"
              accessibilityState={{ selected: cardIsFav }}
              accessibilityLabel={cardIsFav
                ? t('favorites_remove_a11y', { name: displayName })
                : t('favorites_add_a11y', { name: displayName })}
              testID="card-detail-action-favorite"
              activeOpacity={0.85}
            >
              <Text style={[styles.actionBtnGhostText, cardIsFav ? styles.actionBtnGhostTextActive : null]}>
                {cardIsFav ? `♥ ${t('card_detail_action_favorited')}` : `♡ ${t('card_detail_action_favorite')}`}
              </Text>
            </TouchableOpacity>
          ) : null}
          <TouchableOpacity
            style={[
              styles.actionBtnPrimary,
              Platform.OS === 'web'
                ? ({ backgroundImage: `linear-gradient(135deg, ${PALETTE.accent} 0%, ${PALETTE.accent3} 100%)` } as object)
                : { backgroundColor: PALETTE.accent },
            ]}
            onPress={onAddToDeck}
            accessibilityRole="button"
            accessibilityLabel={t('card_detail_action_add_deck')}
            testID="card-detail-action-add-deck"
            activeOpacity={0.85}
          >
            <Text style={styles.actionBtnPrimaryText}>＋ {t('card_detail_action_add_deck')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    </AppShell>
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
    <View style={styles.sectionCard}>
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

// `section="market"` renders the version-alignment pills and the Pen UhG5Z
// 買入成本/店家收購/買賣差價 spread cells inside the 市場價格 pane;
// `section="member"` renders the YouTube 成員數據 block inside the 成員數據
// pane. One component so the DIC-856 alignment state and fail-closed rules
// stay in a single place.
function MarketDataPanel({ card, section = 'market' }: { card: any; section?: 'market' | 'member' }) {
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

  if (section === 'market') {
  return (
    <View style={styles.sectionCard}>
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

      {/* 買賣差價 / 店家收購價 — Store MVP 隱藏（DIC-908）；正常售價仍於上方價格區顯示。
          Pen UhG5Z：買入成本 / 店家收購 / 買賣差價 三格。 */}
      {FEATURES.priceSpread && (hasSpread ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>{t('card_detail_spread_title', { version: versionLabel })}</Text>
          {isPriceReliable ? (
            <View style={styles.spreadRow}>
              <View style={styles.spreadCell} testID="card-detail-spread-buy-cost">
                <Text style={styles.spreadCellLabel}>{t('card_detail_spread_cell_buy')}</Text>
                <Text style={styles.spreadCellValue}>¥{sellPrice.toLocaleString()}</Text>
              </View>
              <View style={styles.spreadCell} testID="card-detail-spread-shop-buyback">
                <Text style={styles.spreadCellLabel}>{t('card_detail_spread_cell_shop')}</Text>
                <Text style={[styles.spreadCellValue, { color: SEMANTIC.onBgMuted }]}>¥{buyPrice.toLocaleString()}</Text>
              </View>
              <View style={styles.spreadCell} testID="card-detail-spread-spread">
                <Text style={styles.spreadCellLabel}>{t('card_detail_spread_cell_diff')}</Text>
                <Text style={[styles.spreadCellValue, { color: spreadUp ? '#4ADE80' : '#FF8A8A' }]}>
                  {spreadUp ? '+' : ''}{(buyPrice - sellPrice).toLocaleString()}
                </Text>
              </View>
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
    </View>
    );
  }

  if (!(FEATURES.ytStats && hasDisplayableSubscriberStats(ytStats))) return null;
  return (
    <View style={styles.sectionCard}>
      {/* YouTube 成員數據 / 訂閱・觀看成長 — Store MVP 隱藏（DIC-908） */}
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
  container: { flex: 1, backgroundColor: PALETTE.appBg },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: PALETTE.appBg, padding: 20 },
  bodyWrap: { flex: 1 },
  scrollContent: { paddingTop: 6 },
  paneHidden: { display: 'none' },

  // Pen App/03 shell chrome (back arrow t2SEv, heart WZtaq, external-link CE6L7)
  shellBackButton: { width: 32, height: 32, alignItems: 'center', justifyContent: 'center', marginLeft: -6 },
  shellBackGlyph: { fontFamily: Platform.OS === 'web' ? FONTS.display : undefined, fontSize: 26, lineHeight: 28, color: SEMANTIC.onBgMuted },
  shellActionGlyph: { fontSize: 18, lineHeight: 20, color: SEMANTIC.onBgMuted },

  // Desktop: Pen only specifies the 390 frame — desktop centers the same
  // column instead of resurrecting the legacy two-column split.
  scrollDesktop: { alignItems: 'center' },
  desktopColumn: { width: '100%', maxWidth: 720 },

  // ── Card Hero (Pen jzuT9) ──
  hero: { flexDirection: 'row', gap: 16, paddingHorizontal: 16, paddingTop: 6 },
  heroArt: { width: 130, height: 182, borderRadius: 11, overflow: 'hidden', justifyContent: 'flex-end' },
  heroArtImage: { position: 'absolute', top: 0, left: 0, width: 130, height: 182 },
  heroArtFallback: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 8 },
  heroArtFallbackId: { fontSize: 13, fontWeight: '700', color: SEMANTIC.onBgMuted, marginBottom: 4 },
  heroArtFallbackHint: { fontSize: 10, color: PALETTE.accent2, textAlign: 'center' },
  heroArtFoot: { margin: 7, borderRadius: 5, backgroundColor: 'rgba(0,0,0,0.35)', alignItems: 'center', paddingVertical: 2 },
  heroArtFootText: { fontSize: 10, fontWeight: '700', color: '#FFFFFF' },
  heroInfo: { flex: 1, minWidth: 0 },
  heroName: { fontFamily: Platform.OS === 'web' ? FONTS.body : undefined, fontSize: 21, fontWeight: '800', color: SEMANTIC.onBg },
  heroNameSub: { fontSize: 13, color: SEMANTIC.onBgMuted, marginTop: 2 },
  heroSet: { fontSize: 11.5, color: SEMANTIC.onBgDim, marginTop: 9, lineHeight: 16 },
  heroBadges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 9 },
  heroBadge: { flexDirection: 'row', alignItems: 'center', gap: 5, backgroundColor: PALETTE.appElev, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 4 },
  heroBadgeDot: { width: 8, height: 8, borderRadius: 4 },
  heroBadgeText: { fontSize: 11, fontWeight: '600', color: '#B9B9CE' },
  heroStats: { flexDirection: 'row', gap: 8, marginTop: 8 },
  heroStatCell: { minWidth: 102, backgroundColor: PALETTE.appSurface, borderRadius: 9, paddingHorizontal: 10, paddingVertical: 8, gap: 3 },
  heroStatLabel: { fontSize: 10, color: SEMANTIC.onBgDim },
  heroStatValue: { fontSize: 13, fontWeight: '700', color: SEMANTIC.onBg },

  // ── Tabs (Pen EFhFr) ──
  tabsRow: { flexDirection: 'row', marginHorizontal: 16, marginTop: 18, marginBottom: 16, backgroundColor: PALETTE.appSurface, borderRadius: 11, padding: 3, gap: 2 },
  tabSeg: { flex: 1, borderRadius: 9, paddingVertical: 9, alignItems: 'center', justifyContent: 'center', minHeight: 36 },
  tabSegActive: { backgroundColor: 'rgba(255,255,255,0.07)' },
  tabSegText: { fontSize: 12.5, fontWeight: '500', color: SEMANTIC.onBgDim },
  tabSegTextActive: { fontWeight: '700', color: SEMANTIC.onBg },

  // ── Price card (Pen qJqlm) ──
  priceSection: { marginHorizontal: 16, padding: 16, borderRadius: 16, backgroundColor: PALETTE.appSurface },
  priceHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 },
  priceSourceLabel: { fontSize: 12, color: SEMANTIC.onBgDim },
  priceVersionChip: { backgroundColor: PALETTE.appElev, borderRadius: 7, paddingHorizontal: 9, paddingVertical: 5 },
  priceVersionChipText: { fontSize: 11, fontWeight: '600', color: '#B9B9CE' },
  priceValueRow: { flexDirection: 'row', alignItems: 'center', gap: 9, marginBottom: 6 },
  // Pen Value Row (node x0c32A): 30/700 Outfit on $text-primary — the mint
  // green price was one of the flagged Pen→Preview regressions.
  priceValue: { fontFamily: Platform.OS === 'web' ? FONTS.display : undefined, fontSize: 30, fontWeight: '700', color: SEMANTIC.onBg },
  priceDeltaChip: { borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 },
  priceDeltaText: { fontSize: 11.5, fontWeight: '700' },
  priceCompare: { fontSize: 11.5, color: SEMANTIC.onBgDim, marginBottom: 6 },
  priceNote: { fontSize: 11, color: COLORS.textSecondary + 'bb', marginBottom: 6 },
  priceChart: { flexDirection: 'row', alignItems: 'flex-end', gap: 4, height: 62, marginTop: 8 },
  priceChartBar: { flex: 1, borderTopLeftRadius: 3, borderTopRightRadius: 3 },
  checkPriceBtn: { backgroundColor: COLORS.primary, paddingVertical: 12, borderRadius: 10, alignItems: 'center', marginTop: 12 },
  checkPriceBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  noPriceText: { fontSize: 20, fontWeight: '600', color: COLORS.textSecondary + '99', paddingVertical: 8 },
  variantList: { marginBottom: 4 },
  variantRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 8, paddingHorizontal: 10, backgroundColor: PALETTE.appElev, borderRadius: 8, marginBottom: 6 },
  variantName: { color: COLORS.text, fontSize: 13, fontWeight: '600', flex: 1, marginRight: 8 },
  variantPrice: { color: PALETTE.accent2, fontSize: 14, fontWeight: '700' },
  variantHint: { color: COLORS.textSecondary, fontSize: 11, marginTop: 2, paddingHorizontal: 4 },

  // ── Alert banner (Pen jB05M) ──
  alertBanner: { flexDirection: 'row', alignItems: 'center', gap: 12, marginHorizontal: 16, marginTop: 12, padding: 14, borderRadius: 14, backgroundColor: 'rgba(251,191,36,0.06)' },
  alertBell: { fontSize: 17, lineHeight: 22 },
  alertCopy: { flex: 1, minWidth: 0 },
  alertTitle: { fontSize: 13, fontWeight: '700', color: SEMANTIC.onBg },
  alertSub: { fontSize: 11, color: SEMANTIC.onBgDim, marginTop: 3 },
  alertEdit: { fontSize: 14, color: SEMANTIC.onBgDim },

  // ── Section card ──
  sectionCard: { marginHorizontal: 16, marginTop: 12, padding: 16, borderRadius: 16, backgroundColor: PALETTE.appSurface },
  sectionTitle: { fontSize: 15, fontWeight: '700', color: COLORS.text, marginBottom: 12 },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 },
  cardNumber: { fontSize: 14, color: COLORS.textSecondary, fontWeight: '700' },
  detailBadgeRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  detailBloomBadge: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, minWidth: 50, alignItems: 'center' },
  detailBloomBadgeText: { fontSize: 12, fontWeight: '800', color: '#ffffff', letterSpacing: 0.3 },
  detailBloomBadgePending: { paddingHorizontal: 10, paddingVertical: 4, borderRadius: 6, borderWidth: 1, borderStyle: 'dashed', borderColor: COLORS.border, backgroundColor: 'transparent' },
  detailBloomBadgePendingText: { fontSize: 11, fontWeight: '700', color: COLORS.textSecondary },
  detailCategoryChip: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: 4, borderWidth: 1, backgroundColor: 'transparent' },
  detailCategoryChipText: { fontSize: 10, fontWeight: '700', letterSpacing: 0.5 },
  detailRarityChip: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 4, borderWidth: 1, backgroundColor: 'transparent' },
  detailRarityChipText: { fontSize: 11, fontWeight: '800' },
  nameEN: { fontSize: 13, color: COLORS.text + '88', marginBottom: 12, fontStyle: 'italic' },
  infoRow: { flexDirection: 'row', marginBottom: 5 },
  infoLabel: { fontSize: 14, color: COLORS.textSecondary, marginRight: 6 },
  infoValue: { fontSize: 14, color: COLORS.text, flex: 1 },

  // Collection ownership widget
  collectionCard: { marginHorizontal: 16, marginTop: 12, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: COLORS.border, backgroundColor: PALETTE.appSurface, flexDirection: 'row', alignItems: 'center', gap: 12 },
  collectionCopy: { flex: 1, minWidth: 0 },
  collectionTitle: { color: COLORS.text, fontSize: 15, fontWeight: '700' },
  collectionVersion: { color: COLORS.textSecondary, fontSize: 11, marginTop: 3 },
  collectionControls: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  collectionButton: { width: 38, height: 38, borderRadius: 8, alignItems: 'center', justifyContent: 'center', backgroundColor: PALETTE.appElev, borderWidth: 1, borderColor: COLORS.border },
  collectionButtonText: { color: COLORS.text, fontSize: 18, fontWeight: '800' },
  collectionButtonDisabled: { color: COLORS.border },
  collectionQuantity: { minWidth: 24, color: COLORS.text, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  collectionRemove: { color: COLORS.error, fontSize: 12, fontWeight: '700' },

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

  // ── Action bar (Pen Mst3p) ──
  actionBar: {
    position: 'absolute', left: 0, right: 0, bottom: 0,
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingTop: 12, paddingBottom: 20,
    backgroundColor: 'rgba(10,10,19,0.95)',
  },
  actionBtnGhost: { flex: 1, minHeight: 48, borderRadius: 14, backgroundColor: 'rgba(255,255,255,0.06)', alignItems: 'center', justifyContent: 'center' },
  actionBtnGhostActive: { backgroundColor: 'rgba(255,77,157,0.14)' },
  actionBtnGhostText: { fontSize: 14, fontWeight: '700', color: SEMANTIC.onBg },
  actionBtnGhostTextActive: { color: PALETTE.accent },
  actionBtnPrimary: { flex: 1, minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  actionBtnPrimaryText: { fontSize: 14, fontWeight: '700', color: '#FFFFFF' },

  // Market data section
  marketBlock: { backgroundColor: COLORS.surfaceLight + '55', borderWidth: 1, borderColor: 'rgba(255,255,255,0.15)', borderRadius: 10, padding: 12, marginBottom: 10 },
  marketBlockTitle: { fontSize: 14, fontWeight: '700', color: COLORS.text, marginBottom: 8 },
  marketRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 4 },
  marketLabel: { fontSize: 13, color: COLORS.textSecondary, flex: 1, marginRight: 8 },
  marketValue: { fontSize: 14, fontWeight: '600', color: COLORS.text },
  marketValueStrong: { fontSize: 15, fontWeight: 'bold' },
  marketNote: { fontSize: 11, color: COLORS.textSecondary + '99', marginTop: 6, lineHeight: 16 },
  // Pen UhG5Z spread cells
  spreadRow: { flexDirection: 'row', gap: 8, marginTop: 4 },
  spreadCell: { flex: 1, gap: 4 },
  spreadCellLabel: { fontSize: 10.5, color: SEMANTIC.onBgDim },
  spreadCellValue: { fontSize: 15, fontWeight: '700', color: SEMANTIC.onBg },

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
