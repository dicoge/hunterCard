import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, Platform, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { PALETTE, SEMANTIC, FONTS } from '../theme/tokensV2';
import { getTutorialData } from '../data/tutorialData';
import { useTutorialStore } from '../store/tutorialStore';
import { useTranslation } from '../i18n';
import TutorialCard from '../components/tutorial/TutorialCard';
import TutorialPhaseCard from '../components/tutorial/TutorialPhaseCard';
import TutorialImageView from '../components/tutorial/TutorialImageView';
import { RouteShell } from '../components/shell';

const MOBILE_BREAKPOINT = 480;
const DESKTOP_BREAKPOINT = 768;

interface TutorialDetailScreenProps {
  route: { params: { sectionId: string } };
  navigation: any;
}

// DIC-1427 QA P0 — Pen `App / 13 教學詳情` (frame rV4Za): breadcrumb, CHAPTER
// hero card, 章節導覽 step navigator that really switches the visible phase,
// 開始模擬 / 完整文字 CTAs, and REAL chapter completion into useTutorialStore.
export default function TutorialDetailScreen({ route, navigation }: TutorialDetailScreenProps) {
  const { t, language } = useTranslation();
  const sections = getTutorialData(language);
  const section = sections.find((item) => item.id === route.params.sectionId) ?? sections[0];
  const chapterIndex = sections.indexOf(section);
  const { width: screenWidth } = useWindowDimensions();
  const isMobile = screenWidth < MOBILE_BREAKPOINT;
  const isDesktop = screenWidth >= DESKTOP_BREAKPOINT;

  const markSectionVisited = useTutorialStore((s) => s.markSectionVisited);
  const markSectionCompleted = useTutorialStore((s) => s.markSectionCompleted);
  const completed = useTutorialStore((s) => !!s.completedSections[section.id]);

  // Opening a chapter records the REAL visited state that powers the Pen
  // DAQIq «進行中» row marker.
  useEffect(() => { markSectionVisited(section.id); }, [section.id, markSectionVisited]);

  const phases = section.phases ?? [];
  const hasPhases = phases.length > 0;
  // null = 完整文字 (every phase visible, the classic long-read view);
  // a number = stepped mode showing exactly that phase (Pen P3N2f navigator).
  const [activePhase, setActivePhase] = useState<number | null>(null);
  useEffect(() => { setActivePhase(null); }, [section.id]);

  const visiblePhases = useMemo(
    () => (activePhase == null ? phases : phases.slice(activePhase, activePhase + 1)),
    [phases, activePhase],
  );

  const metaLine = hasPhases
    ? t('tutorial_chapters_count', { count: phases.length })
    : section.items && section.items.length > 0
      ? t('tutorial_areas_count', { count: section.items.length })
      : t('tutorial_view_details');

  const progressRatio = hasPhases
    ? (activePhase == null ? (completed ? 1 : 0) : (activePhase + 1) / phases.length)
    : (completed ? 1 : 0);

  return (
    <RouteShell navigation={navigation} routeName="TutorialDetail" title={section.title} testID="tutorial-detail-shell">
    <SafeAreaView style={styles.safeArea}>
      <ScrollView
        style={styles.container}
        contentContainerStyle={[styles.contentContainer, isDesktop && styles.contentContainerDesktop]}
        showsVerticalScrollIndicator={false}
        testID={`tutorial-detail-content-${section.id}`}
      >
        <View style={isDesktop ? styles.desktopColumn : undefined}>
        {/* Breadcrumb (Pen qOcyP) */}
        <View style={styles.crumb} testID="tutorial-detail-crumb">
          <TouchableOpacity onPress={() => (navigation?.goBack ? navigation.goBack() : navigation?.navigate?.('Tutorial'))} accessibilityRole="button">
            <Text style={styles.crumbRoot}>{t('tutorial_title')}</Text>
          </TouchableOpacity>
          <Text style={styles.crumbSep}>›</Text>
          <Text style={styles.crumbHere} numberOfLines={1}>{section.title}</Text>
        </View>

        {/* CHAPTER hero card (Pen Lpj3B) */}
        <View
          style={[
            styles.heroCard,
            Platform.OS === 'web'
              ? ({ backgroundImage: `linear-gradient(135deg, rgba(139,92,246,0.28) 0%, rgba(255,77,157,0.16) 100%)` } as object)
              : { backgroundColor: PALETTE.appSurface },
          ]}
          testID="tutorial-detail-hero"
        >
          <View style={styles.heroTop}>
            <View
              style={[
                styles.heroIconTile,
                Platform.OS === 'web'
                  ? ({ backgroundImage: `linear-gradient(135deg, ${PALETTE.accent3} 0%, ${PALETTE.accent} 100%)` } as object)
                  : { backgroundColor: PALETTE.accent3 },
              ]}
            >
              <Text style={styles.heroIconEmoji}>{section.icon}</Text>
            </View>
            <View style={styles.heroText}>
              <Text style={styles.heroChapterLabel}>{`CHAPTER ${String(chapterIndex + 1).padStart(2, '0')}`}</Text>
              <Text style={styles.heroTitle} numberOfLines={2}>{section.title}</Text>
              <Text style={styles.heroMeta}>{metaLine}{completed ? ` · ${t('tutorial_detail_completed')}` : ''}</Text>
            </View>
          </View>
          <View style={styles.heroProgressTrack}>
            <View style={[styles.heroProgressFill, { width: `${Math.round(progressRatio * 100)}%` }]} />
          </View>
        </View>

        {/* 章節導覽 step navigator (Pen P3N2f) — real phases only */}
        {hasPhases && (
          <>
            <Text style={styles.navHeading}>{t('tutorial_detail_nav_heading')}</Text>
            <View style={styles.stepList}>
              {phases.map((phase, index) => {
                const isActive = activePhase === index;
                const isDone = activePhase != null && index < activePhase;
                return (
                  <TouchableOpacity
                    key={`step-${index}`}
                    style={[styles.stepRow, isActive ? styles.stepRowActive : null]}
                    onPress={() => setActivePhase(index)}
                    accessibilityRole="button"
                    accessibilityState={{ selected: isActive }}
                    testID={`tutorial-detail-step-${index}`}
                    activeOpacity={0.75}
                  >
                    <View style={[
                      styles.stepDot,
                      isDone ? styles.stepDotDone : isActive ? styles.stepDotActive : null,
                    ]}>
                      <Text style={[styles.stepDotText, (isDone || isActive) ? styles.stepDotTextActive : null]}>
                        {isDone ? '✓' : String(index + 1).padStart(2, '0')}
                      </Text>
                    </View>
                    <Text style={[styles.stepTitle, isActive ? styles.stepTitleActive : null]} numberOfLines={1}>
                      {phase.title}
                    </Text>
                    {isActive ? <Text style={styles.stepBadge}>{t('tutorial_detail_chapter_progress', { current: index + 1, total: phases.length })}</Text> : null}
                  </TouchableOpacity>
                );
              })}
            </View>
          </>
        )}

        {/* Article card (Pen DsDm6): description + 開始模擬 / 完整文字 CTAs */}
        <View style={styles.articleCard}>
          {section.description ? (
            <Text style={[styles.description, isMobile && styles.descriptionMobile]}>
              {section.description}
            </Text>
          ) : null}
          <View style={styles.ctaRow}>
            <TouchableOpacity
              style={styles.ctaPrimary}
              onPress={() => navigation.navigate('TutorialSimulation')}
              accessibilityRole="button"
              testID="tutorial-detail-start-sim"
              activeOpacity={0.85}
            >
              <Text style={styles.ctaPrimaryText}>▶ {t('tutorial_detail_start_sim')}</Text>
            </TouchableOpacity>
            {hasPhases && (
              <TouchableOpacity
                style={[styles.ctaGhost, activePhase == null ? styles.ctaGhostActive : null]}
                onPress={() => setActivePhase(null)}
                accessibilityRole="button"
                testID="tutorial-detail-full-text"
                activeOpacity={0.85}
              >
                <Text style={styles.ctaGhostText}>{t('tutorial_detail_full_text')}</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>

        {/* Main images */}
        {section.images && section.images.length > 0 && (
          <TutorialCard>
            {section.images.map((img, index) => (
              <TutorialImageView
                key={`img-${index}`}
                uri={img.url}
                alt={img.alt}
                screenWidth={screenWidth}
              />
            ))}
          </TutorialCard>
        )}

        {/* Content items (for lists like field regions) */}
        {section.items && section.items.length > 0 && (
          <TutorialCard>
            {section.items.map((item, index) => (
              <View key={`item-${index}`} style={styles.itemRow}>
                <Text style={[styles.itemLabel, isMobile && styles.itemLabelMobile]}>
                  {item.label}
                </Text>
                <Text style={[styles.itemDesc, isMobile && styles.itemDescMobile]}>
                  {item.description}
                </Text>
              </View>
            ))}
          </TutorialCard>
        )}

        {/* Content (simple text list) */}
        {section.content && section.content.length > 0 && (
          <TutorialCard>
            {section.content.map((text, index) => (
              <View key={`content-${index}`} style={styles.contentRow}>
                <Text style={[styles.contentText, isMobile && styles.contentTextMobile]}>
                  {text}
                </Text>
              </View>
            ))}
          </TutorialCard>
        )}

        {/* Phases — full view (完整文字) or exactly the chosen step */}
        {visiblePhases.length > 0 && (
          <View>
            {visiblePhases.map((phase, index) => {
              const phaseIndex = activePhase == null ? index : activePhase;
              return (
                <View key={`phase-${phaseIndex}`} testID={`tutorial-detail-phase-${phaseIndex}`}>
                  <TutorialCard>
                    {phase.images && phase.images.length > 0 && (
                      <View style={styles.phaseImages}>
                        {phase.images.map((img, idx) => (
                          <TutorialImageView
                            key={`phase-img-${idx}`}
                            uri={img.url}
                            alt={img.alt}
                            screenWidth={screenWidth}
                          />
                        ))}
                      </View>
                    )}
                    <TutorialPhaseCard
                      phase={phase}
                      defaultExpanded={true}
                    />
                  </TutorialCard>
                </View>
              );
            })}
          </View>
        )}

        {/* Stepped-mode footer controls: previous / next / 完成本章.
            Walking past the last phase is what REALLY completes the chapter. */}
        {hasPhases && activePhase != null && (
          <View style={styles.stepNavRow}>
            {activePhase > 0 ? (
              <TouchableOpacity
                style={styles.ctaGhost}
                onPress={() => setActivePhase(activePhase - 1)}
                accessibilityRole="button"
                testID="tutorial-detail-prev-phase"
                activeOpacity={0.85}
              >
                <Text style={styles.ctaGhostText}>← {t('tutorial_simulation_previous')}</Text>
              </TouchableOpacity>
            ) : <View />}
            {activePhase < phases.length - 1 ? (
              <TouchableOpacity
                style={styles.ctaPrimary}
                onPress={() => setActivePhase(activePhase + 1)}
                accessibilityRole="button"
                testID="tutorial-detail-next-phase"
                activeOpacity={0.85}
              >
                <Text style={styles.ctaPrimaryText}>{t('tutorial_simulation_next')}</Text>
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[styles.ctaPrimary, completed ? styles.ctaPrimaryDone : null]}
                onPress={() => markSectionCompleted(section.id)}
                accessibilityRole="button"
                testID="tutorial-detail-complete"
                activeOpacity={0.85}
              >
                <Text style={styles.ctaPrimaryText}>
                  {completed ? t('tutorial_detail_completed') : t('tutorial_detail_complete')}
                </Text>
              </TouchableOpacity>
            )}
          </View>
        )}

        {/* Links */}
        {section.links && section.links.length > 0 && (
          <TutorialCard>
            <Text style={[styles.linksTitle, isMobile && styles.linksTitleMobile]}>
              {t('tutorial_detail_links')}
            </Text>
            {section.links.map((link, index) => (
              <TouchableOpacity
                key={`link-${index}`}
                style={styles.linkButton}
                onPress={() => Linking.openURL(link.url)}
                activeOpacity={0.7}
              >
                <Text style={styles.linkIcon}>🌐</Text>
                <Text style={[styles.linkText, isMobile && styles.linkTextMobile]}>
                  {link.label}
                </Text>
              </TouchableOpacity>
            ))}
          </TutorialCard>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, isMobile && styles.footerTextMobile]}>
            {t('tutorial_detail_source')}
          </Text>
          <Text style={[styles.footerDate, isMobile && styles.footerDateMobile]}>
            {t('tutorial_detail_updated')}
          </Text>
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

  // Breadcrumb (Pen qOcyP)
  crumb: { flexDirection: 'row', alignItems: 'center', gap: 6, marginBottom: 14 },
  crumbRoot: { color: SEMANTIC.onBgDim, fontSize: 11 },
  crumbSep: { color: SEMANTIC.onBgDim, fontSize: 11 },
  crumbHere: { color: SEMANTIC.onBgMuted, fontSize: 11, fontWeight: '600', flexShrink: 1 },

  // CHAPTER hero card (Pen Lpj3B 358×174 r16)
  heroCard: { borderRadius: 16, padding: 20, backgroundColor: PALETTE.appSurface, marginBottom: 16 },
  heroTop: { flexDirection: 'row', gap: 18 },
  heroIconTile: { width: 56, height: 56, borderRadius: 14, alignItems: 'center', justifyContent: 'center' },
  heroIconEmoji: { fontSize: 26 },
  heroText: { flex: 1, minWidth: 0 },
  heroChapterLabel: { color: PALETTE.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1 },
  heroTitle: {
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    color: SEMANTIC.onBg, fontSize: 20, fontWeight: '700', marginTop: 4,
  },
  heroMeta: { color: SEMANTIC.onBgDim, fontSize: 11, marginTop: 8 },
  heroProgressTrack: { height: 6, borderRadius: 6, backgroundColor: 'rgba(0,0,0,0.35)', marginTop: 18, overflow: 'hidden' },
  heroProgressFill: { height: 6, borderRadius: 6, backgroundColor: PALETTE.accent2 },

  // Step navigator (Pen P3N2f)
  navHeading: { color: SEMANTIC.onBg, fontSize: 14, fontWeight: '700', marginBottom: 10 },
  stepList: { gap: 8, marginBottom: 16 },
  stepRow: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    backgroundColor: PALETTE.appSurface, borderRadius: 12,
    paddingHorizontal: 12, paddingVertical: 10, minHeight: 48,
  },
  stepRowActive: { backgroundColor: PALETTE.appElev },
  stepDot: { width: 28, height: 28, borderRadius: 999, backgroundColor: PALETTE.appElev, alignItems: 'center', justifyContent: 'center' },
  stepDotActive: { backgroundColor: PALETTE.accent },
  stepDotDone: { backgroundColor: 'rgba(52,211,153,0.22)' },
  stepDotText: { color: SEMANTIC.onBgDim, fontSize: 11, fontWeight: '700' },
  stepDotTextActive: { color: '#FFFFFF' },
  stepTitle: { flex: 1, minWidth: 0, color: SEMANTIC.onBg, fontSize: 13, fontWeight: '500' },
  stepTitleActive: { fontWeight: '700' },
  stepBadge: { color: PALETTE.accent, fontSize: 11, fontWeight: '700' },

  // Article card + CTAs (Pen DsDm6 / tz0Aa / ThoBL)
  articleCard: { backgroundColor: PALETTE.appSurface, borderRadius: 14, padding: 16, marginBottom: 16 },
  description: { color: SEMANTIC.onBgMuted, fontSize: 14, lineHeight: 22, marginBottom: 12 },
  descriptionMobile: { fontSize: 12.5, lineHeight: 20 },
  ctaRow: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
  ctaPrimary: { backgroundColor: PALETTE.accent, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 37, alignItems: 'center', justifyContent: 'center' },
  ctaPrimaryDone: { backgroundColor: PALETTE.cGreen },
  ctaPrimaryText: { color: '#FFFFFF', fontSize: 12, fontWeight: '700' },
  ctaGhost: { backgroundColor: PALETTE.appElev, borderRadius: 12, paddingHorizontal: 14, paddingVertical: 10, minHeight: 37, alignItems: 'center', justifyContent: 'center' },
  ctaGhostActive: { borderWidth: 1, borderColor: PALETTE.accent + '66' },
  ctaGhostText: { color: SEMANTIC.onBgMuted, fontSize: 12, fontWeight: '600' },
  stepNavRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16, gap: 10 },

  itemRow: {
    flexDirection: 'row',
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  itemLabel: {
    color: COLORS.primary,
    fontSize: 15,
    fontWeight: '700',
    width: 80,
    marginRight: 8,
  },
  itemLabelMobile: {
    fontSize: 13,
    width: 65,
  },
  itemDesc: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    flex: 1,
  },
  itemDescMobile: {
    fontSize: 12,
    lineHeight: 18,
  },
  contentRow: {
    marginBottom: 10,
    paddingVertical: 4,
  },
  contentText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 24,
  },
  contentTextMobile: {
    fontSize: 13,
    lineHeight: 21,
  },
  phaseImages: {
    marginBottom: 8,
  },
  linksTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
  },
  linksTitleMobile: {
    fontSize: 14,
    marginBottom: 12,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  linkIcon: {
    fontSize: 18,
    marginRight: 12,
  },
  linkText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    textDecorationLine: 'underline',
  },
  linkTextMobile: {
    fontSize: 12,
  },
  footer: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    alignItems: 'center',
  },
  footerText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 4,
  },
  footerTextMobile: {
    fontSize: 11,
  },
  footerDate: {
    color: COLORS.textSecondary,
    fontSize: 11,
    opacity: 0.7,
  },
  footerDateMobile: {
    fontSize: 10,
  },
});
