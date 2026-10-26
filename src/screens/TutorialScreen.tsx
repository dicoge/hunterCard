import React, { useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { PALETTE, SEMANTIC, FONTS } from '../theme/tokensV2';
import { useTranslation } from '../i18n';
import { getTutorialData } from '../data/tutorialData';
import { useTutorialStore } from '../store/tutorialStore';
import { RouteShell } from '../components/shell';

const DESKTOP_BREAKPOINT = 768;

// DIC-1427 QA P0 — Pen `App / 12 規則教學` (frame DAQIq): gradient hero with a
// REAL progress bar (useTutorialStore), 章節 list with numbered chips and
// completed/active states, and the simulation entry tile. No fake locks and
// no static «3 / 5» copy — every state below reads from the persisted store.
export default function TutorialScreen({ navigation }: any) {
  const { t, language } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const isDesktop = screenWidth >= DESKTOP_BREAKPOINT;
  const tutorialData = useMemo(() => getTutorialData(language), [language]);
  const completedSections = useTutorialStore((s) => s.completedSections);
  const visitedSections = useTutorialStore((s) => s.visitedSections);
  const simulationCompleted = useTutorialStore((s) => s.simulationCompleted);

  const completedCount = tutorialData.filter((s) => completedSections[s.id]).length;
  const total = tutorialData.length;
  const progressRatio = total > 0 ? completedCount / total : 0;

  return (
    <RouteShell navigation={navigation} routeName="Tutorial" title={t('tutorial_title')} testID="tutorial-shell">
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.contentContainer, isDesktop && styles.contentContainerDesktop]}
        showsVerticalScrollIndicator={false}
      >
        <View style={isDesktop ? styles.desktopColumn : undefined}>
        {/* Hero (Pen DJCul): purple→pink gradient, eyebrow, title, progress) */}
        <View
          style={[
            styles.hero,
            Platform.OS === 'web'
              ? ({ backgroundImage: `linear-gradient(120deg, ${PALETTE.accent3} 0%, ${PALETTE.accent} 100%)` } as object)
              : { backgroundColor: PALETTE.accent3 },
          ]}
          testID="tutorial-hero"
        >
          <Text style={styles.heroEyebrow}>{t('tutorial_hero_subtitle')}</Text>
          <Text style={styles.heroTitle}>{t('tutorial_hero_headline')}</Text>
          <View style={styles.heroProgressTrack} testID="tutorial-hero-progress-bar">
            <View style={[styles.heroProgressFill, { width: `${Math.round(progressRatio * 100)}%` }]} />
          </View>
          <Text style={styles.heroProgressLabel} testID="tutorial-hero-progress-label">
            {t('tutorial_hero_progress', { done: completedCount, total })}
          </Text>
        </View>

        {/* 章節 (Pen ccVfh): numbered chapter rows with real states */}
        <Text style={styles.sectionHeading}>{t('tutorial_chapters_heading')}</Text>
        <View style={styles.chapterList}>
          {tutorialData.map((section, index) => {
            const completed = !!completedSections[section.id];
            const active = !completed && !!visitedSections[section.id];
            const sub = language === 'zh' && section.description
              ? section.description
              : section.phases
                ? t('tutorial_chapters_count', { count: section.phases.length })
                : section.items
                  ? t('tutorial_areas_count', { count: section.items.length })
                  : t('tutorial_view_details');
            return (
              <TouchableOpacity
                key={section.id}
                style={styles.chapterRow}
                onPress={() => navigation.navigate('TutorialDetail', { sectionId: section.id })}
                testID={`tutorial-section-${section.id}`}
                accessibilityRole="button"
                accessibilityLabel={section.title}
                activeOpacity={0.75}
              >
                <View style={styles.chapterNum}>
                  <Text style={styles.chapterNumText}>{String(index + 1).padStart(2, '0')}</Text>
                </View>
                <View style={styles.chapterMeta}>
                  <Text style={styles.chapterTitle} numberOfLines={1}>{section.title}</Text>
                  <Text style={styles.chapterSub} numberOfLines={1}>{sub}</Text>
                </View>
                {completed ? (
                  <Text style={[styles.chapterState, { color: PALETTE.cGreen }]} testID={`tutorial-chapter-state-${section.id}-completed`}>✓</Text>
                ) : active ? (
                  <Text style={[styles.chapterState, { color: PALETTE.accent }]} testID={`tutorial-chapter-state-${section.id}-active`}>▶</Text>
                ) : (
                  <Text style={[styles.chapterState, { color: PALETTE.textMuted }]} testID={`tutorial-chapter-state-${section.id}-open`}>›</Text>
                )}
              </TouchableOpacity>
            );
          })}
        </View>

        {/* 實戰演練 (Pen eA89D tiles row): the real simulation entry */}
        <Text style={styles.sectionHeading}>{t('tutorial_practice_heading')}</Text>
        <TouchableOpacity
          style={styles.simulationCard}
          onPress={() => navigation.navigate('TutorialSimulation')}
          activeOpacity={0.75}
          testID="tutorial-simulation-entry"
        >
          <View style={styles.simulationIconWrap}>
            <Text style={styles.simulationEmoji}>🎮</Text>
          </View>
          <View style={styles.simulationContent}>
            <Text style={styles.simulationTitle}>{t('tutorial_simulation')}</Text>
            <Text style={styles.simulationDesc} numberOfLines={2}>{t('tutorial_simulation_hint')}</Text>
          </View>
          {simulationCompleted ? (
            <Text style={[styles.chapterState, { color: PALETTE.cGreen }]} testID="tutorial-simulation-state-completed">✓</Text>
          ) : (
            <Text style={[styles.chapterState, { color: PALETTE.accent }]}>→</Text>
          )}
        </TouchableOpacity>

        {/* Source attribution + footer stay: real provenance, not decoration */}
        <View style={styles.sourceRow}>
          <Text style={styles.sourceLabel}>{t('tutorial_source')}</Text>
          <Text style={styles.sourceValue}>巴哈姆特 — 桜雪</Text>
        </View>
        <View style={styles.footer}>
          <Text style={styles.footerTitle}>hololive Card Game</Text>
          <Text style={styles.footerSub}>{t('tutorial_unofficial')}</Text>
        </View>
        </View>
      </ScrollView>
    </SafeAreaView>
    </RouteShell>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PALETTE.appBg },
  container: { flex: 1 },
  contentContainer: { paddingHorizontal: 16, paddingTop: 14, paddingBottom: 40 },
  contentContainerDesktop: { alignItems: 'center' },
  desktopColumn: { width: '100%', maxWidth: 720 },

  // Hero (Pen DJCul 358×119, r16, gradient, progress bar 8px)
  hero: { borderRadius: 16, paddingHorizontal: 18, paddingVertical: 16, marginBottom: 14 },
  heroEyebrow: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, textTransform: 'uppercase' },
  heroTitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: '#FFFFFF', fontSize: 17, fontWeight: '700', marginTop: 8,
  },
  heroProgressTrack: { height: 8, borderRadius: 8, backgroundColor: 'rgba(0,0,0,0.35)', marginTop: 12, overflow: 'hidden' },
  heroProgressFill: { height: 8, borderRadius: 8, backgroundColor: '#FFFFFF' },
  heroProgressLabel: { color: 'rgba(255,255,255,0.8)', fontSize: 11, fontWeight: '600', marginTop: 8 },

  sectionHeading: { color: SEMANTIC.onBg, fontSize: 15, fontWeight: '700', marginTop: 6, marginBottom: 10 },

  // Chapter rows (Pen gVpk3…: $app-surface r14, 34px num chip, state icon)
  chapterList: { gap: 10, marginBottom: 14 },
  chapterRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: PALETTE.appSurface, borderRadius: 14,
    paddingHorizontal: 14, paddingVertical: 12, minHeight: 63,
  },
  chapterNum: { width: 34, height: 34, borderRadius: 10, backgroundColor: PALETTE.appElev, alignItems: 'center', justifyContent: 'center' },
  chapterNumText: { color: SEMANTIC.onBgMuted, fontSize: 13, fontWeight: '700' },
  chapterMeta: { flex: 1, minWidth: 0, gap: 3 },
  chapterTitle: { color: SEMANTIC.onBg, fontSize: 14, fontWeight: '700' },
  chapterSub: { color: SEMANTIC.onBgDim, fontSize: 11 },
  chapterState: { fontSize: 18, fontWeight: '700', width: 24, textAlign: 'center' },

  // Simulation entry tile (real route, Pen tile language)
  simulationCard: {
    flexDirection: 'row', alignItems: 'center',
    backgroundColor: PALETTE.appSurface, borderRadius: 12, padding: 14,
    borderWidth: 1, borderColor: PALETTE.accent + '40', marginBottom: 18, gap: 12,
  },
  simulationIconWrap: { width: 44, height: 44, borderRadius: 12, backgroundColor: PALETTE.accent + '20', alignItems: 'center', justifyContent: 'center' },
  simulationEmoji: { fontSize: 22 },
  simulationContent: { flex: 1, minWidth: 0 },
  simulationTitle: { color: PALETTE.accent, fontSize: 15, fontWeight: '700', marginBottom: 3 },
  simulationDesc: { color: SEMANTIC.onBgMuted, fontSize: 12, lineHeight: 17 },

  sourceRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 4 },
  sourceLabel: { color: SEMANTIC.onBgDim, fontSize: 12 },
  sourceValue: { color: PALETTE.accent, fontSize: 12, fontWeight: '600' },
  footer: { marginTop: 20, paddingTop: 16, borderTopWidth: 1, borderTopColor: COLORS.border, alignItems: 'center' },
  footerTitle: { color: SEMANTIC.onBgMuted, fontSize: 13, fontWeight: '600', letterSpacing: 1 },
  footerSub: { color: SEMANTIC.onBgMuted, fontSize: 11, marginTop: 4, opacity: 0.6 },
});
