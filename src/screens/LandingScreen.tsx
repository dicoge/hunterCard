/**
 * LandingScreen — Pen artifact `holohunter-landing-v2.pen` production impl
 * (DIC-1380 W5b: PM correction "accepted Pen design is not deployed").
 *
 * The previous `LoginScreen` shipped a bare auth card at `/`. The accepted
 * Pen Landing artifact anchors a rich responsive marketing landing at
 * Desktop 1440 (frame `XwzSU`'s sections `avS3j` Nav, `Rlx6E` Hero,
 * `vfBpS` Stats Bar, `GAolm` Features, `mcRLH` Plans, `TldCK` Footer) and
 * Mobile 390 (`bDwDO` Nav, `LX2IZ` Hero, `ufjjN` Stats Bar, `r41z2`
 * Features, `MPyoM` Plans, `r86yeO` Footer). This file implements the
 * P0 subset of both: Nav + Hero + Stats Bar + Features + Plans + Footer
 * with the Pen artifact's truthful copy (guest CTA primary; Google login
 * marked "即將推出"; free-tier only; scan quota 100/month; no paid tier
 * yet). Secondary Pen sections (Price / Collection / How It Works / FAQ
 * / Final CTA) are deliberately scoped out of this pass so the
 * user-visible Landing lands here rather than being blocked on scope.
 *
 * Responsive rules follow the Pen viewports: <768 px renders the mobile
 * `bDwDO`-style layout with the burger menu closed by default; ≥768 px
 * renders the desktop `avS3j` nav + two-column Hero. All touch targets
 * respect the Pen `min-touch: 44` token; all colors read from Pen tokens
 * (bg #08080F, surface #12121D, accent #FF4D9D, coming-soon-bg #3D2547,
 * coming-soon-fg #FFB4D9). No horizontal overflow at 320 / 390 / 768 /
 * 1440 — the Hero visual card and Stats Bar wrap on narrow viewports.
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
  Platform,
} from 'react-native';
import { useAuthStore } from '../store/authStore';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';

// Pen `holohunter-landing-v2.pen` variables — single source of truth for
// the Landing surface. Any drift from these tokens is a Pen-conformance
// regression the DIC-1380 W5b handback specifically named.
const TOKENS = {
  bg: '#08080F',
  surface: '#12121D',
  surface2: '#1A1A2A',
  border: '#282838',
  textPrimary: '#F6F6FB',
  textSecondary: '#9494B0',
  textMuted: '#6A6A85',
  accent: '#FF4D9D',
  accent2: '#3DE0FF',
  accent3: '#8B5CF6',
  comingSoonBg: '#3D2547',
  comingSoonFg: '#FFB4D9',
  minTouch: 44,
  safeMobile: 20,
  contentDesktop: 1328,
};

const NAV_LINKS = ['卡牌查詢', '掃描估值', '牌組編輯器', '賽事月報', '規則教學'];

// Pen `vfBpS` (desktop) + `ufjjN` (mobile) Stats Bar values, kept as
// tuples so we render them identically on both viewports.
const STATS = [
  { value: '36', label: '個收錄系列' },
  { value: '中 / 日', label: '介面與卡名雙語' },
  { value: 'NT$ · ¥ · $', label: '三種幣別固定匯率換算' },
  { value: '8 章', label: '規則教學 + 模擬實戰' },
];

// Pen `GAolm` / `r41z2` Features. Order matches the Pen artifact.
const FEATURES = [
  {
    title: '卡表檢索與篩選',
    body: '卡名、卡號、效果內文全文檢索，再疊加卡牌種類、顏色、稀有度、收錄彈數。中日文卡名都能搜。',
  },
  {
    title: '拍照估值掃描',
    body: '對著卡片拍一張就辨識卡號與版本，連續掃完一盒後直接給你整份估值清單與總計。',
  },
  {
    title: '到價提醒（正在推出）',
    body: '到價提醒鎖定精確版本與價格區間，價格進區間時推播一次。',
  },
  {
    title: '牌組編輯器與缺卡預估',
    body: '邊組邊檢查 50 張主牌組與同名張數限制，未達標會列出缺哪幾張，並算出缺卡預估總額。',
  },
  {
    title: '賽事月報',
    body: '彙整已公開的精選賽事牌組，看上眼的牌組可一鍵匯入編輯器。',
  },
  {
    title: '規則教學 · 模擬對局',
    body: '8 章教學從遊戲簡介講到比賽流程，並跟著 step-by-step 引導打一場簡化對局。',
  },
];

// Pen `MPyoM` free-plan feature list. Copy is verbatim from the accepted
// artifact so a rewording in Pen has to be brought here explicitly.
const FREE_FEATURES = [
  '全部卡表檢索與篩選',
  '市場價格與 7D/30D/90D 歷史',
  '收藏、牌組編輯器與缺卡預估',
  '賽事月報、規則教學與模擬戰',
  '每月 100 次卡片辨識掃描',
];

const COMING_SOON_FEATURES = [
  '免費會員的全部功能',
  '無限卡片掃描（規劃中，計費地區待定）',
  '上線時會在此揭露方案內容',
];

// Pen `holohunter-landing-v2.pen` additional composition sections
// (DIC-1380 W6 CR — full Landing parity). The previous P0 subset only
// carried Nav / Hero / Stats Bar / Features / Plans / Footer; the CR
// explicitly asks for the full composition. These sections land the
// remaining Pen anchors: HOW_IT_WORKS (三步驟), COLLECTION_PREVIEW
// (卡表 / 收藏 / 牌組展示), FAQ (常見問題) and FINAL_CTA (最終行動列).

const HOW_IT_WORKS = [
  { step: '01', title: '查詢卡表', body: '中日文名稱、卡號、效果與收錄彈數全文搜尋，六種篩選一起疊。' },
  { step: '02', title: '拍照估值', body: '拍一張卡片就辨識卡號與版本，掃完一盒直接看到整份估值清單。' },
  { step: '03', title: '組牌出門', body: '50 + 20 + 1 邊組邊檢查，缺卡自動列出來，賽事牌組一鍵匯入。' },
];

const COLLECTION_HIGHLIGHTS = [
  { title: '36 個收錄系列', body: 'hOCG 從 hSD01 一路到最新彈都在，官方卡表同步更新。' },
  { title: '每日行情更新', body: '遊々亭參考行情每日刷新，同時看漲跌與 7 / 30 / 90 日走勢。' },
  { title: '缺卡預估總額', body: '牌組編輯器算出缺哪幾張，並用當前市價估算補齊所需金額。' },
];

const FAQ = [
  {
    q: '需要付費才能使用嗎？',
    a: 'HoloHunter 目前所有查詢、收藏、組牌、賽事月報與規則教學都是免費。每月 100 次卡片辨識掃描亦包含在免費會員內。訂閱與 App 內購尚未開放；未來付費方案上線時會透過 App Store / Google Play / Stripe 的既有金流處理，金額透過 Store API 動態載入。',
  },
  {
    q: '沒有帳號可以先試用嗎？',
    a: '可以。以訪客身份直接進入即可使用卡表檢索、規則教學、模擬對局與牌組編輯器；拍照掃描與跨裝置同步需登入 Google 或 Apple 帳號。',
  },
  {
    q: '卡牌影像會被上傳到伺服器嗎？',
    a: '手機 App：文字辨識在本機完成，卡牌影像不會離開您的裝置。網頁版：影像會傳送到伺服器端點，交由 Google Gemini 即時辨識，辨識後不作長期儲存。詳見隱私權政策。',
  },
  {
    q: 'iOS / Android / 網頁版功能一致嗎？',
    a: '介面與資料一致；掃描辨識的實作因平台不同（手機用裝置端 OCR、網頁用 AI 視覺辨識）。跨裝置同步以帳號雲端後端為準。',
  },
];

// DIC-1380 W7 CR — standalone Price section. The previous Landing only
// carried price data as a Hero-visual teaser; the accepted Pen composition
// pins a dedicated section that previews the market-data breadth (multi-
// currency, multi-timeframe, gap-estimate). Copy is consistent with what
// the price surfaces actually deliver today.
const PRICE_ROWS = [
  {
    name: '星街すいせい UR',
    number: 'hSD01-016',
    price: 'NT$ 3,600',
    currencySecondary: '¥ 17,600',
    delta: '+2.4%',
    trend: 'up',
  },
  {
    name: '兎田ぺこら SR',
    number: 'hBP01-042',
    price: 'NT$ 1,860',
    currencySecondary: '¥ 9,100',
    delta: '+0.6%',
    trend: 'up',
  },
  {
    name: 'ラプラス・ダークネス C',
    number: 'hBP02-088',
    price: 'NT$ 40',
    currencySecondary: '¥ 200',
    delta: '-1.2%',
    trend: 'down',
  },
] as const;

function PriceRow({ name, number, price, currencySecondary, delta, trend }: typeof PRICE_ROWS[number]) {
  return (
    <View style={styles.priceRow} testID={`landing-price-row-${number}`}>
      <View style={styles.priceRowCopy}>
        <Text style={styles.priceRowName} numberOfLines={1}>{name}</Text>
        <Text style={styles.priceRowNumber} numberOfLines={1}>{number}</Text>
      </View>
      <View style={styles.priceRowValues}>
        <Text style={styles.priceRowPrice}>{price}</Text>
        <Text style={styles.priceRowCurrencySecondary}>{currencySecondary}</Text>
      </View>
      <View style={[styles.priceRowDelta, trend === 'down' && styles.priceRowDeltaDown]}>
        <Text style={styles.priceRowDeltaText}>{delta}</Text>
      </View>
    </View>
  );
}

function HowStep({ step, title, body }: { step: string; title: string; body: string }) {
  return (
    <View style={styles.howStep} testID={`landing-how-${step}`}>
      <View style={styles.howStepNumberWrap}>
        <Text style={styles.howStepNumber}>{step}</Text>
      </View>
      <Text style={styles.howStepTitle}>{title}</Text>
      <Text style={styles.howStepBody}>{body}</Text>
    </View>
  );
}

function CollectionCard({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.collectionCard} testID={`landing-collection-${title}`}>
      <View style={styles.collectionDot} />
      <Text style={styles.collectionTitle}>{title}</Text>
      <Text style={styles.collectionBody}>{body}</Text>
    </View>
  );
}

function FaqItem({ q, a }: { q: string; a: string }) {
  return (
    <View style={styles.faqItem} testID={`landing-faq-${q}`}>
      <Text style={styles.faqQuestion}>Q. {q}</Text>
      <Text style={styles.faqAnswer}>{a}</Text>
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

function StatCard({ value, label, mobile }: { value: string; label: string; mobile: boolean }) {
  return (
    <View style={[styles.statCard, mobile && styles.statCardMobile]} testID={`landing-stat-${label}`}>
      <Text style={[styles.statValue, mobile && styles.statValueMobile]} numberOfLines={1}>{value}</Text>
      <Text style={styles.statLabel} numberOfLines={2}>{label}</Text>
    </View>
  );
}

function FeatureCard({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.featureCard} testID={`landing-feature-${title}`}>
      <View style={styles.featureDot} />
      <Text style={styles.featureTitle}>{title}</Text>
      <Text style={styles.featureBody}>{body}</Text>
    </View>
  );
}

export default function LandingScreen() {
  const { t } = useTranslation();
  const { width } = useBreakpoint();
  const isDesktop = width >= 768;
  const { continueAsGuest, loginWithGoogle, isLoading, error, clearError } = useAuthStore();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const handleGuest = useCallback(async () => {
    try { await continueAsGuest(); } catch {}
  }, [continueAsGuest]);

  // Google login is gated by the same fail-closed OAuth-provisioning flow
  // the rest of the app uses. Under the Pen's truthful "coming soon"
  // framing, we still call `loginWithGoogle()` when the CTA is tapped: if
  // the provider is provisioned it works, and if it is not the auth
  // store surfaces a friendly error the "coming soon" pill already warns
  // the user about.
  const handleGoogle = useCallback(async () => {
    try { await loginWithGoogle(); } catch {}
  }, [loginWithGoogle]);

  const eyebrow = isDesktop
    ? '非官方工具 · 介面與卡名支援中文 / 日本語'
    : 'hOCG · 非官方查詢工具 · 支援中日文';

  const noteText = isDesktop
    ? '訪客可查卡與看規則 · 掃描與收藏需登入（Google 登入即將推出）'
    : '訪客可查卡與看規則 · 掃描與收藏需登入（Google／Apple 登入與跨裝置同步陸續推出）';

  return (
    <SafeAreaView style={styles.container} testID="landing-screen">
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        {/* NAV — Pen `avS3j` desktop / `bDwDO` mobile */}
        <View
          style={[styles.nav, isDesktop && styles.navDesktop]}
          testID="landing-nav"
        >
          <View style={styles.navBrand}>
            <View style={styles.brandMark} />
            <Text style={styles.brandText}>HoloHunter</Text>
          </View>
          {isDesktop ? (
            <>
              <View style={styles.navLinks} testID="landing-nav-links">
                {NAV_LINKS.map((link) => (
                  <TouchableOpacity key={link} style={styles.navLinkTap} accessibilityRole="link" onPress={handleGuest}>
                    <Text style={styles.navLink}>{link}</Text>
                  </TouchableOpacity>
                ))}
              </View>
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
                    <ActivityIndicator color="#fff" size="small" />
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

        {/* HERO — Pen `Rlx6E` desktop / `LX2IZ` mobile */}
        <View style={[styles.section, styles.hero, isDesktop && styles.heroDesktop]} testID="landing-hero">
          <View style={styles.heroCopy}>
            <View style={styles.eyebrowPill}>
              <View style={styles.pillBadge} />
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
                style={[styles.ctaPrimary, isLoading && styles.ctaDisabled]}
                onPress={handleGuest}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-cta-guest"
              >
                {isLoading ? (
                  <ActivityIndicator color="#fff" size="small" />
                ) : (
                  <Text style={styles.ctaPrimaryText}>以訪客登入</Text>
                )}
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.ctaGoogle}
                onPress={handleGoogle}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-cta-google"
              >
                <ComingSoonPill text="即將推出" />
                <Text style={styles.ctaGoogleText}>使用 Google 帳號</Text>
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
          {isDesktop && (
            <View style={styles.heroVisual} testID="landing-hero-visual">
              {/* DIC-1380 W8 CR — Pen three CARD-ART hero (not text price
                  cards). The accepted Pen anchors three card-shaped
                  tiles that preview the catalog visually: rarity color
                  strip, card name, card number, rarity badge, and a
                  compact price ribbon (retains the market-data teaser
                  from W7). Sparkline stays on the primary tile. Real
                  card artwork is not fetched from the Landing to
                  preserve the privacy-policy "no external images on
                  Landing" contract; the tile visually reads as a card
                  with a stylised gradient art panel. */}
              <View style={styles.heroCardArt} testID="landing-hero-card-primary">
                <View style={styles.heroCardArtStripUR} testID="landing-hero-cardart-primary-art" />
                <View style={styles.heroCardArtBody}>
                  <View style={styles.heroCardArtHeader}>
                    <Text style={styles.heroCardArtName} numberOfLines={1}>星街すいせい</Text>
                    <View style={styles.heroCardArtRarityUR}><Text style={styles.heroCardArtRarityText}>UR</Text></View>
                  </View>
                  <Text style={styles.heroCardArtNumber}>hSD01-016</Text>
                  <View style={styles.heroVisualPriceRow}>
                    <Text style={styles.heroVisualPriceCompact}>NT$ 3,600</Text>
                    <View style={styles.heroVisualDelta}>
                      <Text style={styles.heroVisualDeltaText}>+2.4%</Text>
                    </View>
                  </View>
                  <View style={styles.heroVisualSparkline} testID="landing-hero-sparkline">
                    {[8, 12, 10, 14, 18, 16, 22, 20, 26, 24, 30, 28, 32, 34].map((h, i) => (
                      <View key={i} style={[styles.heroVisualBar, { height: h }]} />
                    ))}
                  </View>
                </View>
              </View>
              <View style={styles.heroCardArtSecondary} testID="landing-hero-card-secondary">
                <View style={styles.heroCardArtStripSR} testID="landing-hero-cardart-secondary-art" />
                <View style={styles.heroCardArtBodySmall}>
                  <View style={styles.heroCardArtHeader}>
                    <Text style={styles.heroCardArtName} numberOfLines={1}>兎田ぺこら</Text>
                    <View style={styles.heroCardArtRaritySR}><Text style={styles.heroCardArtRarityText}>SR</Text></View>
                  </View>
                  <Text style={styles.heroCardArtNumber}>hBP01-042</Text>
                  <Text style={styles.heroVisualPriceSmall}>NT$ 1,180  ·  +0.6%</Text>
                </View>
              </View>
              <View style={styles.heroCardArtSecondary} testID="landing-hero-card-tertiary">
                <View style={styles.heroCardArtStripC} testID="landing-hero-cardart-tertiary-art" />
                <View style={styles.heroCardArtBodySmall}>
                  <View style={styles.heroCardArtHeader}>
                    <Text style={styles.heroCardArtName} numberOfLines={1}>ラプラス・ダークネス</Text>
                    <View style={styles.heroCardArtRarityC}><Text style={styles.heroCardArtRarityText}>C</Text></View>
                  </View>
                  <Text style={styles.heroCardArtNumber}>hBP02-088</Text>
                  <Text style={styles.heroVisualPriceSmall}>NT$ 40  ·  −1.2%</Text>
                </View>
              </View>
            </View>
          )}
        </View>

        {/* STATS BAR — Pen `vfBpS` desktop / `ufjjN` mobile */}
        <View style={[styles.section, styles.statsBar, isDesktop && styles.statsBarDesktop]} testID="landing-stats-bar">
          {STATS.map((s) => <StatCard key={s.label} value={s.value} label={s.label} mobile={!isDesktop} />)}
        </View>

        {/* FEATURES — Pen `GAolm` desktop / `r41z2` mobile */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-features">
          <Text style={styles.eyebrowLabel}>App 功能</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            從查一張卡，{isDesktop ? '\n' : ''}到帶一副牌組出門
          </Text>
          <Text style={styles.sectionSubhead}>
            HoloHunter 把卡表、行情、掃描、組牌與賽事資料接成一條動線，不用在拍賣網站、官方卡表和自己的試算表之間來回切換。
          </Text>
          <View style={[styles.featureGrid, isDesktop && styles.featureGridDesktop]}>
            {FEATURES.map((f) => <FeatureCard key={f.title} title={f.title} body={f.body} />)}
          </View>
        </View>

        {/* HOW IT WORKS — Pen additional section (DIC-1380 W6 CR full parity) */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-how-it-works">
          <Text style={styles.eyebrowLabel}>操作流程</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            三步驟開始使用
          </Text>
          <View style={[styles.howGrid, isDesktop && styles.howGridDesktop]}>
            {HOW_IT_WORKS.map((s) => <HowStep key={s.step} step={s.step} title={s.title} body={s.body} />)}
          </View>
        </View>

        {/* COLLECTION PREVIEW — Pen additional section (DIC-1380 W6 CR full parity) */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-collection-preview">
          <Text style={styles.eyebrowLabel}>資料範圍</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            從卡表到市價，一次到位
          </Text>
          <Text style={styles.sectionSubhead}>
            官方卡表、市價、規則教學、賽事月報都由同一個資料庫供應，跨裝置同步以帳號後端為準。
          </Text>
          <View style={[styles.collectionGrid, isDesktop && styles.collectionGridDesktop]}>
            {COLLECTION_HIGHLIGHTS.map((c) => <CollectionCard key={c.title} title={c.title} body={c.body} />)}
          </View>
        </View>

        {/* PRICE — Pen standalone price section (DIC-1380 W7 CR added, W8
            CR moved to sit immediately BEFORE Plans in the Pen section
            order: Nav → Hero → Stats → Features → How-It-Works →
            Collection Preview → Price → Plans → FAQ → Final CTA →
            Footer). Price is a Plans-adjacent surface (what you get for
            free) so the composition flows into the paid-tier framing
            below. */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-price">
          <Text style={styles.eyebrowLabel}>市場價格</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            NT$ · ¥ · $ 三幣別同時看
          </Text>
          <Text style={styles.sectionSubhead}>
            遊々亭參考行情每日刷新；每張卡同時列出台幣、日圓與美元換算，並附近 7 日的漲跌方向。
          </Text>
          <View style={[styles.priceList, isDesktop && styles.priceListDesktop]}>
            {PRICE_ROWS.map((row) => <PriceRow key={row.number} {...row} />)}
          </View>
          <Text style={styles.priceListNote}>
            資料來源：遊々亭 · 固定匯率換算 · Store MVP 版本 UI 直接使用免費會員範圍
          </Text>
        </View>

        {/* PLANS — Pen `mcRLH` desktop / `MPyoM` mobile */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-plans">
          <Text style={styles.eyebrowLabel}>方案</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            只有掃描有額度，其他都免費
          </Text>
          <Text style={styles.sectionSubhead}>
            查詢、收藏、組牌、賽事月報與規則教學都不收費。卡片辨識掃描每月 100 次。訂閱付費暫未開放。
          </Text>
          <View style={[styles.plansGrid, isDesktop && styles.plansGridDesktop]}>
            <View style={styles.planCard} testID="landing-plan-free">
              <Text style={styles.planTitle}>免費會員</Text>
              <Text style={styles.planTagline}>不用付費，登入即可使用</Text>
              <View style={styles.planPriceRow}>
                <Text style={styles.planPrice}>NT$ 0</Text>
                <Text style={styles.planPricePeriod}>/ 月</Text>
              </View>
              <View style={styles.planFeatureList}>
                {FREE_FEATURES.map((f) => (
                  <View key={f} style={styles.planFeatureRow}>
                    <Text style={styles.planFeatureCheck}>✓</Text>
                    <Text style={styles.planFeatureText}>{f}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.ctaPrimary, styles.planCta, isLoading && styles.ctaDisabled]}
                onPress={handleGuest}
                disabled={isLoading}
                accessibilityRole="button"
                testID="landing-plan-free-cta"
              >
                <Text style={styles.ctaPrimaryText}>以訪客登入</Text>
              </TouchableOpacity>
            </View>
            <View style={[styles.planCard, styles.planCardComingSoon]} testID="landing-plan-pro">
              <View style={styles.planHeaderRow}>
                <Text style={styles.planTitle}>Pro（規劃中）</Text>
                <ComingSoonPill text="即將推出" />
              </View>
              <Text style={styles.planTagline}>訂閱與付費升級尚未開放；目前所有功能均為免費會員範圍。</Text>
              <View style={styles.planPriceRow}>
                <Text style={styles.planPriceComing}>金額待訂</Text>
                <Text style={styles.planPricePeriod}>Store API 動態載入</Text>
              </View>
              <View style={styles.planFeatureList}>
                {COMING_SOON_FEATURES.map((f) => (
                  <View key={f} style={styles.planFeatureRow}>
                    <Text style={[styles.planFeatureCheck, styles.planFeatureCheckComing]}>○</Text>
                    <Text style={styles.planFeatureText}>{f}</Text>
                  </View>
                ))}
              </View>
              <TouchableOpacity
                style={[styles.planCta, styles.planCtaSecondary]}
                onPress={() => Linking.openURL('https://holohunter.dicoge.com/pricing.html').catch(() => {})}
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

        {/* FAQ — Pen additional section (DIC-1380 W6 CR full parity) */}
        <View style={[styles.section, isDesktop && styles.sectionDesktop]} testID="landing-faq">
          <Text style={styles.eyebrowLabel}>常見問題</Text>
          <Text style={[styles.sectionHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            上線前你可能會想問的
          </Text>
          <View style={styles.faqGrid}>
            {FAQ.map((f) => <FaqItem key={f.q} q={f.q} a={f.a} />)}
          </View>
        </View>

        {/* FINAL CTA — Pen additional closing section (DIC-1380 W6 CR full parity) */}
        <View style={[styles.section, styles.finalCta, isDesktop && styles.sectionDesktop]} testID="landing-final-cta">
          <Text style={[styles.sectionHeadline, styles.finalCtaHeadline, isDesktop && styles.sectionHeadlineDesktop]}>
            開始查卡與組牌
          </Text>
          <Text style={styles.sectionSubhead}>
            訪客可查卡與看規則，登入後可掃描、收藏、跨裝置同步；付費訂閱尚未開放。
          </Text>
          <View style={[styles.ctaRow, isDesktop && styles.ctaRowDesktop]}>
            <TouchableOpacity
              style={[styles.ctaPrimary, isLoading && styles.ctaDisabled]}
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
              style={styles.ctaGoogle}
              onPress={handleGoogle}
              disabled={isLoading}
              accessibilityRole="button"
              testID="landing-final-cta-google"
            >
              <ComingSoonPill text="即將推出" />
              <Text style={styles.ctaGoogleText}>使用 Google 帳號</Text>
            </TouchableOpacity>
          </View>
        </View>

        {/* FOOTER — Pen `TldCK` desktop / `r86yeO` mobile */}
        <View style={[styles.section, styles.footer, isDesktop && styles.footerDesktop]} testID="landing-footer">
          <View style={styles.footerLinksRow}>
            <TouchableOpacity onPress={() => Linking.openURL('https://holohunter.dicoge.com/terms.html').catch(() => {})} testID="landing-footer-terms">
              <Text style={styles.footerLink}>服務條款</Text>
            </TouchableOpacity>
            <Text style={styles.footerSep}>·</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://holohunter.dicoge.com/privacy.html').catch(() => {})} testID="landing-footer-privacy">
              <Text style={styles.footerLink}>隱私權政策</Text>
            </TouchableOpacity>
            <Text style={styles.footerSep}>·</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://holohunter.dicoge.com/pricing.html').catch(() => {})} testID="landing-footer-pricing">
              <Text style={styles.footerLink}>訂閱方案</Text>
            </TouchableOpacity>
            <Text style={styles.footerSep}>·</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://holohunter.dicoge.com/support.html').catch(() => {})} testID="landing-footer-support">
              <Text style={styles.footerLink}>技術支援</Text>
            </TouchableOpacity>
          </View>
          <Text style={styles.footerCopy}>
            © 2026 HoloHunter · 非官方工具，卡牌圖像與名稱版權屬於原公司
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: TOKENS.bg },
  scroll: { flex: 1 },
  scrollContent: { paddingBottom: TOKENS.safeMobile * 2 },
  section: { paddingHorizontal: TOKENS.safeMobile, paddingVertical: 32, alignSelf: 'stretch' },
  sectionDesktop: { paddingHorizontal: 40, alignItems: 'center' },

  // ── NAV ─────────────────────────────────────────────────────────────
  nav: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: TOKENS.safeMobile,
    paddingVertical: 14,
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.border,
    backgroundColor: TOKENS.bg,
  },
  navDesktop: {
    paddingHorizontal: 40,
    minHeight: 76,
  },
  navBrand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  brandMark: {
    width: 24,
    height: 24,
    borderRadius: 6,
    backgroundColor: TOKENS.accent,
  },
  brandText: {
    color: TOKENS.textPrimary,
    fontSize: 18,
    fontWeight: '800',
    letterSpacing: 0.4,
  },
  navLinks: { flexDirection: 'row', alignItems: 'center', gap: 24, flex: 1, justifyContent: 'center' },
  navLinkTap: { minHeight: TOKENS.minTouch, justifyContent: 'center', paddingHorizontal: 4 },
  navLink: { color: TOKENS.textSecondary, fontSize: 14, fontWeight: '600' },
  navActions: { flexDirection: 'row', alignItems: 'center', gap: 16 },
  navGuestLink: { minHeight: TOKENS.minTouch, justifyContent: 'center', paddingHorizontal: 4 },
  navGuestLinkText: { color: TOKENS.textSecondary, fontSize: 14, fontWeight: '600' },
  navCta: {
    minHeight: TOKENS.minTouch,
    paddingHorizontal: 20,
    borderRadius: 22,
    backgroundColor: TOKENS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  navCtaText: { color: '#fff', fontSize: 14, fontWeight: '700' },
  mobileMenuBtn: {
    width: TOKENS.minTouch,
    height: TOKENS.minTouch,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
  },
  mobileMenuIcon: { color: TOKENS.textPrimary, fontSize: 22, fontWeight: '700' },
  mobileMenu: {
    borderBottomWidth: 1,
    borderBottomColor: TOKENS.border,
    backgroundColor: TOKENS.surface,
  },
  mobileMenuItem: { paddingHorizontal: TOKENS.safeMobile, minHeight: TOKENS.minTouch, justifyContent: 'center' },
  mobileMenuItemText: { color: TOKENS.textPrimary, fontSize: 15, fontWeight: '600' },

  // ── HERO ────────────────────────────────────────────────────────────
  hero: { paddingVertical: 40, gap: 32 },
  heroDesktop: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 48,
    paddingVertical: 80,
    maxWidth: TOKENS.contentDesktop,
    alignSelf: 'center',
    width: '100%',
  },
  heroCopy: { flex: 1, gap: 20 },
  eyebrowPill: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 20,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
    maxWidth: '100%',
  },
  pillBadge: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: TOKENS.accent,
  },
  pillText: { color: TOKENS.textSecondary, fontSize: 12, fontWeight: '600', flexShrink: 1 },
  headline: {
    color: TOKENS.textPrimary,
    fontSize: 32,
    lineHeight: 40,
    fontWeight: '800',
    letterSpacing: -0.4,
  },
  headlineDesktop: { fontSize: 56, lineHeight: 64 },
  subhead: {
    color: TOKENS.textSecondary,
    fontSize: 15,
    lineHeight: 24,
    fontWeight: '400',
  },
  ctaRow: { flexDirection: 'column', gap: 12, marginTop: 8 },
  ctaRowDesktop: { flexDirection: 'row', flexWrap: 'wrap', gap: 16 },
  ctaPrimary: {
    minHeight: TOKENS.minTouch + 8,
    paddingHorizontal: 24,
    borderRadius: 26,
    backgroundColor: TOKENS.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  ctaPrimaryText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  ctaDisabled: { opacity: 0.6 },
  ctaGoogle: {
    minHeight: TOKENS.minTouch + 8,
    paddingHorizontal: 20,
    borderRadius: 26,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    gap: 10,
  },
  ctaGoogleText: { color: TOKENS.textPrimary, fontSize: 15, fontWeight: '600' },
  ctaNote: { flexDirection: 'row', alignItems: 'flex-start', gap: 8, marginTop: 4 },
  ctaNoteIcon: { fontSize: 14, marginTop: 2 },
  ctaNoteText: { color: TOKENS.textMuted, fontSize: 12, lineHeight: 18, flex: 1 },

  heroVisual: {
    width: 420,
    maxWidth: '45%',
    alignItems: 'stretch',
    justifyContent: 'center',
    gap: 12,
  },
  heroVisualCardSecondary: {
    width: '100%',
    backgroundColor: TOKENS.surface2,
    borderRadius: 12,
    padding: 14,
    borderWidth: 1,
    borderColor: TOKENS.border,
    gap: 6,
  },
  heroVisualTitleSmall: { color: TOKENS.textSecondary, fontSize: 12, fontWeight: '600' },
  heroVisualPriceRowSmall: { flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
  heroVisualPriceSmall: { color: TOKENS.textPrimary, fontSize: 14, fontWeight: '700' },
  heroVisualPriceCompact: { color: TOKENS.textPrimary, fontSize: 22, fontWeight: '800' },
  heroVisualDeltaDown: {
    backgroundColor: 'rgba(248,113,113,0.15)',
  },

  // ── DIC-1380 W8 CR: three CARD-ART tiles (not text price cards) ──
  // Card-shaped tiles with a stylised gradient art panel, rarity badge,
  // card name + number, and a compact price ribbon. No external image
  // fetch on the Landing (preserves the "Landing does not load external
  // card images" privacy contract).
  heroCardArt: {
    width: '100%',
    borderRadius: 16,
    borderWidth: 1,
    borderColor: TOKENS.border,
    backgroundColor: TOKENS.surface,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  heroCardArtBody: {
    flex: 1,
    padding: 16,
    gap: 8,
  },
  heroCardArtSecondary: {
    width: '100%',
    borderRadius: 12,
    borderWidth: 1,
    borderColor: TOKENS.border,
    backgroundColor: TOKENS.surface2,
    overflow: 'hidden',
    flexDirection: 'row',
  },
  heroCardArtBodySmall: {
    flex: 1,
    padding: 12,
    gap: 4,
  },
  heroCardArtStripUR: { width: 96, backgroundColor: TOKENS.accent, opacity: 0.85 },
  heroCardArtStripSR: { width: 72, backgroundColor: TOKENS.accent3, opacity: 0.7 },
  heroCardArtStripC: { width: 72, backgroundColor: TOKENS.accent2, opacity: 0.55 },
  heroCardArtHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  heroCardArtName: { color: TOKENS.textPrimary, fontSize: 15, fontWeight: '700', flexShrink: 1 },
  heroCardArtNumber: { color: TOKENS.textMuted, fontSize: 11, fontFamily: 'monospace' },
  heroCardArtRarityUR: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#FF4D9D' },
  heroCardArtRaritySR: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#8B5CF6' },
  heroCardArtRarityC: { paddingHorizontal: 8, paddingVertical: 3, borderRadius: 6, backgroundColor: '#6B7280' },
  heroCardArtRarityText: { color: '#fff', fontSize: 11, fontWeight: '800', letterSpacing: 0.5 },
  heroVisualCard: {
    width: '100%',
    backgroundColor: TOKENS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: TOKENS.border,
    gap: 14,
  },
  heroVisualTitle: { color: TOKENS.textPrimary, fontSize: 14, fontWeight: '600' },
  heroVisualPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 12 },
  heroVisualPrice: { color: TOKENS.textPrimary, fontSize: 32, fontWeight: '800' },
  heroVisualDelta: {
    backgroundColor: 'rgba(52,211,153,0.15)',
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  heroVisualDeltaText: { color: '#34D399', fontSize: 12, fontWeight: '700' },
  heroVisualSparkline: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 4,
    height: 40,
  },
  heroVisualBar: {
    flex: 1,
    minWidth: 8,
    borderRadius: 2,
    backgroundColor: TOKENS.accent,
    opacity: 0.85,
  },
  heroVisualSource: { color: TOKENS.textMuted, fontSize: 11 },

  // ── STATS BAR ──────────────────────────────────────────────────────
  statsBar: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 12,
    paddingVertical: 24,
  },
  statsBarDesktop: {
    justifyContent: 'space-between',
    maxWidth: TOKENS.contentDesktop,
    alignSelf: 'center',
    width: '100%',
    flexWrap: 'nowrap',
  },
  statCard: {
    flexGrow: 1,
    flexBasis: '45%',
    minWidth: 120,
    padding: 16,
    borderRadius: 12,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
    gap: 4,
  },
  statCardMobile: {
    flexBasis: '48%',
    padding: 12,
  },
  statValue: { color: TOKENS.textPrimary, fontSize: 22, fontWeight: '800' },
  statValueMobile: { fontSize: 18 },
  statLabel: { color: TOKENS.textSecondary, fontSize: 12, fontWeight: '500' },

  // ── SECTION LABELS ────────────────────────────────────────────────
  eyebrowLabel: {
    color: TOKENS.accent,
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 1.6,
    textTransform: 'uppercase',
  },
  sectionHeadline: {
    color: TOKENS.textPrimary,
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '800',
    marginTop: 8,
    letterSpacing: -0.2,
  },
  sectionHeadlineDesktop: { fontSize: 40, lineHeight: 48, textAlign: 'center' },
  sectionSubhead: {
    color: TOKENS.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    marginTop: 8,
    maxWidth: 760,
  },

  // ── FEATURES ──────────────────────────────────────────────────────
  featureGrid: {
    flexDirection: 'column',
    gap: 12,
    marginTop: 24,
    alignSelf: 'stretch',
  },
  featureGridDesktop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 20,
    maxWidth: TOKENS.contentDesktop,
    width: '100%',
    alignSelf: 'center',
  },
  featureCard: {
    padding: 20,
    borderRadius: 12,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
    gap: 8,
    flexBasis: '30%',
    flexGrow: 1,
    minWidth: 240,
  },
  featureDot: { width: 10, height: 10, borderRadius: 5, backgroundColor: TOKENS.accent2, marginBottom: 4 },
  featureTitle: { color: TOKENS.textPrimary, fontSize: 16, fontWeight: '700' },
  featureBody: { color: TOKENS.textSecondary, fontSize: 13, lineHeight: 20 },

  // ── PRICE (DIC-1380 W7 CR — standalone Pen section) ───────────────
  priceList: { flexDirection: 'column', gap: 8, marginTop: 24, alignSelf: 'stretch', maxWidth: 820, width: '100%' },
  priceListDesktop: { alignSelf: 'center' },
  priceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    padding: 14,
    borderRadius: 12,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
  },
  priceRowCopy: { flex: 1, minWidth: 0 },
  priceRowName: { color: TOKENS.textPrimary, fontSize: 14, fontWeight: '700' },
  priceRowNumber: { color: TOKENS.textMuted, fontSize: 11, marginTop: 2 },
  priceRowValues: { alignItems: 'flex-end', marginRight: 8 },
  priceRowPrice: { color: TOKENS.textPrimary, fontSize: 16, fontWeight: '700' },
  priceRowCurrencySecondary: { color: TOKENS.textSecondary, fontSize: 11, marginTop: 2 },
  priceRowDelta: { backgroundColor: 'rgba(52,211,153,0.15)', borderRadius: 6, paddingHorizontal: 8, paddingVertical: 4 },
  priceRowDeltaDown: { backgroundColor: 'rgba(248,113,113,0.15)' },
  priceRowDeltaText: { color: '#34D399', fontSize: 12, fontWeight: '700' },
  priceListNote: { color: TOKENS.textMuted, fontSize: 11, marginTop: 12, textAlign: 'center' },

  // ── HOW IT WORKS (DIC-1380 W6 CR — full Pen composition) ──────────
  howGrid: { flexDirection: 'column', gap: 16, marginTop: 24, alignSelf: 'stretch' },
  howGridDesktop: { flexDirection: 'row', gap: 20, maxWidth: TOKENS.contentDesktop, width: '100%', alignSelf: 'center' },
  howStep: { padding: 20, borderRadius: 12, backgroundColor: TOKENS.surface, borderWidth: 1, borderColor: TOKENS.border, gap: 8, flex: 1, minWidth: 220 },
  howStepNumberWrap: { width: 36, height: 36, borderRadius: 18, backgroundColor: TOKENS.accent, alignItems: 'center', justifyContent: 'center', marginBottom: 6 },
  howStepNumber: { color: '#fff', fontSize: 14, fontWeight: '800' },
  howStepTitle: { color: TOKENS.textPrimary, fontSize: 16, fontWeight: '700' },
  howStepBody: { color: TOKENS.textSecondary, fontSize: 13, lineHeight: 20 },

  // ── COLLECTION PREVIEW ────────────────────────────────────────────
  collectionGrid: { flexDirection: 'column', gap: 12, marginTop: 24, alignSelf: 'stretch' },
  collectionGridDesktop: { flexDirection: 'row', gap: 20, maxWidth: TOKENS.contentDesktop, width: '100%', alignSelf: 'center' },
  collectionCard: { padding: 20, borderRadius: 12, backgroundColor: TOKENS.surface2, borderWidth: 1, borderColor: TOKENS.border, gap: 8, flex: 1, minWidth: 220 },
  collectionDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: TOKENS.accent3, marginBottom: 6 },
  collectionTitle: { color: TOKENS.textPrimary, fontSize: 15, fontWeight: '700' },
  collectionBody: { color: TOKENS.textSecondary, fontSize: 13, lineHeight: 20 },

  // ── FAQ ───────────────────────────────────────────────────────────
  faqGrid: { flexDirection: 'column', gap: 12, marginTop: 24, alignSelf: 'stretch', maxWidth: 820, width: '100%' },
  faqItem: { padding: 18, borderRadius: 12, backgroundColor: TOKENS.surface, borderWidth: 1, borderColor: TOKENS.border, gap: 8 },
  faqQuestion: { color: TOKENS.textPrimary, fontSize: 15, fontWeight: '700' },
  faqAnswer: { color: TOKENS.textSecondary, fontSize: 13, lineHeight: 20 },

  // ── FINAL CTA ─────────────────────────────────────────────────────
  finalCta: { paddingVertical: 48, alignItems: 'center' },
  finalCtaHeadline: { textAlign: 'center' },

  // ── PLANS ─────────────────────────────────────────────────────────
  plansGrid: {
    flexDirection: 'column',
    gap: 16,
    marginTop: 24,
    alignSelf: 'stretch',
  },
  plansGridDesktop: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 24,
    maxWidth: TOKENS.contentDesktop,
    width: '100%',
    alignSelf: 'center',
  },
  planCard: {
    flex: 1,
    minWidth: 260,
    padding: 24,
    borderRadius: 16,
    backgroundColor: TOKENS.surface,
    borderWidth: 1,
    borderColor: TOKENS.border,
    gap: 12,
  },
  planCardComingSoon: {
    backgroundColor: TOKENS.surface2,
    borderColor: TOKENS.comingSoonBg,
  },
  planHeaderRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 },
  planTitle: { color: TOKENS.textPrimary, fontSize: 18, fontWeight: '800' },
  planTagline: { color: TOKENS.textSecondary, fontSize: 12, lineHeight: 18 },
  planPriceRow: { flexDirection: 'row', alignItems: 'baseline', gap: 8, marginTop: 4 },
  planPrice: { color: TOKENS.textPrimary, fontSize: 28, fontWeight: '800' },
  planPriceComing: { color: TOKENS.comingSoonFg, fontSize: 20, fontWeight: '700' },
  planPricePeriod: { color: TOKENS.textMuted, fontSize: 12 },
  planFeatureList: { gap: 8, marginTop: 6 },
  planFeatureRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 8 },
  planFeatureCheck: { color: TOKENS.accent2, fontSize: 14, fontWeight: '700', width: 16 },
  planFeatureCheckComing: { color: TOKENS.comingSoonFg },
  planFeatureText: { color: TOKENS.textSecondary, fontSize: 13, lineHeight: 20, flex: 1 },
  planCta: { marginTop: 12 },
  planCtaSecondary: {
    minHeight: TOKENS.minTouch + 4,
    paddingHorizontal: 20,
    borderRadius: 22,
    borderWidth: 1,
    borderColor: TOKENS.comingSoonBg,
    backgroundColor: 'transparent',
    alignItems: 'center',
    justifyContent: 'center',
  },
  planCtaSecondaryText: { color: TOKENS.comingSoonFg, fontSize: 14, fontWeight: '700' },
  plansFineprint: { color: TOKENS.textMuted, fontSize: 12, marginTop: 16, textAlign: 'center' },

  // ── FOOTER ────────────────────────────────────────────────────────
  footer: {
    borderTopWidth: 1,
    borderTopColor: TOKENS.border,
    paddingVertical: 24,
    alignItems: 'center',
    gap: 12,
  },
  footerDesktop: { paddingHorizontal: 40 },
  footerLinksRow: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, justifyContent: 'center' },
  footerLink: { color: TOKENS.textSecondary, fontSize: 13, fontWeight: '600', minHeight: TOKENS.minTouch, paddingVertical: 12 },
  footerSep: { color: TOKENS.textMuted, fontSize: 13, paddingHorizontal: 4 },
  footerCopy: { color: TOKENS.textMuted, fontSize: 12, textAlign: 'center', lineHeight: 18 },

  // ── ERROR + PILL ──────────────────────────────────────────────────
  comingSoonPill: {
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 10,
    backgroundColor: TOKENS.comingSoonBg,
  },
  comingSoonPillText: { color: TOKENS.comingSoonFg, fontSize: 11, fontWeight: '700' },
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
  errorText: { color: '#F87171', fontSize: 13, flex: 1 },
  errorDismiss: { color: '#F87171', fontSize: 16, paddingLeft: 12, fontWeight: '700' },
});
