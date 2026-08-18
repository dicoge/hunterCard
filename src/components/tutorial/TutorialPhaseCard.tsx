import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { COLORS } from '../../constants';
import { TutorialPhase } from '../../data/tutorialData';
import TutorialCard from './TutorialCard';
import { useTranslation } from '../../i18n';

interface TutorialPhaseCardProps {
  phase: TutorialPhase;
  depth?: number;
  defaultExpanded?: boolean;
}

export default function TutorialPhaseCard({ 
  phase, 
  depth = 0, 
  defaultExpanded = depth < 1 
}: TutorialPhaseCardProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(defaultExpanded);
  const hasChildren = phase.steps?.length || phase.notes?.length || 
    phase.conditions?.length || phase.canDo?.length || 
    phase.cannotDo?.length || phase.subPhases?.length;

  const toggleExpand = () => {
    if (hasChildren) setExpanded(!expanded);
  };

  return (
    <View style={[styles.container, depth > 0 && styles.nestedContainer]}>
      <TouchableOpacity
        style={[styles.header, depth > 0 && styles.nestedHeader]}
        onPress={toggleExpand}
        activeOpacity={hasChildren ? 0.6 : 1}
      >
        <Text style={[styles.title, depth > 0 && styles.nestedTitle]}>
          {phase.title}
        </Text>
        {hasChildren && (
          <Text style={styles.expandIcon}>{expanded ? '▼' : '▶'}</Text>
        )}
      </TouchableOpacity>

      {phase.description && (
        <Text style={[styles.description, depth > 0 && styles.nestedDescription]}>
          {phase.description}
        </Text>
      )}

      {expanded && (
        <View style={styles.content}>
          {/* Steps */}
          {phase.steps && phase.steps.length > 0 && (
            <View style={styles.listSection}>
              {phase.steps.map((step, index) => (
                <View key={`step-${index}`} style={styles.listItem}>
                  <Text style={styles.bullet}>•</Text>
                  <Text style={styles.listText}>{step}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Conditions (cannot do) */}
          {phase.conditions && phase.conditions.length > 0 && (
            <View style={styles.conditionBox}>
              <Text style={styles.conditionTitle}>
                {t('tutorial_conditions_unavailable')}
              </Text>
              {phase.conditions.map((condition, index) => (
                <View key={`condition-${index}`} style={styles.listItem}>
                  <Text style={styles.conditionBullet}>✕</Text>
                  <Text style={styles.listText}>{condition}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Cannot do */}
          {phase.cannotDo && phase.cannotDo.length > 0 && (
            <View style={styles.cannotBox}>
              <Text style={styles.cannotTitle}>
                {t('tutorial_rest_cannot')}
              </Text>
              {phase.cannotDo.map((item, index) => (
                <View key={`cannot-${index}`} style={styles.listItem}>
                  <Text style={styles.cannotBullet}>✕</Text>
                  <Text style={styles.listText}>{item}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Can do */}
          {phase.canDo && phase.canDo.length > 0 && (
            <View style={styles.canBox}>
              <Text style={styles.canTitle}>
                {t('tutorial_rest_can')}
              </Text>
              {phase.canDo.map((item, index) => (
                <View key={`can-${index}`} style={styles.listItem}>
                  <Text style={styles.canBullet}>✓</Text>
                  <Text style={styles.listText}>{item}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Notes */}
          {phase.notes && phase.notes.length > 0 && (
            <View style={styles.notesSection}>
              {phase.notes.map((note, index) => (
                <View key={`note-${index}`} style={styles.noteItem}>
                  <Text style={styles.noteIcon}>💡</Text>
                  <Text style={styles.noteText}>{note}</Text>
                </View>
              ))}
            </View>
          )}

          {/* Sub-phases (recursive) */}
          {phase.subPhases && phase.subPhases.length > 0 && (
            <View style={styles.subPhases}>
              {phase.subPhases.map((subPhase, index) => (
                <TutorialPhaseCard
                  key={`sub-${index}`}
                  phase={subPhase}
                  depth={depth + 1}
                />
              ))}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    marginBottom: 12,
  },
  nestedContainer: {
    marginLeft: 12,
    marginTop: 8,
    paddingLeft: 12,
    borderLeftWidth: 2,
    borderLeftColor: COLORS.primaryLight + '40',
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 12,
    paddingHorizontal: 16,
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 12,
  },
  nestedHeader: {
    backgroundColor: 'transparent',
    paddingHorizontal: 0,
    paddingVertical: 8,
  },
  title: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    flex: 1,
    marginRight: 8,
  },
  nestedTitle: {
    fontSize: 15,
  },
  expandIcon: {
    color: COLORS.primary,
    fontSize: 12,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 22,
    marginTop: 10,
    marginBottom: 8,
    paddingHorizontal: 4,
  },
  nestedDescription: {
    fontSize: 13,
    lineHeight: 20,
  },
  content: {
    marginTop: 8,
  },
  listSection: {
    marginBottom: 8,
  },
  listItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    marginBottom: 6,
    paddingRight: 4,
  },
  bullet: {
    color: COLORS.primary,
    fontSize: 16,
    marginRight: 8,
    marginTop: 2,
    width: 10,
  },
  listText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    flex: 1,
  },
  conditionBox: {
    backgroundColor: COLORS.error + '20',
    borderRadius: 10,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.error + '50',
  },
  conditionTitle: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  conditionBullet: {
    color: COLORS.error,
    fontSize: 14,
    marginRight: 8,
    width: 14,
  },
  cannotBox: {
    backgroundColor: COLORS.error + '20',
    borderRadius: 10,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.error + '50',
  },
  cannotTitle: {
    color: COLORS.error,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  cannotBullet: {
    color: COLORS.error,
    fontSize: 14,
    marginRight: 8,
    width: 14,
  },
  canBox: {
    backgroundColor: COLORS.success + '20',
    borderRadius: 10,
    padding: 12,
    marginVertical: 8,
    borderWidth: 1,
    borderColor: COLORS.success + '40',
  },
  canTitle: {
    color: COLORS.success,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
  },
  canBullet: {
    color: COLORS.success,
    fontSize: 14,
    marginRight: 8,
    width: 14,
  },
  notesSection: {
    marginTop: 8,
  },
  noteItem: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    backgroundColor: COLORS.secondary + '20',
    borderRadius: 8,
    padding: 10,
    marginBottom: 6,
  },
  noteIcon: {
    fontSize: 14,
    marginRight: 8,
    marginTop: 2,
  },
  noteText: {
    color: COLORS.textSecondary,
    fontSize: 13,
    lineHeight: 20,
    flex: 1,
    fontStyle: 'italic',
  },
  subPhases: {
    marginTop: 4,
  },
});
