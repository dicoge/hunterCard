import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { getSimulationPhases } from '../data/tutorialSimulationData';
import SimulationBoard from '../components/tutorial/SimulationBoard';
import SimulationStepCard from '../components/tutorial/SimulationStepCard';
import { useTranslation } from '../i18n';

const MOBILE_BREAKPOINT = 480;

export default function TutorialSimulationScreen({ navigation }: any) {
  const { t, language } = useTranslation();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isMobile = screenWidth < MOBILE_BREAKPOINT;
  const simulationPhases = useMemo(() => getSimulationPhases(language), [language]);

  const [currentPhaseIndex, setCurrentPhaseIndex] = useState(0);
  const [currentStepIndex, setCurrentStepIndex] = useState(0);

  const currentPhase = simulationPhases[currentPhaseIndex];
  const currentStep = currentPhase.steps[currentStepIndex];
  const isFirstPhase = currentPhaseIndex === 0;
  const isLastPhase = currentPhaseIndex === simulationPhases.length - 1;
  const isFirstStep = currentStepIndex === 0;
  const isLastStep = currentStepIndex === currentPhase.steps.length - 1;

  const handleNext = useCallback(() => {
    if (!isLastStep) {
      setCurrentStepIndex((prev) => prev + 1);
    } else if (!isLastPhase) {
      setCurrentPhaseIndex((prev) => prev + 1);
      setCurrentStepIndex(0);
    } else {
      navigation.goBack();
    }
  }, [isLastStep, isLastPhase, navigation]);

  const handlePrev = useCallback(() => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
    } else if (!isFirstPhase) {
      setCurrentPhaseIndex((prev) => prev - 1);
      const prevPhase = simulationPhases[currentPhaseIndex - 1];
      setCurrentStepIndex(prevPhase.steps.length - 1);
    }
  }, [isFirstStep, isFirstPhase, currentPhaseIndex]);

  // Calculate overall progress
  const totalSteps = useMemo(
    () => simulationPhases.reduce((sum, phase) => sum + phase.steps.length, 0),
    []
  );
  const stepsDone = useMemo(
    () => simulationPhases
      .slice(0, currentPhaseIndex)
      .reduce((sum, phase) => sum + phase.steps.length, 0) + currentStepIndex,
    [currentPhaseIndex, currentStepIndex]
  );
  const progressPercent = ((stepsDone) / (totalSteps - 1)) * 100;

  const boardMaxHeight = isMobile
    ? Math.min(screenHeight * 0.28, 200)
    : Math.min(screenHeight * 0.4, 320);

  return (
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'bottom']}
      testID="tutorial-simulation-content"
    >
      {/* Top bar */}
      <View style={[styles.topBar, isMobile && styles.topBarMobile]}>
        <Text style={[styles.topBarTitle, isMobile && styles.topBarTitleMobile]}>
          {t('tutorial_simulation_title')}
        </Text>
        <Text style={[styles.topBarSub, isMobile && styles.topBarSubMobile]}>
          {t('tutorial_simulation_subtitle')}
        </Text>
      </View>

      {/* Progress bar */}
      <View style={[styles.progressContainer, isMobile && styles.progressContainerMobile]}>
        <View style={styles.progressTrack}>
          <View
            style={[
              styles.progressFill,
              { width: `${Math.min(progressPercent, 100)}%` },
            ]}
          />
        </View>
        <Text style={[styles.progressText, isMobile && styles.progressTextMobile]}>
          {t('tutorial_simulation_phase', { current: currentPhaseIndex + 1, total: simulationPhases.length })}
        </Text>
      </View>

      {/* Scrollable content area */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* Game Board — compact at top */}
        <View style={[styles.boardContainer, { maxHeight: boardMaxHeight }]}>
          <SimulationBoard
            highlightZone={currentStep.highlightZone}
            cardRef={currentStep.cardRef}
            isMobile={isMobile}
          />
        </View>

        {/* Step Card */}
        <View style={styles.cardContainer}>
          <SimulationStepCard
            step={currentStep}
            phaseTitle={currentPhase.title}
            phaseIcon={currentPhase.icon}
            totalStepsInPhase={currentPhase.steps.length}
            onNext={handleNext}
            onPrev={handlePrev}
            isFirst={isFirstStep}
            isLast={isLastStep}
            isFirstPhase={isFirstPhase}
            isLastPhase={isLastPhase}
            isMobile={isMobile}
          />
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
  topBar: {
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 6,
  },
  topBarMobile: {
    paddingHorizontal: 14,
    paddingTop: 8,
    paddingBottom: 4,
  },
  topBarTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
  },
  topBarTitleMobile: {
    fontSize: 17,
  },
  topBarSub: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  topBarSubMobile: {
    fontSize: 11,
  },
  progressContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingVertical: 8,
    gap: 10,
  },
  progressContainerMobile: {
    paddingHorizontal: 14,
    paddingVertical: 6,
  },
  progressTrack: {
    flex: 1,
    height: 6,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 3,
    overflow: 'hidden',
  },
  progressFill: {
    height: '100%',
    backgroundColor: COLORS.primary,
    borderRadius: 3,
  },
  progressText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    fontWeight: '600',
    minWidth: 80,
    textAlign: 'right',
  },
  progressTextMobile: {
    fontSize: 11,
    minWidth: 70,
  },
  scrollArea: {
    flex: 1,
  },
  scrollContent: {
    paddingBottom: 24,
  },
  boardContainer: {
    justifyContent: 'center',
    paddingHorizontal: 14,
    paddingVertical: 4,
  },
  cardContainer: {
    paddingTop: 2,
  },
});
