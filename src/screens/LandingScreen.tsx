/**
 * LandingScreen — Pen artifact `holohunter-landing-v2.pen` production impl.
 *
 * DIC-1409 Phase 7 restores full visual parity with the canonical Pen
 * frames `XwzSU` (Desktop Landing 1440) and `D2SGVB` (Mobile Landing 390)
 * from `docs/pen-v2/holohunter-landing-v2-updated.pen`, fixing the exact
 * regressions the issue names: Hero composition (tilted card trio +
 * radial glow + floating legality/price chips, Pen `z5AkG`), depth/glow,
 * price visuals (chart card `N8ds5T`, not text rows), search mockup
 * (bento `hUcaS`), deck panel (`voo0h`), CTA treatment (gradient pill +
 * dark Google pill), type scale and section whitespace.
 *
 * All auth wiring is real: guest + Google CTAs drive `useAuthStore`
 * (loading / error states included), legal links open the shipped
 * static pages. Copy follows the reviewed truthful strings where the Pen
 * artifact's marketing copy would overclaim (sync qualifiers, free-plan
 * feature list, FAQ answers) — the same precedent Phase 6 set for Login.
 *
 * Tokens come from the shared `tokensV2` system (Pen variables). Web
 * builds add CSS gradients via react-native-web's `backgroundImage`
 * pass-through; native falls back to the gradient's dominant colour, the
 * same pattern the shell uses for `GRADIENTS`.
 */
import React, { useCallback, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  ActivityIndicator,
  ScrollView,
  SafeAreaView,
  Linking,
  Image,
  Platform,
} from 'react-native';

// Pen `z5AkG` hero card trio — image fills anchored to specific catalog
// printings (Card Left `uR7Wd` → hBP01-023, Card Center `ntKk3` →
// hBP01-081, Card Right `LFnFH` → hBP02-013). Bundled so the Landing
// fires no external image request (privacy-policy contract).
import HeroCardPrimary from '../../assets/landing-cards/hBP01-023_UR.jpg';
import HeroCardSecondary from '../../assets/landing-cards/hBP01-081_UR.jpg';
import HeroCardTertiary from '../../assets/landing-cards/hBP02-013_UR.jpg';
import { useAuthStore } from '../store/authStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { PALETTE, FONTS, LAYOUT } from '../theme/tokensV2';

const HERO_CARD_ART = {
  primary: HeroCardPrimary,
  secondary: HeroCardSecondary,
  tertiary: HeroCardTertiary,
} as const;
export const HERO_CARD_ART_PEN_FILENAMES = {
  primary: 'hBP01-023_UR',
  secondary: 'hBP01-081_UR',
  tertiary: 'hBP02-013_UR',
} as const;

const T = PALETTE;
const displayFont = Platform.OS === 'web' ? FONTS.display : undefined;
const bodyFont = Platform.OS === 'web' ? FONTS.body : undefined;

// react-native-web passes `backgroundImage` through to CSS; native gets
// the gradient's dominant colour (shell `GRADIENTS` precedent).
const webGradient = (css: string, fallback: string) =>
  Platform.OS === 'web'
    ? ({ backgroundColor: fallback, backgroundImage: css } as const)
    : ({ backgroundColor: fallback } as const);

const GRAD = {
  ctaPill: webGradient(`linear-gradient(90deg, ${T.accent} 0%, #C36BFF 100%)`, T.accent),
  brandTile: webGradient(`linear-gradient(135deg, ${T.accent} 0%, ${T.accent3} 100%)`, T.accent),
  heroGlow: webGradient(
    `radial-gradient(42% 46% at 74% 42%, rgba(61,224,255,0.14) 0%, rgba(61,224,255,0) 100%),` +
      `radial-gradient(40% 42% at 12% 78%, rgba(255,77,157,0.16) 0%, rgba(255,77,157,0) 100%),` +
      `radial-gradient(36% 40% at 88% 82%, rgba(139,92,246,0.14) 0%, rgba(139,92,246,0) 100%)`,
    T.bg,
  ),
  chartBarHot: webGradient(`linear-gradient(180deg, #FF8AC2 0%, ${T.accent} 100%)`, T.accent),
  finalCta: webGradient(
    `radial-gradient(60% 90% at 8% 12%, rgba(61,224,255,0.22) 0%, rgba(61,224,255,0) 100%),` +
      `radial-gradient(70% 110% at 92% 18%, rgba(139,92,246,0.35) 0%, rgba(139,92,246,0) 100%),` +
      `radial-gradient(85% 120% at 55% 118%, rgba(255,77,157,0.42) 0%, rgba(255,77,157,0) 100%)`,
    T.surface,
  ),
  subCardTint: webGradient(
    `radial-gradient(80% 80% at 88% 0%, rgba(255,77,157,0.14) 0%, rgba(255,77,157,0) 100%)`,
    T.surface,
  ),
  bentoCyanTint: webGradient(
    `radial-gradient(90% 90% at 88% 10%, rgba(61,224,255,0.10) 0%, rgba(61,224,255,0) 100%)`,
    T.surface,
  ),
  bentoPurpleTint: webGradient(
    `radial-gradient(90% 90% at 88% 10%, rgba(139,92,246,0.12) 0%, rgba(139,92,246,0) 100%)`,
    T.surface,
  ),
} as const;

const NAV_LINKS = ['卡牌查詢', '掃描估值', '牌組編輯器', '賽事月報', '規則教學'];

// Pen `vfBpS` (desktop) / `ufjjN` (mobile) Stats Bar — flat columns, no
// card chrome (the bordered stat cards were a Pen-conformance regression).
const STATS = [
  { value: '36', label: '個收錄系列', mobileLabel: '個收錄系列' },
  { value: '中 / 日', label: '介面與卡名雙語', mobileLabel: '雙語卡名' },
  { value: 'NT$ · ¥ · $', label: '三種幣別固定匯率換算', mobileLabel: '三幣別(固定)' },
  { value: '8 章', label: '規則教學 + 模擬實戰', mobileLabel: '規則教學' },
];

// Pen `GAolm` bento (desktop) / `p7scMD` list (mobile). The search card
// (`hUcaS` first cell) renders the Pen search mockup; the other five map
// to Pen's icon-tile cards. Glyph-in-tinted-tile follows the shell's
// established icon treatment (HomeScreen quick actions).
const FEATURES = [
  {
    key: 'scan',
    glyph: '⌖',
    tint: T.accent2,
    gradient: GRAD.bentoCyanTint,
    title: '拍照辨識，順便估值',
    body: '對著卡片拍一張就辨識卡號與版本，連續掃完一盒後直接給你整份估值清單與總計。',
  },
  {
    key: 'watchlist',
    glyph: '◔',
    tint: T.accent3,
    gradient: GRAD.bentoPurpleTint,
    title: '只比對你指定的那一版',
    body: '到價提醒鎖定精確版本與價格區間，價格進區間時推播一次。',
  },
  {
    key: 'deck',
    glyph: '❖',
    tint: T.accent,
    gradient: null,
    title: '牌組編輯器',
    body: '邊組邊檢查 50 張主牌組與同名張數限制，未達標會列出缺哪幾張，並直接算出缺卡預估總額。',
  },
  {
    key: 'tournament',
    glyph: '◍',
    tint: T.accent2,
    gradient: null,
    title: '賽事月報',
    body: '彙整已公開的精選賽事牌組，統計熱門牌型與顏色分布，看上眼的牌組可一鍵匯入編輯器。',
  },
  {
    key: 'tutorial',
    glyph: '✦',
    tint: T.accent3,
    gradient: null,
    title: '規則教學與模擬戰',
    body: '8 章教學從遊戲簡介講到比賽流程，再跟著 step-by-step 引導打一場簡化對局。',
  },
] as const;

const SEARCH_MOCK_CHIPS: ReadonlyArray<{ label: string; active?: boolean; outlined?: boolean }> = [
  { label: '藍', active: true },
  { label: 'Holomen', outlined: true },
  { label: 'hBP04' },
  { label: '有平行版' },
  { label: 'SR 以上' },
];

// Pen `N8ds5T` price chart card — 13 bars, the newest highlighted with
// the value label. Static marketing content straight from the Pen frame
// (the Landing renders before any API session exists).
const CHART_BARS = [0.42, 0.5, 0.45, 0.55, 0.52, 0.63, 0.66, 0.6, 0.72, 0.68, 0.8, 0.76, 1] as const;
const CHART_X_LABELS = ['6/09', '6/16', '6/23', '6/30', '7/07'] as const;
const SPARK_BARS = [10, 14, 12, 16, 15, 19, 18, 22, 21, 26, 24, 29, 27, 31] as const;

// Pen `voo0h` deck-builder panel rows (colour tokens `$accent` /
// `$accent-3` / `$accent-2` / `$c-yellow` per the Pen progress bars).
const DECK_ROWS = [
  { name: '白上フブキ hBP02-012 / SR', have: 2, need: 4, color: T.accent },
  { name: '白上フブキ hBP02-013 / RR', have: 1, need: 2, color: T.accent3 },
  { name: 'ときのそら hBP01-021 / C', have: 3, need: 4, color: T.accent2 },
  { name: 'ブルームエール ×20', have: 18, need: 20, color: T.cYellow },
] as const;

const DECK_BULLETS = [
  '主牌組 / エール 張數與同名限制檢查',
  '缺卡預估總額，可切換幣別',
  '從賽事月報一鍵匯入牌組',
] as const;

const PRICE_BULLETS = [
  '前 7 日 vs 近 7 日均價比較',
  '買入成本 · 賣出可得（買賣差價即將推出）',
  '多版本分開計價，不混版',
] as const;

// Reviewed truthful free-plan list (the Pen desktop list would overclaim
// 買賣差價/趨勢預測, both 即將推出) — kept per the Phase 6 copy precedent.
const FREE_FEATURES = [
  '全部卡表檢索與篩選',
  '市場價格與 7D/30D/90D 歷史',
  '收藏、牌組編輯器與缺卡預估',
  '賽事月報、規則教學與模擬戰',
  '每月 100 次卡片辨識掃描',
];

const COMING_SOON_FEATURES = [
  '免費會員的全部功能',
  '訂閱與 App 內購（即將推出）',
  '上線時會在此揭露方案內容與計費地區',
];

const HOW_IT_WORKS = [
  { step: '01', tint: T.accent, title: '先逛或先登入', body: '訪客就能查卡、讀規則與跑模擬戰。登入後才開放掃描與收藏；跨裝置同步為即將推出。' },
  { step: '02', tint: T.accent3, title: '掃描或搜尋建卡表', body: '對著卡片拍照就辨識卡號與版本，也可以直接搜卡名或卡號。連續掃完一盒會給你整份估值清單與總計。' },
  { step: '03', tint: T.accent2, title: '組牌並盯價', body: '在編輯器組牌、看缺卡預估總額，再對想補的卡指定版本與價格區間，價格進區間時推播通知你。' },
] as const;

// Reviewed truthful FAQ copy (unchanged from the accepted DIC-1380 W6
// pass) presented in the Pen accordion composition.
const FAQ = [
  {
    q: '需要付費才能使用嗎？',
    a: 'HoloHunter 目前所有查詢、收藏、組牌、賽事月報與規則教學都是免費。每月 100 次卡片辨識掃描亦包含在免費會員內。訂閱與 App 內購尚未開放；未來付費方案上線時會透過 App Store / Google Play / Stripe 的既有金流處理，金額透過 Store API 動態載入。',
  },
  {
    q: '沒有帳號可以先試用嗎？',
    a: '可以。以訪客身份直接進入即可使用卡表檢索、規則教學、模擬對局與牌組編輯器；拍照掃描需登入 Google 或 Apple 帳號。收藏、牌組與到價提醒目前在 Store MVP 版本上為本機儲存，不會發出 /api/auth/sync 請求；未來啟用同步功能的建構會在登入後把上述資料同步到雲端。',
  },
  {
    q: '卡牌影像會被上傳到伺服器嗎？',
    a: '手機 App：文字辨識在本機完成，卡牌影像不會離開您的裝置。網頁版：影像會傳送到伺服器端點，交由 Google Gemini 即時辨識，辨識後不作長期儲存。詳見隱私權政策。',
  },
  {
    q: 'iOS / Android / 網頁版功能一致嗎？',
    a: '介面與資料一致；掃描辨識的實作因平台不同（手機用裝置端 OCR、網頁用 AI 視覺辨識）。跨裝置同步僅在啟用 /api/auth/sync binding 的建構（Web Develop／Staging 或未來 feature flag 打開）上運作；Store MVP 上架版本目前為裝置本機儲存。',
  },
];

const LEGAL = {
  terms: 'https://holohunter.dicoge.com/terms.html',
  privacy: 'https://holohunter.dicoge.com/privacy.html',
  pricing: 'https://holohunter.dicoge.com/pricing.html',
  support: 'https://holohunter.dicoge.com/support.html',
} as const;

const openUrl = (url: string) => Linking.openURL(url).catch(() => {});

function SectionPill({ text, tint }: { text: string; tint: string }) {
  return (
    <View style={[styles.sectionPill, { borderColor: `${tint}59`, backgroundColor: `${tint}1F` }]}>
      <Text style={[styles.sectionPillText, { color: tint }]}>{text}</Text>
    </View>
  );
}

function ComingSoonPill({ text }: { text: string }) {
  return (
    <View style={styles.comingSoonPill} accessibilityRole="text">
      <Text style={styles.comingSoonPillText}>{text}</Text>
    </View>
  );
}

function CheckRow({ text, tint }: { text: string; tint: string }) {
  return (
    <View style={styles.checkRow}>
      <View style={[styles.checkDot, { borderColor: `${tint}66` }]}>
        <Text style={[styles.checkGlyph, { color: tint }]}>✓</Text>
      </View>
      <Text style={styles.checkText}>{text}</Text>
    </View>
  );
}

function Sparkline({ compact }: { compact?: boolean }) {
  return (
    <View style={[styles.sparkline, compact && styles.sparklineCompact]} testID="landing-hero-sparkline">
      {SPARK_BARS.map((h, i) => (
        <View key={i} style={[styles.sparkBar, { height: compact ? h * 0.8 : h }]} />
      ))}
    </View>
  );
}

// Pen floating hero chip `星街すいせい UR · 近 7 日均價` — shared between the
// desktop hero overlay and the mobile hero card.
function HeroPriceChip({ mobile }: { mobile?: boolean }) {
  return (
    <View
      style={[styles.heroPriceChip, mobile ? styles.heroPriceChipMobile : styles.heroPriceChipFloating]}
      testID="landing-hero-price-chip"
    >
      <Text style={styles.heroChipLabel}>星街すいせい UR · 近 7 日均價</Text>
      <View style={styles.heroPriceRow}>
        <Text style={styles.heroPriceValue}>NT$ 3,600</Text>
        <View style={styles.deltaChip}>
          <Text style={styles.deltaChipText}>↗ 12.4%</Text>
        </View>
        {!mobile && <Sparkline compact />}
      </View>
      {mobile && <Sparkline />}
      {mobile && <Text style={styles.heroChipSource}>資料來源：遊々亭 · 固定匯率換算</Text>}
    </View>
  );
}

function PriceChartCard({ desktop }: { desktop: boolean }) {
  const chartHeight = desktop ? 180 : 120;
  return (
    <View style={[styles.chartCard, desktop && styles.chartCardDesktop]} testID="landing-price-chart">
      <View style={styles.chartHeader}>
        <Image
          source={HERO_CARD_ART.secondary}
          resizeMode="cover"
          style={styles.chartThumb}
          accessibilityRole="image"
          accessibilityLabel="hBP01-081 UR 星街すいせい"
        />
        <View style={styles.chartHeaderCopy}>
          <Text style={styles.chartTitle} numberOfLines={1}>星街すいせい / UR</Text>
          <Text style={styles.chartSubtitle} numberOfLines={1}>hBP01-081 · 遊々亭 參考售價</Text>
        </View>
        <View style={styles.timeframes} testID="landing-price-timeframes">
          {(['7D', '30D', '90D'] as const).map((tf) => {
            const active = desktop ? tf === '30D' : tf === '7D';
            return (
              <View key={tf} style={[styles.timeframe, active && styles.timeframeActive]}>
                <Text style={[styles.timeframeText, active && styles.timeframeTextActive]}>{tf}</Text>
              </View>
            );
          })}
        </View>
      </View>
      <View style={styles.chartPriceRow}>
        <Text style={[styles.chartPrice, desktop && styles.chartPriceDesktop]}>NT$ 3,600</Text>
        <View style={styles.deltaChip}>
          <Text style={styles.deltaChipText}>↗ +12.4% 對比前 7 日</Text>
        </View>
      </View>
      <View style={[styles.chartBars, { height: chartHeight + 22 }]}>
        {CHART_BARS.map((ratio, i) => {
          const hot = i === CHART_BARS.length - 1;
          return (
            <View key={i} style={styles.chartBarSlot}>
              {hot && <Text style={styles.chartBarValue}>3,600</Text>}
              <View
                style={[
                  styles.chartBar,
                  { height: Math.round(ratio * chartHeight) },
                  hot ? GRAD.chartBarHot : null,
                ]}
              />
            </View>
          );
        })}
      </View>
      <View style={styles.chartXAxis}>
        {CHART_X_LABELS.map((l) => (
          <Text key={l} style={styles.chartXLabel}>{l}</Text>
        ))}
      </View>
      {desktop ? (
        <View style={styles.chartCells}>
          <View style={styles.chartCell}>
            <Text style={styles.chartCellLabel}>買入成本</Text>
            <Text style={styles.chartCellValue}>NT$ 3,600</Text>
          </View>
          <View style={[styles.chartCell, styles.chartCellComing]} testID="landing-price-coming-buyback">
            <Text style={styles.chartCellLabelComing}>店家收購</Text>
            <Text style={styles.chartCellComingValue}>即將推出</Text>
          </View>
          <View style={[styles.chartCell, styles.chartCellComing]} testID="landing-price-coming-spread">
            <Text style={styles.chartCellLabelComing}>買賣差價</Text>
            <Text style={styles.chartCellComingValue}>即將推出</Text>
          </View>
        </View>
      ) : (
        <View style={styles.chartCellsMobile}>
          <View style={styles.chartRowMobile}>
            <Text style={styles.chartCellLabel}>買入成本（遊々亭參考售價）</Text>
            <Text style={styles.chartCellValue}>NT$ 3,600</Text>
          </View>
          <View style={[styles.chartRowMobile, styles.chartRowMobileComing]} testID="landing-price-coming-buyback">
            <Text style={styles.chartCellLabelComing}>店家收購</Text>
            <Text style={styles.chartCellComingValue}>即將推出</Text>
          </View>
          <View style={[styles.chartRowMobile, styles.chartRowMobileComing]} testID="landing-price-coming-forecast">
            <Text style={styles.chartCellLabelComing}>價格趨勢預測</Text>
            <Text style={styles.chartCellComingValue}>即將推出</Text>
          </View>
        </View>
      )}
      {desktop && (
        <View style={styles.chartFootnote} testID="landing-price-coming-forecast">
          <Text style={styles.chartFootnoteTitle}>價格趨勢預測（即將推出）</Text>
          <Text style={styles.chartFootnoteBody} numberOfLines={2}>
            上線後將依公開因子與資料範圍，不會用未上線的預測值取代實際成交價。
          </Text>
        </View>
      )}
    </View>
  );
}

function DeckPanel({ desktop }: { desktop: boolean }) {
  return (
    <View style={[styles.deckPanel, desktop && styles.deckPanelDesktop]} testID="landing-deck-panel">
      <View style={styles.deckHeader}>
        <View style={styles.deckHeaderCopy}>
          <Text style={styles.deckTitle}>白上フブキ Buzz</Text>
          <View style={styles.deckDraftRow}>
            <View style={styles.deckDraftPill}><Text style={styles.deckDraftPillText}>草稿</Text></View>
            <Text style={styles.deckSubtitle}>尚未完成，還有 2 項需要調整</Text>
          </View>
        </View>
        <View style={styles.deckEstimate}>
          <Text style={styles.deckEstimateLabel}>缺卡預估總額</Text>
          <Text style={styles.deckEstimateValue}>NT$ 2,140</Text>
        </View>
      </View>
      <View style={styles.deckRows}>
        {DECK_ROWS.map((row) => (
          <View key={row.name} style={styles.deckRow} testID={`landing-deck-row-${row.name}`}>
            <View style={styles.deckRowTop}>
              <Text style={styles.deckRowName} numberOfLines={1}>{row.name}</Text>
              <Text style={styles.deckRowCount}>有 {row.have} / 需 {row.need}</Text>
            </View>
            <View style={styles.deckTrack}>
              <View
                style={[
                  styles.deckFill,
                  { width: `${Math.round((row.have / row.need) * 100)}%`, backgroundColor: row.color },
                ]}
              />
            </View>
          </View>
        ))}
      </View>
      <View style={styles.deckDivider} />
      <View style={styles.deckMissingRow}>
        <Text style={styles.deckMissingTitle}>還缺的 7 張</Text>
        <Text style={styles.deckCheapLink}>套用低價版本 ⚒</Text>
      </View>
      <View style={styles.deckTiles}>
        {Array.from({ length: desktop ? 9 : 4 }).map((_, i) => (
          <View key={i} style={styles.deckTile}><Text style={styles.deckTilePlus}>＋</Text></View>
        ))}
      </View>
    </View>
  );
}

export default function LandingScreen() {
  const { width, isWide } = useBreakpoint();
  const isDesktop = width >= 768;
  // Pen `z5AkG` lays the tilted trio on a fixed 640×560 canvas; scale it
  // down proportionally between 768 and 1440 so nothing clips.
  const heroVisualScale = Math.min(1, Math.max(0.52, (width * 0.46) / 640));
  const { continueAsGuest, loginWithGoogle, isLoading, error, clearError } = useAuthStore();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  // Pen FAQ accordion — desktop opens the first item (frame `VfmUx`),
  // mobile shows every answer (frame `QNfNX`). Real expand/collapse state.
  const [faqOpen, setFaqOpen] = useState<boolean[]>(() => FAQ.map((_, i) => (width >= 768 ? i === 0 : true)));
  const toggleFaq = useCallback((i: number) => {
    setFaqOpen((prev) => prev.map((open, j) => (j === i ? !open : open)));
  }, []);

  const handleGuest = useCallback(async () => {
    try { await continueAsGuest(); } catch {}
  }, [continueAsGuest]);

  // Google login rides the same fail-closed OAuth-provisioning flow as
  // the rest of the app: tapping the "coming soon" CTA still calls
  // `loginWithGoogle()` — provisioned providers work, unprovisioned ones
  // surface the auth store's friendly error.
  const handleGoogle = useCallback(async () => {
    try { await loginWithGoogle(); } catch {}
  }, [loginWithGoogle]);

  const eyebrow = isDesktop
    ? '非官方工具 · 介面與卡名支援中文 / 日本語'
    : 'hOCG · 非官方查詢工具 · 支援中日文';

  const noteText = isDesktop
    ? '訪客可查卡與看規則 · 掃描與本機收藏需登入（Google 登入即將推出；跨裝置同步僅限啟用同步的建構）'
    : '訪客可查卡與看規則 · 掃描與本機收藏需登入（Google／Apple 登入即將推出；跨裝置同步僅限啟用同步的建構）';

  const googleCtaLabel = isDesktop ? '使用 Google 帳號開始（即將推出）' : '⧖  使用 Google 帳號（即將推出）';

  return (
    <SafeAreaView style={styles.container} testID="landing-screen">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* NAV — Pen `avS3j` desktop / `bDwDO` mobile */}
        <View style={[styles.nav, isDesktop && styles.navDesktop]} testID="landing-nav">
          <View style={styles.navBrand}>
            <View style={[styles.brandMark, GRAD.brandTile]}>
              <Text style={styles.brandMarkGlyph}>✦</Text>
            </View>
            <Text style={styles.brandText}>HoloHunter</Text>
          </View>
          {isDesktop ? (
            <>
              {isWide && (
                <View style={styles.navLinks} testID="landing-nav-links">
                  {NAV_LINKS.map((link) => (
                    <TouchableOpacity key={link} style={styles.navLinkTap} accessibilityRole="link" onPress={handleGuest}>
                      <Text style={styles.navLink}>{link}</Text>
                    </TouchableOpacity>
                  ))}
                </View>
              )}
              <View style={styles.navActions}>
                <TouchableOpacity
                  style={styles.navGuestLink}
                  onPress={handleGuest}
                  disabled={isLoading}
                  accessibilityRole="link"
                  testID="landing-nav-guest"
                >
                  <Text style={styles.navGuestLinkText}>訪客進入</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.navCta}
                  onPress={handleGoogle}
                  disabled={isLoading}
                  accessibilityRole="button"
                  testID="landing-nav-cta"
                >
                  {isLoading ? (
                    <ActivityIndicator color={T.bg} size="small" />
                  ) : (
                    <Text style={styles.navCtaText}>登入</Text>
                  )}
                </TouchableOpacity>
              </View>
            </>
          ) : (
            <TouchableOpacity
              style={styles.mobileMenuBtn}
              onPress={() => setMobileMenuOpen((v) => !v)}
              accessibilityRole="button"
              accessibilityLabel="開啟導覽選單"
              testID="landing-mobile-menu-btn"
            >
              <Text style={styles.mobileMenuIcon}>{mobileMenuOpen ? '×' : '≡'}</Text>
            </TouchableOpacity>
          )}
        </View>

        {mobileMenuOpen && !isDesktop && (
          <View style={styles.mobileMenu} testID="landing-mobile-menu">
            {NAV_LINKS.map((link) => (
              <TouchableOpacity key={link} style={styles.mobileMenuItem} onPress={handleGuest}>
                <Text style={styles.mobileMenuItemText}>{link}</Text>
              </TouchableOpacity>
            ))}
          </View>
        )}

        {/* HERO — Pen `Rlx6E` desktop / `LX2IZ` mobile, radial glow backdrop */}
        <View
          style={[styles.section, styles.hero, GRAD.heroGlow, isDesktop && styles.heroDesktop]}
          testID="landing-hero"
        >
          <View style={styles.heroCopy}>
            <View style={styles.eyebrowPill}>
              <View style={[styles.eyebrowBadge, GRAD.ctaPill]}>
                <Text style={styles.eyebrowBadgeText}>hOCG</Text>
              </View>
              <Text style={styles.pillText} numberOfLines={2}>{eyebrow}</Text>
            </View>
            <Text style={[styles.headline, isDesktop && styles.headlineDesktop]} testID="landing-headline">
              查得到效果，{'\n'}也查得到現在值多少
            </Text>
            <Text style={styles.subhead} testID="landing-subhead">
              hololive OFFICIAL CARD GAME 的非官方查詢工具。卡表檢索、遊々亭參考行情、拍照估值、牌組合法性檢查、8 章規則教學都在同一個地方。
            </Text>
            <View style={[styles.ctaRow, isDesktop && styles.ctaRowDesktop]} testID="landing-cta-row">
              <TouchableOpacity
                style={[styles.ctaPrimary, GRAD.ctaPill, isLoading && styles.ctaDisabled]}
                onPress={handleGuest}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-cta-guest"
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.ctaPrimaryText}>以訪客登入{isDesktop ? '  →' : ''}</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.ctaGoogle}
                onPress={handleGoogle}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-cta-google"
              >
                {isDesktop && (
                  <View style={styles.googleBadge}><Text style={styles.googleBadgeText}>G</Text></View>
                )}
                <Text style={styles.ctaGoogleText}>{googleCtaLabel}</Text>
              </TouchableOpacity>
            </View>
            <View style={styles.ctaNote} testID="landing-cta-note">
              <Text style={styles.ctaNoteIcon}>🛡</Text>
              <Text style={styles.ctaNoteText}>{noteText}</Text>
            </View>
            {error && (
              <View style={styles.errorBox}>
                <Text style={styles.errorText}>{error}</Text>
                <TouchableOpacity onPress={clearError}><Text style={styles.errorDismiss}>×</Text></TouchableOpacity>
              </View>
            )}
          </View>
          {isDesktop ? (
            <View
              style={[styles.heroVisual, { width: 640 * heroVisualScale, height: 560 * heroVisualScale }]}
              testID="landing-hero-visual"
            >
              <View style={[styles.heroVisualCanvas, { transform: [{ scale: heroVisualScale }] }]}>
              {/* Pen `z5AkG` — three tilted image cards over a glow bed,
                  with the floating legality + price chips. Card Left /
                  Center / Right carry the Pen-anchored image fills. */}
              <View style={[styles.heroCard, styles.heroCardLeft]} testID="landing-hero-card-primary">
                <Image
                  source={HERO_CARD_ART.primary}
                  resizeMode="cover"
                  style={styles.heroCardImg}
                  accessibilityRole="image"
                  accessibilityLabel="hBP01-023 UR ときのそら"
                  testID="landing-hero-cardart-primary-art"
                />
                <View style={styles.heroCardMeta}>
                  <Text style={styles.heroCardNumber}>hBP01-023</Text>
                  <View style={styles.rarityBadge}><Text style={styles.rarityBadgeText}>UR</Text></View>
                </View>
              </View>
              <View style={[styles.heroCard, styles.heroCardCenter]} testID="landing-hero-card-secondary">
                <Image
                  source={HERO_CARD_ART.secondary}
                  resizeMode="cover"
                  style={styles.heroCardImg}
                  accessibilityRole="image"
                  accessibilityLabel="hBP01-081 UR 星街すいせい"
                  testID="landing-hero-cardart-secondary-art"
                />
                <View style={styles.heroCardMeta}>
                  <Text style={styles.heroCardNumber}>hBP01-081</Text>
                  <View style={styles.rarityBadge}><Text style={styles.rarityBadgeText}>UR</Text></View>
                </View>
              </View>
              <View style={[styles.heroCard, styles.heroCardRight]} testID="landing-hero-card-tertiary">
                <Image
                  source={HERO_CARD_ART.tertiary}
                  resizeMode="cover"
                  style={styles.heroCardImg}
                  accessibilityRole="image"
                  accessibilityLabel="hBP02-013 UR 白上フブキ"
                  testID="landing-hero-cardart-tertiary-art"
                />
                <View style={styles.heroCardMeta}>
                  <Text style={styles.heroCardNumber}>hBP02-013</Text>
                  <View style={styles.rarityBadge}><Text style={styles.rarityBadgeText}>UR</Text></View>
                </View>
              </View>
              <View style={styles.legalityChip} testID="landing-hero-legality">
                <View style={styles.legalityRing} />
                <View>
                  <Text style={styles.heroChipLabel}>主牌組合法性</Text>
                  <Text style={styles.legalityValue}>43 / 50 · 還缺 7 張</Text>
                </View>
              </View>
              <HeroPriceChip />
              </View>
            </View>
          ) : (
            <HeroPriceChip mobile />
          )}
        </View>

        {/* STATS BAR — Pen `vfBpS` / `ufjjN`: flat columns, no card chrome */}
        <View style={[styles.statsBar, isDesktop && styles.statsBarDesktop]} testID="landing-stats-bar">
          {STATS.map((s) => (
            <View key={s.label} style={styles.statCol} testID={`landing-stat-${s.label}`}>
              <Text style={[styles.statValue, isDesktop && styles.statValueDesktop]} numberOfLines={1}>{s.value}</Text>
              <Text style={styles.statLabel} numberOfLines={2}>{isDesktop ? s.label : s.mobileLabel}</Text>
            </View>
          ))}
        </View>

        {/* FEATURES — Pen `GAolm` bento / `r41z2` mobile list */}
        <View style={[styles.sectionBlock, isDesktop && styles.sectionBlockDesktop]} testID="landing-features">
          <View style={[styles.sectionHeader, isDesktop && styles.sectionHeaderLeft]}>
            <SectionPill text="App 功能" tint={T.accent} />
            <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
              從查一張卡，{'\n'}到帶一副牌組出門
            </Text>
            <Text style={styles.sectionSubhead}>
              HoloHunter 把卡表、行情、掃描、組牌與賽事資料接成一條動線，不用在拍賣網站、官方卡表和自己的試算表之間來回切換。
            </Text>
          </View>
          <View style={[styles.bento, isDesktop && styles.bentoDesktop]}>
            <View style={[styles.bentoRow, isDesktop && styles.bentoRowDesktop]}>
              {/* Search mockup card — Pen `hUcaS` first cell */}
              <View
                style={[styles.bentoCard, styles.searchCard, isDesktop && styles.searchCardDesktop]}
                testID="landing-feature-search-mockup"
              >
                <Text style={styles.bentoTitle}>八個條件疊加的卡牌檢索</Text>
                <Text style={styles.bentoBody}>
                  卡名、卡號、效果內文全文檢索，再疊加卡牌種類、顏色、稀有度、收錄彈數與異圖／平行篩選。中日文卡名都能搜。
                </Text>
                <View style={styles.searchMockBox}>
                  <Text style={styles.searchMockGlyph}>⌕</Text>
                  <Text style={styles.searchMockQuery}>すいせい</Text>
                  <Text style={styles.searchMockCaret}>|</Text>
                </View>
                <View style={styles.searchMockChips}>
                  {SEARCH_MOCK_CHIPS.map((chip) => (
                    <View
                      key={chip.label}
                      style={[
                        styles.searchChip,
                        chip.active && styles.searchChipActive,
                        chip.outlined && styles.searchChipOutlined,
                      ]}
                    >
                      <Text
                        style={[
                          styles.searchChipText,
                          chip.active && styles.searchChipTextActive,
                          chip.outlined && styles.searchChipTextOutlined,
                        ]}
                      >
                        {chip.label}
                      </Text>
                    </View>
                  ))}
                </View>
                <View style={styles.searchMockGrid}>
                  {Array.from({ length: 6 }).map((_, i) => (
                    <View key={i} style={styles.searchMockTile} />
                  ))}
                </View>
              </View>
              {isDesktop && (
                <View style={styles.bentoSide}>
                  {FEATURES.slice(0, 2).map((f) => (
                    <View
                      key={f.key}
                      style={[styles.bentoCard, styles.bentoSideCard, f.gradient]}
                      testID={`landing-feature-${f.title}`}
                    >
                      <View style={[styles.featureIconTile, { backgroundColor: `${f.tint}1F`, borderColor: `${f.tint}4D` }]}>
                        <Text style={[styles.featureIconGlyph, { color: f.tint }]}>{f.glyph}</Text>
                      </View>
                      <Text style={styles.bentoTitle}>{f.title}</Text>
                      <Text style={styles.bentoBody}>{f.body}</Text>
                    </View>
                  ))}
                </View>
              )}
            </View>
            <View style={[styles.bentoRow, isDesktop && styles.bentoRowDesktop]}>
              {(isDesktop ? FEATURES.slice(2) : FEATURES).map((f) => (
                <View
                  key={f.key}
                  style={[styles.bentoCard, isDesktop ? styles.bentoThird : styles.bentoMobileCard, !isDesktop && f.gradient]}
                  testID={`landing-feature-${f.title}`}
                >
                  <View style={[styles.featureIconTile, { backgroundColor: `${f.tint}1F`, borderColor: `${f.tint}4D` }]}>
                    <Text style={[styles.featureIconGlyph, { color: f.tint }]}>{f.glyph}</Text>
                  </View>
                  <Text style={styles.bentoTitle}>{f.title}</Text>
                  <Text style={styles.bentoBody}>{f.body}</Text>
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* PRICE — Pen `k6Plv` desktop split / `izpcw` mobile stack */}
        <View style={[styles.sectionBlock, isDesktop && styles.sectionBlockDesktop]} testID="landing-price">
          <View style={[styles.splitRow, isDesktop && styles.splitRowDesktop]}>
            <View style={[styles.splitCopy, isDesktop && styles.splitCopyDesktop]}>
              <SectionPill text="市場價格" tint={T.accent2} />
              <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
                這張現在該買，{isDesktop ? '\n' : ''}還是再等一下
              </Text>
              <Text style={styles.sectionSubhead}>
                接遊々亭的實際售價，並拿前 7 日與近 7 日均價相比。價格可切換新台幣、日圓或美元（固定匯率）顯示。買賣差價與趨勢預測會逐步推出。
              </Text>
              {isDesktop && (
                <View style={styles.bulletList}>
                  {PRICE_BULLETS.map((b) => <CheckRow key={b} text={b} tint={T.accent2} />)}
                </View>
              )}
            </View>
            <PriceChartCard desktop={isDesktop} />
          </View>
        </View>

        {/* DECK — Pen `KXeLu` desktop split / `a7oRL` mobile stack */}
        <View style={[styles.sectionBlock, isDesktop && styles.sectionBlockDesktop]} testID="landing-collection-preview">
          <View style={[styles.splitRow, isDesktop && styles.splitRowDesktopReverse]}>
            <View style={[styles.splitCopy, isDesktop && styles.splitCopyDesktop]}>
              <SectionPill text="牌組編輯器" tint={T.accent3} />
              <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
                組完牌，順便{'\n'}知道還要再花多少
              </Text>
              <Text style={styles.sectionSubhead}>
                邊組邊檢查主牌組 50 張與同名張數上限，不合規的地方會直接列出來。缺的卡自動整理成清單，用遊々亭售價估出總額，還能一鍵套用較便宜的版本。
              </Text>
              {isDesktop && (
                <View style={styles.bulletList}>
                  {DECK_BULLETS.map((b) => <CheckRow key={b} text={b} tint={T.accent3} />)}
                </View>
              )}
            </View>
            <DeckPanel desktop={isDesktop} />
          </View>
        </View>

        {/* HOW IT WORKS — Pen `ZpbU9` / `D9WZMO` */}
        <View style={[styles.sectionBlock, styles.sectionCentered, isDesktop && styles.sectionBlockDesktop]} testID="landing-how-it-works">
          <View style={[styles.sectionHeader, isDesktop && styles.sectionHeaderCentered]}>
            <SectionPill text="開始使用" tint={T.accent} />
            <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop, isDesktop && styles.textCenter]}>
              三個步驟，從查卡到出賽
            </Text>
            <Text style={[styles.sectionSubhead, isDesktop && styles.textCenter]}>
              瀏覽器打開就能用，不用安裝。想先看看的話，訪客模式一樣能查卡、讀規則教學與跑模擬戰。
            </Text>
          </View>
          <View style={[styles.howGrid, isDesktop && styles.howGridDesktop]}>
            {HOW_IT_WORKS.map((s) => (
              <View key={s.step} style={styles.howStep} testID={`landing-how-${s.step}`}>
                <View style={styles.howStepHeader}>
                  <View style={[styles.howStepChip, { backgroundColor: `${s.tint}26`, borderColor: `${s.tint}59` }]}>
                    <Text style={[styles.howStepNumber, { color: s.tint }]}>{s.step}</Text>
                  </View>
                  <Text style={styles.howStepTitle}>{s.title}</Text>
                </View>
                <Text style={styles.howStepBody}>{s.body}</Text>
              </View>
            ))}
          </View>
        </View>

        {/* PLANS — Pen `mcRLH` / `MPyoM` */}
        <View style={[styles.sectionBlock, styles.sectionCentered, isDesktop && styles.sectionBlockDesktop]} testID="landing-plans">
          <View style={[styles.sectionHeader, isDesktop && styles.sectionHeaderCentered]}>
            <SectionPill text="方案" tint={T.accent2} />
            <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop, isDesktop && styles.textCenter]}>
              只有掃描有額度，其他都免費
            </Text>
            <Text style={[styles.sectionSubhead, isDesktop && styles.textCenter]}>
              查詢、收藏、組牌、賽事月報與規則教學都不收費。卡片辨識掃描每月 100 次。訂閱付費暫未開放。
            </Text>
          </View>
          <View style={[styles.plansGrid, isDesktop && styles.plansGridDesktop]}>
            <View style={styles.planCard} testID="landing-plan-free">
              <View style={styles.planHeaderRow}>
                <Text style={styles.planTitle}>免費會員</Text>
                {!isDesktop && (
                  <View style={styles.planOnlyPill}><Text style={styles.planOnlyPillText}>目前唯一方案</Text></View>
                )}
              </View>
              <Text style={styles.planTagline}>不用付費，登入即可使用</Text>
              <View style={styles.planDivider} />
              <View style={styles.planFeatureList}>
                {FREE_FEATURES.map((f) => <CheckRow key={f} text={f} tint={T.accent2} />)}
              </View>
              <TouchableOpacity
                style={[styles.ctaPrimary, GRAD.ctaPill, styles.planCta, isLoading && styles.ctaDisabled]}
                onPress={handleGuest}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-plan-free-cta"
              >
                <Text style={styles.ctaPrimaryText}>以訪客登入</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.planCard, styles.planCardComingSoon, GRAD.subCardTint]} testID="landing-plan-pro">
              <View style={styles.planHeaderRow}>
                <Text style={styles.planTitle}>訂閱會員</Text>
                <ComingSoonPill text="即將推出" />
              </View>
              <Text style={styles.planTagline}>訂閱與付費升級尚未開放；目前所有功能均為免費會員範圍。</Text>
              <View style={styles.planDivider} />
              <View style={styles.planFeatureList}>
                {COMING_SOON_FEATURES.map((f) => (
                  <View key={f} style={styles.checkRow}>
                    <View style={[styles.checkDot, styles.checkDotComing]}>
                      <Text style={[styles.checkGlyph, { color: T.comingSoonFg }]}>✓</Text>
                    </View>
                    <Text style={[styles.checkText, styles.checkTextComing]}>{f}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.planCta, styles.planCtaSecondary]}
                onPress={() => openUrl(LEGAL.pricing)}
                accessibilityRole="button"
                testID="landing-plan-pro-cta"
              >
                <Text style={styles.planCtaSecondaryText}>通知我上線</Text>
              </TouchableOpacity>
            </View>
          </View>
          <Text style={styles.plansFineprint}>
            目前所有功能均為免費會員範圍；訂閱與 App 內購尚未開放。
          </Text>
        </View>

        {/* FAQ — Pen `e2W4Rq` split accordion / `QNfNX` mobile cards */}
        <View style={[styles.sectionBlock, isDesktop && styles.sectionBlockDesktop]} testID="landing-faq">
          <View style={[styles.splitRow, isDesktop && styles.splitRowDesktop]}>
            <View style={[styles.splitCopy, isDesktop && styles.faqCopyDesktop]}>
              <SectionPill text="常見問題" tint={T.accent} />
              <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
                開始之前{'\n'}你可能想問
              </Text>
              <Text style={styles.sectionSubhead}>還有其他問題，可以從 App 的設定頁聯絡我們。</Text>
              <TouchableOpacity
                style={styles.faqContactLink}
                onPress={() => openUrl(LEGAL.support)}
                accessibilityRole="link"
                testID="landing-faq-contact"
              >
                <Text style={styles.faqContactText}>◌ 設定 → 聯絡我們</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.faqList, isDesktop && styles.faqListDesktop]}>
              {FAQ.map((f, i) => (
                <View
                  key={f.q}
                  style={[styles.faqItem, !isDesktop && styles.faqItemMobile, isDesktop && i > 0 && styles.faqItemDivided]}
                  testID={`landing-faq-item-${i}`}
                >
                  <TouchableOpacity
                    style={styles.faqQuestionRow}
                    onPress={() => toggleFaq(i)}
                    accessibilityRole="button"
                    testID={`landing-faq-toggle-${i}`}
                  >
                    <Text style={styles.faqQuestion}>{f.q}</Text>
                    <Text style={styles.faqToggleGlyph}>{faqOpen[i] ? (isDesktop ? '−' : '⌃') : (isDesktop ? '＋' : '⌄')}</Text>
                  </TouchableOpacity>
                  {faqOpen[i] && <Text style={styles.faqAnswer}>{f.a}</Text>}
                </View>
              ))}
            </View>
          </View>
        </View>

        {/* FINAL CTA — Pen `P8bPbJ` gradient card */}
        <View style={[styles.sectionBlock, isDesktop && styles.sectionBlockDesktop]} testID="landing-final-cta">
          <View style={[styles.finalCtaCard, GRAD.finalCta, isDesktop && styles.finalCtaCardDesktop]}>
            <View style={[styles.finalCtaShape, styles.finalCtaShapeLeft]} />
            <View style={[styles.finalCtaShape, styles.finalCtaShapeRight]} />
            <Text style={[styles.sectionHeadline, styles.textCenter, isDesktop && styles.sectionHeadlineDesktop]}>
              先從查一張卡開始
            </Text>
            <Text style={[styles.sectionSubhead, styles.textCenter, styles.finalCtaSub]}>
              免費使用。目前僅開放訪客進入；Google／Apple 登入與跨裝置同步正在陸續推出。
            </Text>
            <View style={[styles.ctaRow, styles.finalCtaRow, isDesktop && styles.ctaRowDesktop]}>
              <TouchableOpacity
                style={[styles.ctaPrimary, GRAD.ctaPill, isLoading && styles.ctaDisabled]}
                onPress={handleGuest}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-final-cta-guest"
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.ctaPrimaryText}>以訪客登入</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.ctaGoogle, styles.ctaGoogleOnGradient]}
                onPress={handleGoogle}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-final-cta-google"
              >
                <Text style={styles.ctaGoogleText}>使用 Google 帳號（即將推出）{isDesktop ? '  →' : ''}</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.finalCtaNote}>非官方工具 · 卡牌圖像與名稱版權屬於原公司</Text>
          </View>
        </View>

        {/* FOOTER — Pen `TldCK` desktop columns / `r86yeO` mobile stack */}
        <View style={[styles.footer, isDesktop && styles.footerDesktop]} testID="landing-footer">
          <View style={[styles.footerTop, isDesktop && styles.footerTopDesktop]}>
            <View style={styles.footerBrandBlock}>
              <View style={styles.navBrand}>
                <View style={[styles.brandMark, GRAD.brandTile]}>
                  <Text style={styles.brandMarkGlyph}>✦</Text>
                </View>
                <Text style={styles.brandText}>HoloHunter</Text>
              </View>
              <Text style={styles.footerDesc}>
                hololive OFFICIAL CARD GAME 的非官方查詢工具。卡表檢索、市場行情、掃描估值、牌組構築與賽事月報。與官方無隸屬關係。
              </Text>
            </View>
            <View style={[styles.footerCols, isDesktop && styles.footerColsDesktop]}>
              <View style={styles.footerCol}>
                <Text style={styles.footerColTitle}>產品</Text>
                {NAV_LINKS.slice(0, 4).map((label) => (
                  <TouchableOpacity key={label} style={styles.footerItemTap} onPress={handleGuest} accessibilityRole="link">
                    <Text style={styles.footerLink}>{label}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={styles.footerCol}>
                <Text style={styles.footerColTitle}>資源</Text>
                <TouchableOpacity style={styles.footerItemTap} onPress={handleGuest} accessibilityRole="link">
                  <Text style={styles.footerLink}>規則教學</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.footerItemTap} onPress={handleGuest} accessibilityRole="link">
                  <Text style={styles.footerLink}>模擬實戰</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.footerItemTap} onPress={() => openUrl(LEGAL.pricing)} testID="landing-footer-pricing">
                  <Text style={styles.footerLink}>訂閱方案</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.footerItemTap} onPress={() => openUrl(LEGAL.support)} testID="landing-footer-support">
                  <Text style={styles.footerLink}>技術支援</Text>
                </TouchableOpacity>
              </View>
              <View style={styles.footerCol}>
                <Text style={styles.footerColTitle}>關於</Text>
                <TouchableOpacity style={styles.footerItemTap} onPress={() => openUrl(LEGAL.support)}>
                  <Text style={styles.footerLink}>聯絡我們</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.footerItemTap} onPress={() => openUrl(LEGAL.privacy)} testID="landing-footer-privacy">
                  <Text style={styles.footerLink}>隱私權政策</Text>
                </TouchableOpacity>
                <TouchableOpacity style={styles.footerItemTap} onPress={() => openUrl(LEGAL.terms)} testID="landing-footer-terms">
                  <Text style={styles.footerLink}>服務條款</Text>
                </TouchableOpacity>
              </View>
            </View>
          </View>
          <View style={[styles.footerBottom, isDesktop && styles.footerBottomDesktop]}>
            <Text style={styles.footerCopy}>
              © 2026 HoloHunter · 非官方工具，卡牌圖像與名稱版權屬於原公司
            </Text>
            {isDesktop && (
              <View style={styles.footerBottomLinks}>
                <TouchableOpacity onPress={() => openUrl(LEGAL.privacy)}>
                  <Text style={styles.footerLink}>隱私權政策</Text>
                </TouchableOpacity>
                <TouchableOpacity onPress={() => openUrl(LEGAL.terms)}>
                  <Text style={styles.footerLink}>服務條款</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: T.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: 0 },
  section: { paddingHorizontal: LAYOUT.safeMobile, alignSelf: 'stretch' },
  sectionBlock: { paddingHorizontal: LAYOUT.safeMobile, paddingVertical: 48, alignSelf: 'stretch' },
  sectionBlockDesktop: {
    paddingHorizontal: 56,
    paddingVertical: 96,
    maxWidth: LAYOUT.contentDesktop + 112,
    width: '100%',
    alignSelf: 'center',
  },
  sectionCentered: {},
  sectionHeader: { gap: 12, marginBottom: 28, alignItems: 'flex-start' },
  sectionHeaderLeft: { maxWidth: 640 },
  sectionHeaderCentered: { alignItems: 'center', alignSelf: 'center', maxWidth: 720 },
  textCenter: { textAlign: 'center' },

  // ── NAV ─────────────────────────────────────────────────────────────
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: LAYOUT.safeMobile,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: T.border,
    backgroundColor: T.bg,
  },
  navDesktop: { paddingHorizontal: 56, minHeight: 76 },
  navBrand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: {
    width: 28,
    height: 28,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  brandMarkGlyph: { color: '#fff', fontSize: 14, fontWeight: '800' },
  brandText: {
    color: T.textPrimary,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.4,
    fontFamily: displayFont,
  },
  navLinks: { flexDirection: 'row', alignItems: 'center', gap: 24, flex: 1, justifyContent: 'center' },
  navLinkTap: { minHeight: LAYOUT.minTouch, justifyContent: 'center', paddingHorizontal: 4 },
  navLink: { color: T.textSecondary, fontSize: 14, fontWeight: '600', fontFamily: bodyFont },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  navGuestLink: { minHeight: LAYOUT.minTouch, justifyContent: 'center', paddingHorizontal: 4 },
  navGuestLinkText: { color: T.textSecondary, fontSize: 14, fontWeight: '600', fontFamily: bodyFont },
  // Pen `xFOCN` 登入 — white pill, dark label.
  navCta: {
    minHeight: LAYOUT.minTouch,
    paddingHorizontal: 22,
    borderRadius: 22,
    backgroundColor: '#FFFFFF',
    alignItems: 'center',
    justifyContent: 'center',
  },
  navCtaText: { color: T.bg, fontSize: 14, fontWeight: '700', fontFamily: bodyFont },
  mobileMenuBtn: {
    width: LAYOUT.minTouch,
    height: LAYOUT.minTouch,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
  },
  mobileMenuIcon: { color: T.textPrimary, fontSize: 22, fontWeight: '700' },
  mobileMenu: { borderBottomWidth: 1, borderBottomColor: T.border, backgroundColor: T.surface },
  mobileMenuItem: { paddingHorizontal: LAYOUT.safeMobile, minHeight: LAYOUT.minTouch, justifyContent: 'center' },
  mobileMenuItemText: { color: T.textPrimary, fontSize: 15, fontWeight: '600', fontFamily: bodyFont },

  // ── HERO ────────────────────────────────────────────────────────────
  hero: { paddingVertical: 24, gap: 36, paddingBottom: 56 },
  heroDesktop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 48,
    paddingVertical: 72,
    paddingHorizontal: 56,
  },
  heroCopy: { flex: 1, gap: 22, maxWidth: 640 },
  eyebrowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 10,
    paddingLeft: 6,
    paddingRight: 14,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    maxWidth: '100%',
  },
  eyebrowBadge: { paddingHorizontal: 10, paddingVertical: 3, borderRadius: 999 },
  eyebrowBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.6, fontFamily: displayFont },
  pillText: { color: T.textSecondary, fontSize: 12, fontWeight: '600', flexShrink: 1, fontFamily: bodyFont },
  headline: {
    color: T.textPrimary,
    fontSize: 32,
    lineHeight: 41,
    fontWeight: '800',
    letterSpacing: -0.4,
    fontFamily: displayFont,
  },
  headlineDesktop: { fontSize: 56, lineHeight: 68 },
  subhead: {
    color: T.textSecondary,
    fontSize: 15,
    lineHeight: 25,
    fontWeight: '400',
    fontFamily: bodyFont,
    maxWidth: 560,
  },
  ctaRow: { flexDirection: 'column', gap: 12, marginTop: 8, alignSelf: 'stretch' },
  ctaRowDesktop: { flexDirection: 'row', flexWrap: 'wrap', gap: 16, alignSelf: 'flex-start' },
  ctaPrimary: {
    minHeight: LAYOUT.minTouch + 8,
    paddingHorizontal: 28,
    borderRadius: 26,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: T.accent,
    shadowOpacity: 0.4,
    shadowRadius: 22,
    shadowOffset: { width: 0, height: 8 },
    elevation: 8,
  },
  ctaPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '700', fontFamily: bodyFont },
  ctaDisabled: { opacity: 0.6 },
  ctaGoogle: {
    minHeight: LAYOUT.minTouch + 8,
    paddingHorizontal: 22,
    borderRadius: 26,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  ctaGoogleOnGradient: { backgroundColor: 'rgba(8,8,15,0.6)', borderColor: 'rgba(246,246,251,0.22)' },
  googleBadge: {
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  googleBadgeText: { color: T.textPrimary, fontSize: 12, fontWeight: '800', fontFamily: displayFont },
  ctaGoogleText: { color: T.textPrimary, fontSize: 15, fontWeight: '600', fontFamily: bodyFont },
  ctaNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 4 },
  ctaNoteIcon: { fontSize: 14, marginTop: 2 },
  ctaNoteText: { color: T.textMuted, fontSize: 12, lineHeight: 18, flex: 1, fontFamily: bodyFont },

  // Pen `z5AkG` hero visual — tilted trio + floating chips on a fixed
  // 640×560 canvas, scaled to the viewport by the wrapper.
  heroVisual: { position: 'relative', flexShrink: 0 },
  heroVisualCanvas: {
    position: 'absolute',
    top: 0,
    left: 0,
    width: 640,
    height: 560,
    transformOrigin: 'top left',
  },
  heroCard: {
    position: 'absolute',
    borderRadius: 18,
    borderWidth: 1,
    borderColor: 'rgba(246,246,251,0.16)',
    backgroundColor: T.surface2,
    overflow: 'hidden',
    shadowColor: '#000000',
    shadowOpacity: 0.55,
    shadowRadius: 28,
    shadowOffset: { width: 0, height: 16 },
    elevation: 12,
  },
  heroCardLeft: {
    width: 190,
    height: 268,
    left: 10,
    top: 140,
    transform: [{ rotate: '-9deg' }],
  },
  heroCardCenter: {
    width: 240,
    height: 338,
    left: 195,
    top: 52,
    zIndex: 2,
    shadowColor: T.accent2,
    shadowOpacity: 0.35,
    shadowRadius: 36,
    shadowOffset: { width: 0, height: 12 },
    transform: [{ rotate: '2deg' }],
  },
  heroCardRight: {
    width: 200,
    height: 282,
    left: 428,
    top: 110,
    shadowColor: T.accent,
    shadowOpacity: 0.28,
    shadowRadius: 30,
    shadowOffset: { width: 0, height: 12 },
    transform: [{ rotate: '9deg' }],
  },
  heroCardImg: { width: '100%', flex: 1, backgroundColor: T.surface2 },
  heroCardMeta: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 10,
    paddingVertical: 7,
    backgroundColor: 'rgba(8,8,15,0.82)',
  },
  heroCardNumber: { color: T.textSecondary, fontSize: 11, fontFamily: Platform.OS === 'web' ? 'monospace' : undefined },
  rarityBadge: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 6, backgroundColor: T.accent },
  rarityBadgeText: { color: '#fff', fontSize: 10, fontWeight: '800', letterSpacing: 0.5 },

  legalityChip: {
    position: 'absolute',
    right: 0,
    top: 6,
    zIndex: 3,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 16,
    backgroundColor: 'rgba(20,20,31,0.94)',
    borderWidth: 1,
    borderColor: T.border,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  legalityRing: {
    width: 34,
    height: 34,
    borderRadius: 17,
    borderWidth: 4,
    borderColor: T.accent2,
    borderBottomColor: 'rgba(61,224,255,0.2)',
    borderLeftColor: 'rgba(61,224,255,0.2)',
  },
  legalityValue: { color: T.textPrimary, fontSize: 14, fontWeight: '700', marginTop: 2, fontFamily: bodyFont },

  heroPriceChip: {
    borderRadius: 16,
    backgroundColor: 'rgba(20,20,31,0.94)',
    borderWidth: 1,
    borderColor: T.border,
    padding: 16,
    gap: 8,
  },
  heroPriceChipFloating: {
    position: 'absolute',
    left: 0,
    bottom: 6,
    zIndex: 3,
    shadowColor: '#000000',
    shadowOpacity: 0.5,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 10 },
    elevation: 10,
  },
  heroPriceChipMobile: { alignSelf: 'stretch', padding: 18, backgroundColor: T.surface },
  heroChipLabel: { color: T.textSecondary, fontSize: 11, fontWeight: '600', fontFamily: bodyFont },
  heroChipSource: { color: T.textMuted, fontSize: 11, marginTop: 2, fontFamily: bodyFont },
  heroPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  heroPriceValue: { color: T.textPrimary, fontSize: 24, fontWeight: '800', fontFamily: displayFont },
  deltaChip: {
    backgroundColor: 'rgba(52,211,153,0.14)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  deltaChipText: { color: T.cGreen, fontSize: 12, fontWeight: '700', fontFamily: bodyFont },
  sparkline: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 34, marginTop: 4 },
  sparklineCompact: { height: 28, marginTop: 0, marginLeft: 6 },
  sparkBar: { width: 5, borderRadius: 2, backgroundColor: T.accent, opacity: 0.9 },

  // ── STATS BAR — flat columns per Pen `vfBpS` / `ufjjN` ─────────────
  statsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: LAYOUT.safeMobile,
    paddingVertical: 18,
    backgroundColor: '#0D0D16',
    borderTopWidth: 1,
    borderTopColor: T.border,
    borderBottomWidth: 1,
    borderBottomColor: T.border,
    gap: 8,
  },
  statsBarDesktop: { paddingHorizontal: 56, paddingVertical: 32, justifyContent: 'space-around' },
  statCol: { alignItems: 'center', gap: 4, flexShrink: 1 },
  statValue: { color: T.textPrimary, fontSize: 17, fontWeight: '800', fontFamily: displayFont },
  statValueDesktop: { fontSize: 28 },
  statLabel: { color: T.textSecondary, fontSize: 11, fontWeight: '500', textAlign: 'center', fontFamily: bodyFont },

  // ── SECTION HEADERS ───────────────────────────────────────────────
  sectionPill: {
    alignSelf: 'flex-start',
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 999,
    borderWidth: 1,
  },
  sectionPillText: { fontSize: 12, fontWeight: '700', letterSpacing: 0.4, fontFamily: bodyFont },
  sectionHeadline: {
    color: T.textPrimary,
    fontSize: 26,
    lineHeight: 35,
    fontWeight: '800',
    letterSpacing: -0.2,
    fontFamily: displayFont,
  },
  sectionHeadlineDesktop: { fontSize: 42, lineHeight: 54 },
  sectionSubhead: {
    color: T.textSecondary,
    fontSize: 14,
    lineHeight: 23,
    maxWidth: 720,
    fontFamily: bodyFont,
  },

  // ── FEATURES BENTO ────────────────────────────────────────────────
  bento: { gap: 16, marginTop: 4 },
  bentoDesktop: { gap: 24 },
  bentoRow: { flexDirection: 'column', gap: 16 },
  bentoRowDesktop: { flexDirection: 'row', gap: 24, alignItems: 'stretch' },
  bentoCard: {
    padding: 22,
    borderRadius: 20,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    gap: 10,
  },
  bentoMobileCard: {},
  bentoSide: { flex: 1, gap: 24 },
  bentoSideCard: { flex: 1, padding: 26 },
  bentoThird: { flex: 1, padding: 26 },
  bentoTitle: { color: T.textPrimary, fontSize: 17, fontWeight: '700', fontFamily: bodyFont },
  bentoBody: { color: T.textSecondary, fontSize: 13, lineHeight: 21, fontFamily: bodyFont },
  featureIconTile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  featureIconGlyph: { fontSize: 19, fontWeight: '700' },

  searchCard: { overflow: 'hidden' },
  searchCardDesktop: { flex: 2, padding: 32, maxHeight: 420 },
  searchMockBox: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    minHeight: 46,
    borderRadius: 12,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 14,
    marginTop: 8,
  },
  searchMockGlyph: { color: T.textMuted, fontSize: 16, fontWeight: '700' },
  searchMockQuery: { color: T.textPrimary, fontSize: 14, fontWeight: '600', fontFamily: bodyFont },
  searchMockCaret: { color: T.accent, fontSize: 15, fontWeight: '400', marginLeft: -6 },
  searchMockChips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 4 },
  searchChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 999,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
  },
  searchChipActive: { backgroundColor: T.accent, borderColor: T.accent },
  searchChipOutlined: { backgroundColor: 'rgba(255,77,157,0.12)', borderColor: 'rgba(255,77,157,0.5)' },
  searchChipText: { color: T.textSecondary, fontSize: 12, fontWeight: '600', fontFamily: bodyFont },
  searchChipTextActive: { color: '#fff' },
  searchChipTextOutlined: { color: T.comingSoonFg },
  searchMockGrid: { flexDirection: 'row', gap: 10, marginTop: 8 },
  searchMockTile: {
    flex: 1,
    aspectRatio: 0.72,
    borderRadius: 8,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
  },

  // ── SPLIT SECTIONS (price / deck / faq) ───────────────────────────
  splitRow: { flexDirection: 'column', gap: 28 },
  splitRowDesktop: { flexDirection: 'row', gap: 72, alignItems: 'center' },
  splitRowDesktopReverse: { flexDirection: 'row-reverse', gap: 72, alignItems: 'center' },
  splitCopy: { gap: 14 },
  splitCopyDesktop: { flex: 1, maxWidth: 452, gap: 16 },
  bulletList: { gap: 12, marginTop: 8 },
  checkRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 10 },
  checkDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 1,
  },
  checkDotComing: { borderColor: 'rgba(255,180,217,0.4)' },
  checkGlyph: { fontSize: 11, fontWeight: '800' },
  checkText: { color: T.textSecondary, fontSize: 13, lineHeight: 20, flex: 1, fontFamily: bodyFont },
  checkTextComing: { color: T.textMuted },

  // ── PRICE CHART CARD — Pen `N8ds5T` ───────────────────────────────
  chartCard: {
    borderRadius: 20,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    padding: 20,
    gap: 14,
    alignSelf: 'stretch',
  },
  chartCardDesktop: { flex: 1.4, padding: 28 },
  chartHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  chartThumb: { width: 44, height: 44, borderRadius: 8, backgroundColor: T.surface2 },
  chartHeaderCopy: { flex: 1, minWidth: 0, gap: 2 },
  chartTitle: { color: T.textPrimary, fontSize: 16, fontWeight: '700', fontFamily: bodyFont },
  chartSubtitle: { color: T.textMuted, fontSize: 11, fontFamily: bodyFont },
  timeframes: {
    flexDirection: 'row',
    backgroundColor: T.surface2,
    borderRadius: 10,
    padding: 3,
    gap: 2,
  },
  timeframe: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: 8 },
  timeframeActive: { backgroundColor: T.accent },
  timeframeText: { color: T.textMuted, fontSize: 11, fontWeight: '700', fontFamily: bodyFont },
  timeframeTextActive: { color: '#fff' },
  chartPriceRow: { flexDirection: 'row', alignItems: 'center', gap: 12, flexWrap: 'wrap' },
  chartPrice: { color: T.textPrimary, fontSize: 28, fontWeight: '800', fontFamily: displayFont },
  chartPriceDesktop: { fontSize: 34 },
  chartBars: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  chartBarSlot: { flex: 1, alignItems: 'center', justifyContent: 'flex-end', gap: 6 },
  chartBar: {
    alignSelf: 'stretch',
    borderTopLeftRadius: 6,
    borderTopRightRadius: 6,
    backgroundColor: '#B23A76',
  },
  chartBarValue: { color: T.accent, fontSize: 12, fontWeight: '800', fontFamily: displayFont },
  chartXAxis: { flexDirection: 'row', justifyContent: 'space-between', marginTop: -4 },
  chartXLabel: { color: T.textMuted, fontSize: 11, fontFamily: bodyFont },
  chartCells: { flexDirection: 'row', gap: 12, marginTop: 6 },
  chartCell: {
    flex: 1,
    borderRadius: 12,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
    padding: 14,
    gap: 4,
  },
  chartCellComing: { backgroundColor: 'rgba(61,37,71,0.55)', borderColor: 'rgba(255,180,217,0.25)' },
  chartCellLabel: { color: T.textSecondary, fontSize: 12, fontFamily: bodyFont },
  chartCellLabelComing: { color: 'rgba(255,180,217,0.75)', fontSize: 12, fontFamily: bodyFont },
  chartCellValue: { color: T.textPrimary, fontSize: 16, fontWeight: '700', fontFamily: bodyFont },
  chartCellComingValue: { color: T.comingSoonFg, fontSize: 15, fontWeight: '700', fontFamily: bodyFont },
  chartCellsMobile: { gap: 8, marginTop: 6 },
  chartRowMobile: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    borderRadius: 10,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
    paddingHorizontal: 14,
    paddingVertical: 12,
    gap: 8,
  },
  chartRowMobileComing: { backgroundColor: 'rgba(61,37,71,0.55)', borderColor: 'rgba(255,180,217,0.25)' },
  chartFootnote: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 16,
    borderRadius: 10,
    backgroundColor: 'rgba(61,37,71,0.4)',
    paddingHorizontal: 14,
    paddingVertical: 10,
  },
  chartFootnoteTitle: { color: T.comingSoonFg, fontSize: 12, fontWeight: '700', fontFamily: bodyFont },
  chartFootnoteBody: { color: T.textMuted, fontSize: 11, flex: 1, textAlign: 'right', fontFamily: bodyFont },

  // ── DECK PANEL — Pen `voo0h` ──────────────────────────────────────
  deckPanel: {
    borderRadius: 20,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    padding: 20,
    gap: 16,
    alignSelf: 'stretch',
  },
  deckPanelDesktop: { flex: 1.4, padding: 28 },
  deckHeader: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
  deckHeaderCopy: { flex: 1, minWidth: 0, gap: 6 },
  deckTitle: { color: T.textPrimary, fontSize: 18, fontWeight: '800', fontFamily: bodyFont },
  deckDraftRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  deckDraftPill: {
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 6,
    backgroundColor: 'rgba(52,211,153,0.14)',
  },
  deckDraftPillText: { color: T.cGreen, fontSize: 11, fontWeight: '700', fontFamily: bodyFont },
  deckSubtitle: { color: T.textMuted, fontSize: 12, fontFamily: bodyFont },
  deckEstimate: { alignItems: 'flex-end', gap: 2 },
  deckEstimateLabel: { color: T.textMuted, fontSize: 11, fontFamily: bodyFont },
  deckEstimateValue: { color: T.accent, fontSize: 22, fontWeight: '800', fontFamily: displayFont },
  deckRows: { gap: 14 },
  deckRow: { gap: 7 },
  deckRowTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  deckRowName: { color: T.textPrimary, fontSize: 13, fontWeight: '600', flexShrink: 1, fontFamily: bodyFont },
  deckRowCount: { color: T.textMuted, fontSize: 12, fontFamily: bodyFont },
  deckTrack: { height: 6, borderRadius: 3, backgroundColor: T.surface2, overflow: 'hidden' },
  deckFill: { height: 6, borderRadius: 3 },
  deckDivider: { height: 1, backgroundColor: T.border },
  deckMissingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  deckMissingTitle: { color: T.textPrimary, fontSize: 14, fontWeight: '700', fontFamily: bodyFont },
  deckCheapLink: { color: T.accent, fontSize: 13, fontWeight: '700', fontFamily: bodyFont },
  deckTiles: { flexDirection: 'row', gap: 10 },
  deckTile: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 10,
    backgroundColor: T.surface2,
    borderWidth: 1,
    borderColor: T.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  deckTilePlus: { color: T.textMuted, fontSize: 16, fontWeight: '600' },

  // ── HOW IT WORKS ──────────────────────────────────────────────────
  howGrid: { flexDirection: 'column', gap: 16, marginTop: 8, alignSelf: 'stretch' },
  howGridDesktop: { flexDirection: 'row', gap: 24, marginTop: 24 },
  howStep: {
    padding: 22,
    borderRadius: 16,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    gap: 12,
    flex: 1,
    minWidth: 220,
  },
  howStepHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  howStepChip: {
    width: 36,
    height: 36,
    borderRadius: 10,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  howStepNumber: { fontSize: 13, fontWeight: '800', fontFamily: displayFont },
  howStepTitle: { color: T.textPrimary, fontSize: 16, fontWeight: '700', flexShrink: 1, fontFamily: bodyFont },
  howStepBody: { color: T.textSecondary, fontSize: 13, lineHeight: 21, fontFamily: bodyFont },

  // ── PLANS ─────────────────────────────────────────────────────────
  plansGrid: { flexDirection: 'column', gap: 16, marginTop: 8, alignSelf: 'stretch' },
  plansGridDesktop: {
    flexDirection: 'row',
    gap: 28,
    marginTop: 24,
    maxWidth: 940,
    width: '100%',
    alignSelf: 'center',
  },
  planCard: {
    flex: 1,
    minWidth: 260,
    padding: 26,
    borderRadius: 20,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
    gap: 12,
  },
  planCardComingSoon: { borderColor: 'rgba(255,77,157,0.45)' },
  planHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  planTitle: { color: T.textPrimary, fontSize: 19, fontWeight: '800', fontFamily: bodyFont },
  planOnlyPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: T.comingSoonBg,
  },
  planOnlyPillText: { color: T.comingSoonFg, fontSize: 11, fontWeight: '700', fontFamily: bodyFont },
  planTagline: { color: T.textSecondary, fontSize: 13, lineHeight: 19, fontFamily: bodyFont },
  planDivider: { height: 1, backgroundColor: T.border, marginVertical: 4 },
  planFeatureList: { gap: 12, marginTop: 2 },
  planCta: { marginTop: 14 },
  planCtaSecondary: {
    minHeight: LAYOUT.minTouch + 4,
    paddingHorizontal: 20,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: T.border,
    backgroundColor: T.surface2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  planCtaSecondaryText: { color: T.textPrimary, fontSize: 14, fontWeight: '700', fontFamily: bodyFont },
  plansFineprint: { color: T.textMuted, fontSize: 12, marginTop: 24, textAlign: 'center', alignSelf: 'center', fontFamily: bodyFont },

  // ── FAQ ───────────────────────────────────────────────────────────
  faqCopyDesktop: { flex: 1, maxWidth: 400, alignSelf: 'flex-start', gap: 16 },
  faqList: { gap: 12 },
  faqListDesktop: { flex: 1.6, gap: 0, alignSelf: 'flex-start' },
  faqItem: { gap: 10 },
  faqItemMobile: {
    padding: 18,
    borderRadius: 12,
    backgroundColor: T.surface,
    borderWidth: 1,
    borderColor: T.border,
  },
  faqItemDivided: { borderTopWidth: 1, borderTopColor: T.border },
  faqQuestionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 12,
    minHeight: LAYOUT.minTouch,
    paddingVertical: 8,
  },
  faqQuestion: { color: T.textPrimary, fontSize: 15, fontWeight: '700', flex: 1, fontFamily: bodyFont },
  faqToggleGlyph: { color: T.textMuted, fontSize: 16, fontWeight: '600' },
  faqAnswer: { color: T.textSecondary, fontSize: 13, lineHeight: 21, paddingBottom: 14, fontFamily: bodyFont },
  faqContactLink: { minHeight: LAYOUT.minTouch, justifyContent: 'center', alignSelf: 'flex-start' },
  faqContactText: { color: T.accent, fontSize: 13, fontWeight: '700', fontFamily: bodyFont },

  // ── FINAL CTA — Pen `P8bPbJ` gradient card ────────────────────────
  finalCtaCard: {
    borderRadius: 24,
    overflow: 'hidden',
    paddingHorizontal: 24,
    paddingVertical: 48,
    alignItems: 'center',
    gap: 16,
    borderWidth: 1,
    borderColor: 'rgba(246,246,251,0.08)',
  },
  finalCtaCardDesktop: { paddingVertical: 88, paddingHorizontal: 56 },
  finalCtaShape: {
    position: 'absolute',
    width: 150,
    height: 210,
    borderRadius: 22,
    opacity: 0.5,
  },
  finalCtaShapeLeft: {
    left: -36,
    bottom: -60,
    backgroundColor: 'rgba(76,141,255,0.35)',
    transform: [{ rotate: '18deg' }],
  },
  finalCtaShapeRight: {
    right: -30,
    top: -70,
    backgroundColor: 'rgba(139,92,246,0.4)',
    transform: [{ rotate: '-16deg' }],
  },
  finalCtaSub: { maxWidth: 560 },
  finalCtaRow: { marginTop: 8, alignItems: 'center', justifyContent: 'center' },
  finalCtaNote: { color: 'rgba(246,246,251,0.55)', fontSize: 11, marginTop: 8, textAlign: 'center', fontFamily: bodyFont },

  // ── FOOTER — Pen `TldCK` / `r86yeO` ───────────────────────────────
  footer: {
    borderTopWidth: 1,
    borderTopColor: T.border,
    paddingHorizontal: LAYOUT.safeMobile,
    paddingTop: 40,
    paddingBottom: 24,
    gap: 32,
  },
  footerDesktop: {
    paddingHorizontal: 56,
    paddingTop: 56,
    maxWidth: LAYOUT.contentDesktop + 112,
    width: '100%',
    alignSelf: 'center',
    borderTopWidth: 1,
  },
  footerTop: { gap: 28 },
  footerTopDesktop: { flexDirection: 'row', justifyContent: 'space-between', gap: 48 },
  footerBrandBlock: { gap: 14, maxWidth: 340 },
  footerDesc: { color: T.textMuted, fontSize: 13, lineHeight: 20, fontFamily: bodyFont },
  footerCols: { flexDirection: 'column', gap: 24 },
  footerColsDesktop: { flexDirection: 'row', gap: 72 },
  footerCol: { gap: 4, minWidth: 96 },
  footerColTitle: { color: T.textPrimary, fontSize: 13, fontWeight: '700', marginBottom: 6, fontFamily: bodyFont },
  footerItemTap: { minHeight: 36, justifyContent: 'center' },
  footerLink: { color: T.textSecondary, fontSize: 13, fontWeight: '500', fontFamily: bodyFont },
  footerBottom: {
    borderTopWidth: 1,
    borderTopColor: T.border,
    paddingTop: 18,
    gap: 10,
  },
  footerBottomDesktop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  footerBottomLinks: { flexDirection: 'row', gap: 24 },
  footerCopy: { color: T.textMuted, fontSize: 12, lineHeight: 18, fontFamily: bodyFont },

  // ── PILLS + ERROR ─────────────────────────────────────────────────
  comingSoonPill: {
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: 999,
    backgroundColor: T.comingSoonBg,
  },
  comingSoonPillText: { color: T.comingSoonFg, fontSize: 11, fontWeight: '700', fontFamily: bodyFont },
  errorBox: {
    marginTop: 12,
    backgroundColor: 'rgba(248,113,113,0.12)',
    borderColor: 'rgba(248,113,113,0.6)',
    borderWidth: 1,
    borderRadius: 8,
    padding: 12,
    flexDirection: 'row',
    alignItems: 'flex-start',
  },
  errorText: { color: T.cRed, fontSize: 13, flex: 1, fontFamily: bodyFont },
  errorDismiss: { color: T.cRed, fontSize: 16, paddingLeft: 12, fontWeight: '700' },
});
