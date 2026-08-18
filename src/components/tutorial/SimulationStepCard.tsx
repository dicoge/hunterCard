import React from 'react';
import { View, Text, StyleSheet, TouchableOpacity, ScrollView } from 'react-native';
import { COLORS } from '../../constants';
import { SimulationStep } from '../../data/tutorialSimulationData';
import { useTranslation } from '../../i18n';

interface SimulationStepCardProps {
  step: SimulationStep;
  phaseTitle: string;
  phaseIcon: string;
  totalStepsInPhase: number;
  onNext: () => void;
  onPrev: () => void;
  isFirst: boolean;
  isLast: boolean;
  isFirstPhase: boolean;
  isLastPhase: boolean;
  isMobile?: boolean;
}

export default function SimulationStepCard({
  step,
  phaseTitle,
  phaseIcon,
  totalStepsInPhase,
  onNext,
  onPrev,
  isFirst,
  isLast,
  isFirstPhase,
  isLastPhase,
  isMobile = false,
}: SimulationStepCardProps) {
  const { t } = useTranslation();
  return (
    <View style={[styles.container, isMobile && styles.containerMobile]}>
      {/* Phase indicator */}
      <View style={[styles.phaseBar, isMobile && styles.phaseBarMobile]}>
        <Text style={[styles.phaseIcon, isMobile && styles.phaseIconMobile]}>{phaseIcon}</Text>
        <Text style={[styles.phaseTitle, isMobile && styles.phaseTitleMobile]}>{phaseTitle}</Text>
        <View style={[styles.stepBadge, isMobile && styles.stepBadgeMobile]}>
          <Text style={[styles.stepBadgeText, isMobile && styles.stepBadgeTextMobile]}>
            {t('tutorial_simulation_step', { current: step.stepNumber, total: totalStepsInPhase })}
          </Text>
        </View>
      </View>

      {/* Scrollable step content */}
      <ScrollView
        style={[styles.stepScroll, isMobile && styles.stepScrollMobile]}
        contentContainerStyle={styles.stepScrollContent}
        showsVerticalScrollIndicator={false}
        nestedScrollEnabled
      >
        {/* Step title */}
        <Text style={[styles.stepTitle, isMobile && styles.stepTitleMobile]}>
          {step.title}
        </Text>

        {/* Step description */}
        <Text style={[styles.description, isMobile && styles.descriptionMobile]}>
          {step.description}
        </Text>

        {/* Action label */}
        {step.actionLabel && (
          <View style={[styles.actionBox, isMobile && styles.actionBoxMobile]}>
            <Text style={[styles.actionEmoji, isMobile && styles.actionEmojiMobile]}>
              {step.phaseId === 'setup' ? '🎮' :
               step.phaseId === 'reset' ? '🔄' :
               step.phaseId === 'draw' ? '📚' :
               step.phaseId === 'cheer' ? '📣' :
               step.phaseId === 'main' ? '⚡' :
               step.phaseId === 'performance' ? '🎭' :
               '🏁'}
            </Text>
            <Text style={[styles.actionText, isMobile && styles.actionTextMobile]}>
              {step.actionLabel}
            </Text>
          </View>
        )}

        {/* Explanation */}
        {step.explanation && (
          <View style={[styles.explanationBox, isMobile && styles.explanationBoxMobile]}>
            <Text style={styles.explanationIcon}>💡</Text>
            <Text style={[styles.explanationText, isMobile && styles.explanationTextMobile]}>
              {step.explanation}
            </Text>
          </View>
        )}
      </ScrollView>

      {/* Navigation buttons — always visible at bottom */}
      <View style={[styles.navRow, isMobile && styles.navRowMobile]}>
        {!isFirst || !isFirstPhase ? (
          <TouchableOpacity
            style={[styles.prevButton, isMobile && styles.prevButtonMobile]}
            onPress={onPrev}
            activeOpacity={0.7}
          >
            <Text style={[styles.prevArrow, isMobile && styles.prevArrowMobile]}>←</Text>
            <Text style={[styles.prevText, isMobile && styles.prevTextMobile]}>{t('tutorial_simulation_previous')}</Text>
          </TouchableOpacity>
        ) : (
          <View style={styles.spacer} />
        )}

        <TouchableOpacity
          style={[styles.nextButton, isMobile && styles.nextButtonMobile]}
          onPress={onNext}
          activeOpacity={0.8}
        >
          <Text style={[styles.nextText, isMobile && styles.nextTextMobile]}>
            {isLast && isLastPhase ? t('tutorial_simulation_complete') : t('tutorial_simulation_next')}
          </Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    backgroundColor: COLORS.surface,
    borderRadius: 20,
    padding: 20,
    marginHorizontal: 16,
    marginBottom: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  containerMobile: {
    borderRadius: 14,
    padding: 14,
    marginHorizontal: 12,
    marginBottom: 12,
  },
  phaseBar: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 14,
    paddingBottom: 10,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  phaseBarMobile: {
    marginBottom: 10,
    paddingBottom: 8,
  },
  phaseIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  phaseIconMobile: {
    fontSize: 16,
    marginRight: 6,
  },
  phaseTitle: {
    color: COLORS.primary,
    fontSize: 15,
    fontWeight: '700',
    flex: 1,
  },
  phaseTitleMobile: {
    fontSize: 13,
  },
  stepBadge: {
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 12,
    paddingHorizontal: 10,
    paddingVertical: 4,
  },
  stepBadgeMobile: {
    paddingHorizontal: 8,
    paddingVertical: 3,
  },
  stepBadgeText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
  },
  stepBadgeTextMobile: {
    fontSize: 10,
  },
  stepScroll: {
    maxHeight: 280,
  },
  stepScrollMobile: {
    maxHeight: 180,
  },
  stepScrollContent: {},
  stepTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 10,
  },
  stepTitleMobile: {
    fontSize: 17,
    marginBottom: 8,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 24,
    marginBottom: 12,
  },
  descriptionMobile: {
    fontSize: 13,
    lineHeight: 20,
    marginBottom: 10,
  },
  actionBox: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.primary + '18',
    borderRadius: 12,
    padding: 14,
    marginBottom: 12,
    borderWidth: 1,
    borderColor: COLORS.primary + '30',
  },
  actionBoxMobile: {
    borderRadius: 10,
    padding: 10,
    marginBottom: 10,
  },
  actionEmoji: {
    fontSize: 24,
    marginRight: 12,
  },
  actionEmojiMobile: {
    fontSize: 20,
    marginRight: 8,
  },
  actionText: {
    color: COLORS.primary,
    fontSize: 16,
    fontWeight: '700',
  },
  actionTextMobile: {
    fontSize: 14,
  },
  explanationBox: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.secondary + '18',
    borderRadius: 12,
    padding: 12,
    marginBottom: 16,
  },
  explanationBoxMobile: {
    borderRadius: 10,
    padding: 10,
    marginBottom: 12,
  },
  explanationIcon: {
    fontSize: 16,
    marginRight: 10,
    marginTop: 1,
  },
  explanationText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    flex: 1,
    fontStyle: 'italic',
  },
  explanationTextMobile: {
    fontSize: 12,
    lineHeight: 18,
  },
  navRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: 8,
  },
  navRowMobile: {
    marginTop: 6,
  },
  prevButton: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    borderRadius: 12,
    backgroundColor: COLORS.surfaceLight,
  },
  prevButtonMobile: {
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderRadius: 10,
  },
  prevArrow: {
    color: COLORS.textSecondary,
    fontSize: 16,
    marginRight: 4,
  },
  prevArrowMobile: {
    fontSize: 14,
  },
  prevText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    fontWeight: '600',
  },
  prevTextMobile: {
    fontSize: 13,
  },
  nextButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.3,
    shadowRadius: 8,
    elevation: 6,
  },
  nextButtonMobile: {
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderRadius: 12,
  },
  nextText: {
    color: '#ffffff',
    fontSize: 16,
    fontWeight: 'bold',
    letterSpacing: 1,
  },
  nextTextMobile: {
    fontSize: 14,
    letterSpacing: 0.5,
  },
  spacer: {
    width: 1,
  },
});
