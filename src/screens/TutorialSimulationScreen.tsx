import React, { useState, useCallback, useMemo } from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Platform, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { PALETTE, SEMANTIC } from '../theme/tokensV2';
import { getSimulationPhases } from '../data/tutorialSimulationData';
import SimulationBoard from '../components/tutorial/SimulationBoard';
import SimulationStepCard from '../components/tutorial/SimulationStepCard';
import { useTutorialStore } from '../store/tutorialStore';
import { useTranslation } from '../i18n';
import { RouteShell } from '../components/shell';

const MOBILE_BREAKPOINT = 480;

// DIC-1427 QA P0 — Pen `App / 14 教學模擬` (frame I6WwjY): turn bar with the
// REAL 階段 X/Y state, the game board inside the gradient board card, an
// accent hint banner fed by the real step explanation, and a primary /
// secondary action row driving the real step machine. Completing the last
// step records simulationCompleted in useTutorialStore — real progression,
// no static duel copy.
export default function TutorialSimulationScreen({ navigation }: any) {
  const { t, language } = useTranslation();
  const { width: screenWidth, height: screenHeight } = useWindowDimensions();
  const isMobile = screenWidth < MOBILE_BREAKPOINT;
  const simulationPhases = useMemo(() => getSimulationPhases(language), [language]);
  const markSimulationCompleted = useTutorialStore((s) => s.markSimulationCompleted);

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
      // The reader walked the whole duel walkthrough — that IS the real
      // completion signal the Pen progression chrome reads.
      markSimulationCompleted();
      navigation.goBack();
    }
  }, [isLastStep, isLastPhase, navigation, markSimulationCompleted]);

  const handlePrev = useCallback(() => {
    if (!isFirstStep) {
      setCurrentStepIndex((prev) => prev - 1);
    } else if (!isFirstPhase) {
      setCurrentPhaseIndex((prev) => prev - 1);
      const prevPhase = simulationPhases[currentPhaseIndex - 1];
      setCurrentStepIndex(prevPhase.steps.length - 1);
    }
  }, [isFirstStep, isFirstPhase, currentPhaseIndex]);

  const handleRestart = useCallback(() => {
    setCurrentPhaseIndex(0);
    setCurrentStepIndex(0);
  }, []);

  const boardMaxHeight = isMobile
    ? Math.min(screenHeight * 0.32, 230)
    : Math.min(screenHeight * 0.4, 320);

  const canGoPrev = !(isFirstStep && isFirstPhase);

  return (
    <RouteShell navigation={navigation} routeName="TutorialSimulation" title={t('nav_tutorial_simulation')} testID="tutorial-simulation-shell">
    <SafeAreaView
      style={styles.safeArea}
      edges={['top', 'bottom']}
      testID="tutorial-simulation-content"
    >
      {/* Turn bar (Pen hVdrQ): dot + real 階段 X/Y + phase title */}
      <View style={styles.turnBar} testID="tutorial-simulation-turnbar">
        <View style={styles.turnBarLeft}>
          <View style={styles.turnBarDot} />
          <Text style={styles.turnBarLabel} numberOfLines={1}>
            {t('tutorial_simulation_phase', { current: currentPhaseIndex + 1, total: simulationPhases.length })}
            {' · '}{currentPhase.title}
          </Text>
        </View>
        <Text style={styles.turnBarRight}>
          {t('tutorial_simulation_step', { current: currentStep.stepNumber, total: currentPhase.steps.length })}
        </Text>
      </View>

      {/* Scrollable content area */}
      <ScrollView
        style={styles.scrollArea}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        bounces={false}
      >
        {/* Game board inside the Pen gradient board card (Pen ZQ3b7) */}
        <View
          style={[
            styles.boardCard,
            Platform.OS === 'web'
              ? ({ backgroundImage: 'linear-gradient(180deg, rgba(139,92,246,0.16) 0%, rgba(20,20,31,0.9) 100%)' } as object)
              : { backgroundColor: PALETTE.appSurface },
          ]}
        >
          <View style={[styles.boardContainer, { maxHeight: boardMaxHeight }]}>
            <SimulationBoard
              highlightZone={currentStep.highlightZone}
              cardRef={currentStep.cardRef}
              isMobile={isMobile}
            />
          </View>
        </View>

        {/* Step Card — real walkthrough content */}
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
            hideExplanation
            hideNav
          />
        </View>

        {/* Hint banner (Pen Cpwfh): the real step explanation in accent chrome */}
        {currentStep.explanation ? (
          <View style={styles.hintBanner} testID="tutorial-simulation-hint">
            <Text style={styles.hintIcon}>💡</Text>
            <Text style={styles.hintText}>{currentStep.explanation}</Text>
          </View>
        ) : null}
      </ScrollView>

      {/* Action row (Pen k0Q7h): primary next + secondary prev/restart */}
      <View style={styles.actionRow} testID="tutorial-simulation-actions">
        <TouchableOpacity
          style={[styles.actionGhost, !canGoPrev ? styles.actionDisabled : null]}
          onPress={handlePrev}
          disabled={!canGoPrev}
          accessibilityRole="button"
          testID="tutorial-simulation-prev"
          activeOpacity={0.8}
        >
          <Text style={styles.actionGhostText}>← {t('tutorial_simulation_previous')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionGhost}
          onPress={handleRestart}
          accessibilityRole="button"
          testID="tutorial-simulation-restart"
          activeOpacity={0.8}
        >
          <Text style={styles.actionGhostText}>⟳</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.actionPrimary}
          onPress={handleNext}
          accessibilityRole="button"
          testID="tutorial-simulation-next"
          activeOpacity={0.85}
        >
          <Text style={styles.actionPrimaryText}>
            {isLastStep && isLastPhase ? t('tutorial_simulation_complete') : t('tutorial_simulation_next')}
          </Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
    </RouteShell>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: PALETTE.appBg },

  // Turn bar (Pen hVdrQ 358×39 r12)
  turnBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    marginHorizontal: 16, marginTop: 14, marginBottom: 12,
    backgroundColor: PALETTE.appSurface, borderRadius: 12,
    paddingHorizontal: 14, paddingVertical: 10, gap: 10,
  },
  turnBarLeft: { flexDirection: 'row', alignItems: 'center', gap: 10, flexShrink: 1, minWidth: 0 },
  turnBarDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: PALETTE.accent2 },
  turnBarLabel: { color: SEMANTIC.onBg, fontSize: 13, fontWeight: '700', flexShrink: 1 },
  turnBarRight: { color: PALETTE.cGreen, fontSize: 12, fontWeight: '700' },

  scrollArea: { flex: 1 },
  scrollContent: { paddingBottom: 16 },

  // Board card (Pen ZQ3b7 gradient r16)
  boardCard: { marginHorizontal: 16, borderRadius: 16, backgroundColor: PALETTE.appSurface, paddingVertical: 8, marginBottom: 12, overflow: 'hidden' },
  boardContainer: { justifyContent: 'center', paddingHorizontal: 6, paddingVertical: 4 },
  cardContainer: { paddingTop: 2 },

  // Hint banner (Pen Cpwfh: #FF4D9D14 r12)
  hintBanner: {
    flexDirection: 'row', alignItems: 'flex-start', gap: 10,
    marginHorizontal: 16, marginTop: 2, padding: 14,
    borderRadius: 12, backgroundColor: 'rgba(255,77,157,0.08)',
  },
  hintIcon: { fontSize: 15, lineHeight: 20 },
  hintText: { flex: 1, color: SEMANTIC.onBgMuted, fontSize: 12, lineHeight: 18 },

  // Action row (Pen k0Q7h: 43px buttons r12)
  actionRow: {
    flexDirection: 'row', gap: 10,
    paddingHorizontal: 16, paddingVertical: 12,
    backgroundColor: 'rgba(10,10,19,0.95)',
  },
  actionGhost: {
    minHeight: 44, borderRadius: 12, backgroundColor: PALETTE.appSurface,
    alignItems: 'center', justifyContent: 'center', paddingHorizontal: 16,
  },
  actionDisabled: { opacity: 0.4 },
  actionGhostText: { color: SEMANTIC.onBgMuted, fontSize: 13, fontWeight: '700' },
  actionPrimary: {
    flex: 1, minHeight: 44, borderRadius: 12, backgroundColor: PALETTE.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  actionPrimaryText: { color: '#FFFFFF', fontSize: 13, fontWeight: '700' },
});
