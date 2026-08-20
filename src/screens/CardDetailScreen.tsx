import React, { useState, useEffect, useMemo } from 'react';
import { View, Text, ScrollView, StyleSheet, Dimensions, TouchableOpacity, Image } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import { COLORS, convertPrice } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { openUrl } from '../utils/openUrl';
import { showAlert } from '../utils/platformAlert';
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
import { PriceTrend } from '../components/PriceTrend';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { buildPriceVersions, resolveVersionForCard } from '../utils/versionAlignment';
import { ownershipKey } from '../utils/deckRules';

const { width } = Dimensions.get('window');

const gradeLabels: Record<string, string> = { debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot' };
const typeLabels: Record<string, string> = { Oshi: '推し（主推卡）', Member: '成員', Support: '支援卡', Energy: '能量', Buzz: 'Buzz' };
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
  const collection = useDeckStore((state) => state.collection);
  const adjustOwned = useDeckStore((state) => state.adjustOwned);
  const setOwned = useDeckStore((state) => state.setOwned);

  if (!card) {
    return (
      <View style={styles.center}>
        <Text style={{ color: COLORS.text }}>無法載入卡牌資料</Text>
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
  const typeLabel = typeLabels[card.type] || card.type || '-';
  const skillsZhContainsJapanese = containsJapaneseKana(card.skillsZh);
  const displaySkills = preferredLanguage === 'zh'
    ? (skillsZhContainsJapanese ? (card.skillsJp || card.skillsZh) : (card.skillsZh || card.skillsJp))
    : (card.skillsJp || card.skillsZh);
  const skillsFallbackNote = preferredLanguage === 'zh' && skillsZhContainsJapanese && card.skillsJp
    ? '暫無中文翻譯'
    : undefined;

  const effects = card.effects || parseEffects(allKW);
  const colorNames = card.colorNames && card.colorNames.length > 0
    ? card.colorNames
    : (card.color ? (Array.isArray(card.color) ? card.color : [card.color]).filter(Boolean).map((c: string) => {
        const map: Record<string, string> = { white: '白', blue: '藍', green: '綠', red: '紅', purple: '紫', yellow: '黃', colorless: '無色', multicolor: '多色' };
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
    ? `🔔 到價提醒 ${formatInterval(cardAlerts[0])}（點擊編輯）`
    : cardAlerts.length > 1
      ? `🔔 已設定 ${cardAlerts.length} 個版本的到價提醒`
      : '🔕 設定到價提醒';

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
            <Text style={styles.fallbackHint}>點擊查看官方卡面 →</Text>
          </TouchableOpacity>
        )}
      </View>
      </View>
      <View style={isDesktop ? styles.rightCol : undefined}>

      {collectionVersion && (
        <View style={styles.collectionCard} testID="card-detail-collection">
          <View style={styles.collectionCopy}>
            <Text style={styles.collectionTitle}>收藏數量</Text>
            <Text style={styles.collectionVersion} numberOfLines={2}>{collectionVersion.name}</Text>
          </View>
          <View style={styles.collectionControls}>
            <TouchableOpacity
              style={styles.collectionButton}
              onPress={() => adjustOwned(id, collectionVersion.printing, -1)}
              disabled={ownedQuantity <= 0}
              accessibilityRole="button"
              accessibilityLabel={`收藏 -1 ${displayName}`}
              testID="card-detail-collection-dec"
            >
              <Text style={[styles.collectionButtonText, ownedQuantity <= 0 && styles.collectionButtonDisabled]}>－</Text>
            </TouchableOpacity>
            <Text style={styles.collectionQuantity} testID="card-detail-collection-qty">{ownedQuantity}</Text>
            <TouchableOpacity
              style={styles.collectionButton}
              onPress={() => adjustOwned(id, collectionVersion.printing, 1)}
              accessibilityRole="button"
              accessibilityLabel={`收藏 +1 ${displayName}`}
              testID="card-detail-collection-inc"
            >
              <Text style={styles.collectionButtonText}>＋</Text>
            </TouchableOpacity>
            {ownedQuantity > 0 && (
              <TouchableOpacity
                onPress={() => setOwned(id, collectionVersion.printing, 0)}
                accessibilityRole="button"
                accessibilityLabel={`移除收藏 ${displayName}`}
                testID="card-detail-collection-remove"
              >
                <Text style={styles.collectionRemove}>移除</Text>
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
            accessibilityLabel="設定到價提醒"
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
            {hasActualPrice ? '實際售價' : '暫無資料'}
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
                ? '👇 於下方「市場數據」可選擇版本，買賣差價與漲跌會隨選擇更新'
                : '👇 於下方「市場數據」可選擇版本，售價會隨選擇更新'}
            </Text>
          </View>
        ) : hasActualPrice ? (
          <><View style={styles.priceRow}>
          <Text style={styles.priceValue}>¥{actualPrice.toLocaleString()}</Text>
        </View>
        {(() => {
          const converted = convertPrice(actualPrice, preferredCurrency);
          return (
            <Text style={styles.priceNote}>💰 約 {converted.symbol}{converted.value?.toLocaleString()}（{preferredCurrency}）</Text>
          );
        })()}
        {priceName ? (
          <Text style={styles.priceNote}>📋 {priceName}</Text>
        ) : null}</>
        ) : (
          <Text style={styles.noPriceText}>暫無資料</Text>
        )}
        {/* 歷史走勢僅為卡號層級（追蹤單一版本），多版本卡無法歸屬到選中版本 → 不顯示以免混版（DIC-856）。
            價格趨勢圖屬預測類功能 → Store MVP 隱藏（DIC-908）。 */}
        {FEATURES.trendPrediction && !hasMultipleVariants ? <PriceTrend priceHistory={card.priceHistory || {}} /> : null}
        <TouchableOpacity style={styles.checkPriceBtn} onPress={() => openUrl(yuyuUrl)}>
          <Text style={styles.checkPriceBtnText}>🔍 查看遊々亭即時價格 →</Text>
        </TouchableOpacity>
      </View>

      {/* ====== TREND PREDICTION ====== */}
      {/* 趨勢預測基於卡號層級歷史（單一版本序列）。多版本卡無法歸屬到特定版本 → 隱藏，
          避免用別版走勢推薦本版（DIC-856：禁止跨版本推薦訊號）。
          漲跌預測 / trendScore / 信心度 / YT / 新聞情緒 → Store MVP 隱藏（DIC-908）。 */}
      {FEATURES.trendPrediction && !hasMultipleVariants && trend && (
        <View style={[styles.section, { backgroundColor: COLORS.surface }]}>
          <Text style={styles.sectionTitle}>📈 價格趨勢預測</Text>
          <PriceTrendBadge
            trend={trend.trend}
            score={trend.score}
            confidence={trend.confidence}
            compact={false}
          />
          {/* 各項因子貢獻 */}
          <View style={styles.componentSection}>
            <Text style={styles.componentTitle}>因子貢獻</Text>
            <View style={styles.componentRow}>
              <Text style={styles.componentLabel}>📊 價格趨勢 (60%)</Text>
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
              <Text style={styles.componentLabel}>📺 YT 訂閱 (20%)</Text>
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
              <Text style={styles.componentLabel}>📰 新聞情緒 (20%)</Text>
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
              基於 {trend.dataPoints} 天的價格資料
            </Text>
          </View>
        </View>
      )}

      {/* ====== CARD BASIC INFO ====== */}
      <View style={styles.section}>
        <View style={styles.headerRow}>
          <Text style={styles.cardNumber}>{id}</Text>
          <View style={[styles.rarityBadge, { backgroundColor: rarityColors[rarityKey] || '#6b7280' }]}>
            <Text style={styles.rarityText}>{gradeLabels[card.grade] || card.grade || rarityKey}</Text>
          </View>
        </View>

        <Text style={styles.nameJP}>{displayName}</Text>
        {displayNameSub ? <Text style={styles.nameTW}>{displayNameSub}</Text> : null}
        {nameEN && nameEN !== nameJP && nameEN !== nameZH && <Text style={styles.nameEN}>{nameEN}</Text>}

        {typeLabel && (
          <InfoRow label="類型" value={typeLabel} />
        )}
        {colorNames.length > 0 && (
          <InfoRow label="顏色" value={colorNames.join(' / ')} />
        )}
        {seriesNames.length > 0 && (
          <InfoRow label="系列" value={seriesNames.join(' / ')} />
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
          <Text style={styles.sectionTitle}>卡牌效果</Text>
          {effects.length > 0 ? (
            effects.map((kw: string, i: number) => (
              <View key={i} style={styles.effectBlock}>
                <Text style={styles.effectText}>{kw}</Text>
              </View>
            ))
          ) : (
            <Text style={styles.noEffectText}>
              推い卡為牌組「主推卡」代表，本身無效果文本。{'\n'}
              其能力由牌組中同名成員卡所表現。
            </Text>
          )}
        </View>
      )}

      {/* ====== SEARCH KEYWORDS ====== */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>搜尋關鍵字</Text>
        <View style={styles.tagWrap}>
          {nameJP && <Tag text={nameJP} />}
          {nameZH && <Tag text={nameZH} />}
          {tags.map((t: string, i: number) => <Tag key={`t${i}`} text={t} />)}
        </View>
      </View>

      {/* ====== EXTERNAL LINKS ====== */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>外部連結</Text>
        <LinkButton icon="🏛️" text="官方卡表" url={officialUrl} />
        <LinkButton icon="🏪" text="遊々亭（價格查詢）" url={yuyuUrl} />
        <LinkButton icon="🔄" text="Carousell 二手價格" url={`https://www.carousell.com.tw/search/?q=${encodeURIComponent(id)}`} />
      </View>

      {/* ====== 到價提醒 BUTTON ====== */}
      {FEATURES.watchlist && (
        <View style={styles.section}>
          <TouchableOpacity
            style={[styles.watchlistBtn, cardAlerts.length > 0 ? styles.watchlistBtnActive : null]}
            onPress={openAlertEditor}
            activeOpacity={0.85}
            accessibilityRole="button"
            accessibilityLabel="設定到價提醒"
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
  const hasAny = skills && (
    skills.oshiSkill || skills.spOshiSkill ||
    (skills.arts && skills.arts.length) ||
    (skills.keywords && skills.keywords.length) ||
    skills.abilityText
  );

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>🎯 技能說明</Text>
      {!hasAny ? (
        <Text style={styles.noSkillText}>此卡無技能資料</Text>
      ) : (
        <>
          {skills!.oshiSkill && (
            <SkillCard
              badge="推しスキル"
              badgeColor="#f59e0b"
              meta={skills!.oshiSkill.cost ? `ホロパワー ${skills!.oshiSkill.cost}` : undefined}
              name={skills!.oshiSkill.name}
              effect={skills!.oshiSkill.effect}
            />
          )}
          {skills!.spOshiSkill && (
            <SkillCard
              badge="SP推しスキル"
              badgeColor="#ef4444"
              meta={skills!.spOshiSkill.cost ? `ホロパワー ${skills!.spOshiSkill.cost}` : undefined}
              name={skills!.spOshiSkill.name}
              effect={skills!.spOshiSkill.effect}
            />
          )}
          {skills!.arts?.map((art, i) => (
            <SkillCard
              key={`art${i}`}
              badge="アーツ"
              badgeColor="#3b82f6"
              meta={[art.cost ? `${art.cost}` : '', art.damage ? `傷害 ${art.damage}` : ''].filter(Boolean).join('　')}
              name={art.name}
              effect={art.effect}
            />
          ))}
          {skills!.abilityText ? (
            <SkillCard badge="能力テキスト" badgeColor="#10b981" effect={skills!.abilityText} />
          ) : null}
          {skills!.keywords?.map((kw, i) => (
            <SkillCard key={`kw${i}`} badge={kw.label || 'キーワード'} effect={kw.effect} />
          ))}
          {fallbackNote ? <Text style={styles.skillFallbackNote}>{fallbackNote}</Text> : null}
        </>
      )}
    </View>
  );
}

// ─── Market data panel ────────────────────────────────
function formatCount(n?: number | null): string {
  if (n == null || typeof n !== 'number' || isNaN(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e8) return (n / 1e8).toFixed(2) + '億';
  if (abs >= 1e4) return (n / 1e4).toFixed(1) + '萬';
  return n.toLocaleString();
}

function MarketDataPanel({ card }: { card: any }) {
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
  const priceHistory = card?.priceHistory ?? null;

  const hasSpread = typeof sellPrice === 'number' && sellPrice > 0 && typeof buyPrice === 'number' && buyPrice > 0;

  // 漲跌判斷：近 7 日均價 vs 前 7 日均價，±3% 閾值 → up / down / flat
  let priceTrend: 'up' | 'down' | 'flat' | null = null;
  let priceChangePct: number | null = null;
  let recentAvg: number | null = null;
  let priorAvg: number | null = null;
  let latestHistoryValue: number | null = null;
  if (priceHistory != null && typeof priceHistory === 'object') {
    const entries = Object.entries(priceHistory)
      .map(([d, p]) => [d, Number(p)] as [string, number])
      .filter(([d, p]) => !isNaN(p) && p > 0 && !isNaN(Date.parse(d)))
      .sort((a, b) => a[0].localeCompare(b[0]));
    if (entries.length >= 1) latestHistoryValue = entries[entries.length - 1][1];
    if (entries.length >= 2) {
      const latestMs = Date.parse(entries[entries.length - 1][0]);
      const DAY_MS = 86400000;
      const recent: number[] = [];
      const prior: number[] = [];
      for (const [d, p] of entries) {
        const offsetDays = Math.round((latestMs - Date.parse(d)) / DAY_MS);
        if (offsetDays >= 0 && offsetDays <= 6) recent.push(p);
        else if (offsetDays >= 7 && offsetDays <= 13) prior.push(p);
      }
      if (recent.length > 0 && prior.length > 0) {
        recentAvg = recent.reduce((s, v) => s + v, 0) / recent.length;
        priorAvg = prior.reduce((s, v) => s + v, 0) / prior.length;
        if (priorAvg > 0) {
          priceChangePct = ((recentAvg - priorAvg) / priorAvg) * 100;
          priceTrend = priceChangePct >= 3 ? 'up' : priceChangePct <= -3 ? 'down' : 'flat';
        }
      }
    }
  }
  // priceHistory 只有卡號層級（實測僅追蹤單一版本序列），非各版本獨立。多版本卡無法把這段
  // 歷史精確歸屬到選中版本 → 一律不顯示漲跌（fail closed，禁止用近似值臆測本版走勢，DIC-856）。
  // 僅單一版本卡（歷史必屬該版本）才顯示。
  void latestHistoryValue;
  const hasHistory = priceTrend != null && !multiVersion;

  const spreadPct = hasSpread ? ((buyPrice - sellPrice) / sellPrice) * 100 : 0;
  const spreadUp = spreadPct >= 0;
  // 防呆：收購價超過選中版本賣價 10 倍幾乎必是版本對不上。與其顯示假暴利差價，寧可標示待確認。
  const isPriceReliable = !hasSpread || buyPrice <= sellPrice * 10;
  // 已對齊、有賣價，但此版本沒有對到收購價 → fail closed 明示「暫無」，不借別版價。
  const buyMissing = aligned && typeof sellPrice === 'number' && sellPrice > 0 && buyPrice == null;

  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>📊 市場數據</Text>

      {/* 版本選擇 — 對齊 rarity/パラレル/サイン 版，避免混版價格 */}
      {aligned && versionLabel ? (
        <Text style={styles.versionLabel}>
          價格對應版本：{versionLabel}{manualPick ? '（已手動選擇）' : ''}
        </Text>
      ) : null}
      {!aligned ? (
        <View style={styles.versionWarnBox}>
          <Text style={styles.versionWarnTitle}>⚠️ 版本待確認</Text>
          <Text style={styles.versionWarnText}>
            無法依此卡 rarity{displayRarity ? `「${displayRarity}」` : ''}唯一對齊價格版本（{resolution.reason}）。
            以下價格未分版，請先選擇實際版本再參考。
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
          <Text style={styles.marketBlockTitle}>💱 買賣差價（{versionLabel}）</Text>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>買入成本（遊々亭賣價）</Text>
            <Text style={styles.marketValue}>¥{sellPrice.toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>賣出可得（店家收購）</Text>
            <Text style={styles.marketValue}>¥{buyPrice.toLocaleString()}</Text>
          </View>
          {isPriceReliable ? (
            <View style={styles.marketRow}>
              <Text style={styles.marketLabel}>差價</Text>
              <Text style={[styles.marketValueStrong, { color: spreadUp ? '#10b981' : '#ef4444' }]}>
                {spreadUp ? '+' : ''}{spreadPct.toFixed(1)}%（¥{(buyPrice - sellPrice).toLocaleString()}）
              </Text>
            </View>
          ) : (
            <Text style={[styles.marketValueStrong, { color: '#f59e0b' }]}>
              ⚠️ 價格待確認
            </Text>
          )}
          <Text style={styles.marketNote}>※ 買入賣出價均為此版本（{versionLabel}）資料</Text>
        </View>
      ) : buyMissing ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>💱 買賣差價（{versionLabel}）</Text>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>買入成本（遊々亭賣價）</Text>
            <Text style={styles.marketValue}>¥{sellPrice.toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>賣出可得（店家收購）</Text>
            <Text style={[styles.marketValue, { color: COLORS.textSecondary }]}>此版本暫無收購價</Text>
          </View>
          <Text style={styles.marketNote}>※ 此版本無對應店家收購價；不借用其他版本價格計算差價</Text>
        </View>
      ) : null)}

      {/* YouTube 成員數據 / 訂閱・觀看成長 — Store MVP 隱藏（DIC-908） */}
      {FEATURES.ytStats && (
      <View style={styles.marketBlock}>
        <Text style={styles.marketBlockTitle}>📺 YouTube 成員數據</Text>
        <View style={styles.marketRow}>
          <Text style={styles.marketLabel}>訂閱數</Text>
          <Text style={styles.marketValue}>{formatCount(ytStats?.subscriberCount)}</Text>
        </View>
        <View style={styles.marketRow}>
          <Text style={styles.marketLabel}>總觀看數</Text>
          <Text style={styles.marketValue}>{formatCount(ytStats?.totalViewCount)}</Text>
        </View>
        {ytStats?.growth_1d != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>單日成長</Text>
            <Text style={[styles.marketValue, { color: ytStats.growth_1d >= 0 ? '#10b981' : '#ef4444' }]}>
              {ytStats.growth_1d >= 0 ? '+' : ''}{formatCount(ytStats.growth_1d)}
            </Text>
          </View>
        ) : null}
        {ytStats?.growth_7d != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>7 日成長</Text>
            <Text style={[styles.marketValue, { color: ytStats.growth_7d >= 0 ? '#10b981' : '#ef4444' }]}>
              {ytStats.growth_7d >= 0 ? '+' : ''}{formatCount(ytStats.growth_7d)}
            </Text>
          </View>
        ) : null}
        {ytStats?.viewCount_daily != null ? (
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>單日觀看</Text>
            <Text style={styles.marketValue}>{formatCount(ytStats.viewCount_daily)}</Text>
          </View>
        ) : null}
      </View>
      )}

      {/* 漲跌判斷 — 僅在歷史代表目前選中版本時顯示；漲跌預測 → Store MVP 隱藏（DIC-908） */}
      {FEATURES.trendPrediction && (hasHistory ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>
            {priceTrend === 'up' ? '📈' : priceTrend === 'down' ? '📉' : '➖'} 漲跌判斷（{versionLabel}）
          </Text>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>前 7 日均價</Text>
            <Text style={styles.marketValue}>¥{Math.round(priorAvg!).toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>近 7 日均價</Text>
            <Text style={styles.marketValue}>¥{Math.round(recentAvg!).toLocaleString()}</Text>
          </View>
          <View style={styles.marketRow}>
            <Text style={styles.marketLabel}>變化</Text>
            <Text style={[styles.marketValueStrong, { color: priceTrend === 'up' ? '#10b981' : priceTrend === 'down' ? '#ef4444' : '#6b7280' }]}>
              {priceTrend === 'up' ? '▲' : priceTrend === 'down' ? '▼' : '▬'} {priceChangePct! >= 0 ? '+' : ''}{priceChangePct!.toFixed(1)}%
            </Text>
          </View>
        </View>
      ) : aligned && priceTrend != null ? (
        <View style={styles.marketBlock}>
          <Text style={styles.marketBlockTitle}>➖ 漲跌判斷</Text>
          <Text style={styles.marketNote}>
            此版本（{versionLabel}）暫無歷史均價：多版本卡的歷史為卡號層級、無法精確歸屬到單一版本，故不顯示以免混版。
          </Text>
        </View>
      ) : null)}
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
