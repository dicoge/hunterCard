import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { useTranslation } from '../i18n';
import tutorialData from '../data/tutorialData';

const MOBILE_BREAKPOINT = 480;

export default function TutorialScreen({ navigation }: any) {
  const { t, language } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const isMobile = screenWidth < MOBILE_BREAKPOINT;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView 
        style={styles.container}
        contentContainerStyle={[styles.contentContainer, isMobile && styles.contentContainerMobile]}
        showsVerticalScrollIndicator={false}
      >
        {/* Hero */}
        <View style={[styles.hero, isMobile && styles.heroMobile]}>
          <Text style={[styles.heroEmoji, isMobile && styles.heroEmojiMobile]}>📚</Text>
          <Text style={[styles.heroTitle, isMobile && styles.heroTitleMobile]}>{t('tutorial_title')}</Text>
          <Text style={[styles.heroSub, isMobile && styles.heroSubMobile]}>{t('tutorial_hero_subtitle')}</Text>
        </View>

        {/* Description */}
        <View style={styles.introCard}>
          <Text style={[styles.introText, isMobile && styles.introTextMobile]}>
            {t('tutorial_intro_one')}
          </Text>
          <Text style={[styles.introText, isMobile && styles.introTextMobile]}>
            {t('tutorial_intro_two')}
          </Text>
          <View style={styles.sourceRow}>
            <Text style={styles.sourceLabel}>{t('tutorial_source')}</Text>
            <Text style={styles.sourceValue}>巴哈姆特 — 桜雪</Text>
          </View>
        </View>

        {/* Category Grid */}
        <View style={[styles.grid, isMobile && styles.gridMobile]}>
          {tutorialData.map((section) => (
            <TouchableOpacity
              key={section.id}
              style={[styles.categoryCard, isMobile && styles.categoryCardMobile]}
              onPress={() => navigation.navigate('TutorialDetail', { section })}
              activeOpacity={0.7}
            >
              <View style={[styles.categoryIconWrap, isMobile && styles.categoryIconWrapMobile]}>
                <Text style={[styles.categoryIcon, isMobile && styles.categoryIconMobile]}>
                  {section.icon}
                </Text>
              </View>
              <Text style={[styles.categoryTitle, isMobile && styles.categoryTitleMobile]}>
                {t(`tutorial_section_${section.id}` as Parameters<typeof t>[0])}
              </Text>
              <Text 
                style={[styles.categoryDesc, isMobile && styles.categoryDescMobile]} 
                numberOfLines={2}
              >
                {language === 'zh' && section.description ? section.description : (
                  section.phases ? t('tutorial_chapters_count', { count: section.phases.length }) :
                  section.items ? t('tutorial_areas_count', { count: section.items.length }) :
                  t('tutorial_view_details')
                )}
              </Text>
              <View style={styles.arrowRow}>
                <Text style={[styles.arrowText, isMobile && styles.arrowTextMobile]}>
                  {t('tutorial_start_learning')}
                </Text>
                <Text style={[styles.arrow, isMobile && styles.arrowMobile]}>→</Text>
              </View>
            </TouchableOpacity>
          ))}
        </View>

        {/* Simulation Entry Card */}
        <TouchableOpacity
          style={[styles.simulationCard, isMobile && styles.simulationCardMobile]}
          onPress={() => navigation.navigate('TutorialSimulation')}
          activeOpacity={0.7}
        >
          <View style={[styles.simulationIconWrap, isMobile && styles.simulationIconWrapMobile]}>
            <Text style={[styles.simulationEmoji, isMobile && styles.simulationEmojiMobile]}>🎮</Text>
          </View>
          <View style={styles.simulationContent}>
            <Text style={[styles.simulationTitle, isMobile && styles.simulationTitleMobile]}>
              {t('tutorial_simulation')}
            </Text>
            <Text style={[styles.simulationDesc, isMobile && styles.simulationDescMobile]}>
              {t('tutorial_simulation_hint')}
            </Text>
          </View>
          <Text style={[styles.simulationArrow, isMobile && styles.simulationArrowMobile]}>→</Text>
        </TouchableOpacity>

        {/* Footer */}
        <View style={[styles.footer, isMobile && styles.footerMobile]}>
          <Text style={[styles.footerTitle, isMobile && styles.footerTitleMobile]}>
            hololive Card Game
          </Text>
          <Text style={[styles.footerSub, isMobile && styles.footerSubMobile]}>
            {t('tutorial_unofficial')}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 20,
    paddingBottom: 40,
  },
  contentContainerMobile: {
    padding: 12,
    paddingBottom: 32,
  },
  hero: {
    alignItems: 'center',
    paddingVertical: 28,
    marginBottom: 8,
  },
  heroMobile: {
    paddingVertical: 18,
    marginBottom: 4,
  },
  heroEmoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  heroEmojiMobile: {
    fontSize: 36,
    marginBottom: 8,
  },
  heroTitle: {
    color: COLORS.text,
    fontSize: 28,
    fontWeight: 'bold',
    letterSpacing: 2,
  },
  heroTitleMobile: {
    fontSize: 22,
    letterSpacing: 1,
  },
  heroSub: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
    letterSpacing: 3,
    marginTop: 6,
  },
  heroSubMobile: {
    fontSize: 12,
    letterSpacing: 2,
    marginTop: 4,
  },
  introCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    marginBottom: 24,
    borderWidth: 1,
    borderColor: COLORS.border,
    borderLeftWidth: 3,
    borderLeftColor: COLORS.primary,
  },
  introText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    marginBottom: 8,
  },
  introTextMobile: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 6,
  },
  sourceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 8,
    paddingTop: 12,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  sourceLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  sourceValue: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  grid: {
    gap: 14,
  },
  gridMobile: {
    gap: 10,
  },
  categoryCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    borderWidth: 1,
    borderColor: COLORS.border,
    position: 'relative',
    overflow: 'hidden',
  },
  categoryCardMobile: {
    borderRadius: 12,
    padding: 14,
  },
  categoryIconWrap: {
    width: 48,
    height: 48,
    borderRadius: 14,
    backgroundColor: COLORS.surfaceLight,
    justifyContent: 'center',
    alignItems: 'center',
    marginBottom: 12,
  },
  categoryIconWrapMobile: {
    width: 40,
    height: 40,
    borderRadius: 12,
    marginBottom: 8,
  },
  categoryIcon: {
    fontSize: 26,
  },
  categoryIconMobile: {
    fontSize: 22,
  },
  categoryTitle: {
    color: COLORS.text,
    fontSize: 18,
    fontWeight: '700',
    marginBottom: 6,
  },
  categoryTitleMobile: {
    fontSize: 15,
    marginBottom: 4,
  },
  categoryDesc: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
    marginBottom: 12,
  },
  categoryDescMobile: {
    fontSize: 12,
    lineHeight: 17,
    marginBottom: 8,
  },
  arrowRow: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  arrowText: {
    color: COLORS.primary,
    fontSize: 13,
    fontWeight: '600',
    marginRight: 6,
  },
  arrowTextMobile: {
    fontSize: 12,
  },
  arrow: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  arrowMobile: {
    fontSize: 14,
  },
  footer: {
    marginTop: 32,
    paddingTop: 20,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    alignItems: 'center',
  },
  footerMobile: {
    marginTop: 24,
    paddingTop: 16,
  },
  footerTitle: {
    color: COLORS.textSecondary,
    fontSize: 13,
    fontWeight: '600',
    letterSpacing: 1,
  },
  footerTitleMobile: {
    fontSize: 11,
  },
  footerSub: {
    color: COLORS.textSecondary,
    fontSize: 11,
    marginTop: 4,
    opacity: 0.6,
  },
  footerSubMobile: {
    fontSize: 10,
  },
  simulationCard: {
    backgroundColor: COLORS.surface,
    borderRadius: 16,
    padding: 20,
    marginTop: 8,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.primary + '40',
    flexDirection: 'row',
    alignItems: 'center',
    position: 'relative',
    overflow: 'hidden',
  },
  simulationCardMobile: {
    borderRadius: 12,
    padding: 14,
    marginTop: 4,
    marginBottom: 12,
  },
  simulationIconWrap: {
    width: 52,
    height: 52,
    borderRadius: 14,
    backgroundColor: COLORS.primary + '20',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 14,
  },
  simulationIconWrapMobile: {
    width: 42,
    height: 42,
    borderRadius: 12,
    marginRight: 10,
  },
  simulationEmoji: {
    fontSize: 28,
  },
  simulationEmojiMobile: {
    fontSize: 22,
  },
  simulationContent: {
    flex: 1,
  },
  simulationTitle: {
    color: COLORS.primary,
    fontSize: 17,
    fontWeight: '700',
    marginBottom: 4,
  },
  simulationTitleMobile: {
    fontSize: 15,
    marginBottom: 2,
  },
  simulationDesc: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 19,
  },
  simulationDescMobile: {
    fontSize: 12,
    lineHeight: 17,
  },
  simulationArrow: {
    color: COLORS.primary,
    fontSize: 20,
    fontWeight: '700',
    marginLeft: 8,
  },
  simulationArrowMobile: {
    fontSize: 16,
  },
});
