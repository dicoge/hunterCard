import React from 'react';
import { View, Text, StyleSheet, Image, useWindowDimensions } from 'react-native';
import { COLORS } from '../../constants';
import { SimulationCardRef } from '../../data/tutorialSimulationData';
import { useTranslation } from '../../i18n';

interface ZoneConfig {
  id: string;
  label: string;
  shortLabel: string;
  gridArea: string;
}

interface SimulationBoardProps {
  highlightZone?: string;
  cardRef?: SimulationCardRef;
  isMobile?: boolean;
}

export default function SimulationBoard({ highlightZone, cardRef, isMobile = false }: SimulationBoardProps) {
  const { t } = useTranslation();
  const { width: screenWidth } = useWindowDimensions();
  const boardPadding = isMobile ? 14 : 16;
  const boardWidth = screenWidth - boardPadding * 2;

  const getCardZone = (): string | null => {
    if (!cardRef) return null;
    if (cardRef.id === 'hbp04-005') return 'oshi';
    if (cardRef.id === 'hbp04-055') return 'backstage';
    return null;
  };

  const cardZone = getCardZone();
  const zones: ZoneConfig[] = [
    { id: 'oshi', label: t('tutorial_zone_oshi'), shortLabel: t('tutorial_zone_oshi_short'), gridArea: 'topLeft' },
    { id: 'center', label: t('tutorial_zone_center'), shortLabel: t('tutorial_zone_center_short'), gridArea: 'topCenter' },
    { id: 'collab', label: t('tutorial_zone_collab'), shortLabel: t('tutorial_zone_collab_short'), gridArea: 'topRight' },
    { id: 'backstage', label: t('tutorial_zone_backstage'), shortLabel: t('tutorial_zone_backstage_short'), gridArea: 'midLeft' },
    { id: 'deck', label: t('tutorial_zone_deck'), shortLabel: t('tutorial_zone_deck_short'), gridArea: 'midCenter' },
    { id: 'energy', label: t('tutorial_zone_energy'), shortLabel: t('tutorial_zone_energy_short'), gridArea: 'midRight' },
    { id: 'life', label: t('tutorial_zone_life'), shortLabel: t('tutorial_zone_life_short'), gridArea: 'botLeft' },
    { id: 'cheerDeck', label: t('tutorial_zone_cheer'), shortLabel: t('tutorial_zone_cheer_short'), gridArea: 'botCenter' },
    { id: 'archive', label: t('tutorial_zone_archive'), shortLabel: t('tutorial_zone_archive_short'), gridArea: 'botRight' },
  ];

  return (
    <View style={styles.container}>
      <Text style={[styles.boardTitle, isMobile && styles.boardTitleMobile]}>
        {t('tutorial_simulation_board')}
      </Text>

      <View style={[styles.grid, { width: boardWidth }]}>
        {/* Row 1: Oshi | Center | Collab */}
        <View style={[styles.row, isMobile && styles.rowMobile]}>
          <ZoneBox
            zone={zones[0]}
            isHighlighted={highlightZone === 'oshi' || cardZone === 'oshi'}
            cardRef={cardZone === 'oshi' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[1]}
            isHighlighted={highlightZone === 'center' || cardZone === 'center'}
            cardRef={cardZone === 'center' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[2]}
            isHighlighted={highlightZone === 'collab' || cardZone === 'collab'}
            cardRef={cardZone === 'collab' ? cardRef : undefined}
            isMobile={isMobile}
          />
        </View>

        {/* Row 2: Backstage | Deck | Energy */}
        <View style={[styles.row, isMobile && styles.rowMobile]}>
          <ZoneBox
            zone={zones[3]}
            isHighlighted={highlightZone === 'backstage' || cardZone === 'backstage'}
            cardRef={cardZone === 'backstage' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[4]}
            isHighlighted={highlightZone === 'deck' || cardZone === 'deck'}
            cardRef={cardZone === 'deck' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[5]}
            isHighlighted={highlightZone === 'energy' || cardZone === 'energy'}
            cardRef={cardZone === 'energy' ? cardRef : undefined}
            isMobile={isMobile}
          />
        </View>

        {/* Row 3: Life | CheerDeck | Archive */}
        <View style={[styles.row, isMobile && styles.rowMobile]}>
          <ZoneBox
            zone={zones[6]}
            isHighlighted={highlightZone === 'life' || cardZone === 'life'}
            cardRef={cardZone === 'life' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[7]}
            isHighlighted={highlightZone === 'cheerDeck' || cardZone === 'cheerDeck'}
            cardRef={cardZone === 'cheerDeck' ? cardRef : undefined}
            isMobile={isMobile}
          />
          <ZoneBox
            zone={zones[8]}
            isHighlighted={highlightZone === 'archive' || cardZone === 'archive'}
            cardRef={cardZone === 'archive' ? cardRef : undefined}
            isMobile={isMobile}
          />
        </View>
      </View>
    </View>
  );
}

interface ZoneBoxProps {
  zone: ZoneConfig;
  isHighlighted: boolean;
  cardRef?: SimulationCardRef;
  isMobile?: boolean;
}

function ZoneBox({ zone, isHighlighted, cardRef, isMobile = false }: ZoneBoxProps) {
  return (
    <View
      style={[
        styles.zone,
        isMobile && styles.zoneMobile,
        isHighlighted && styles.zoneHighlighted,
      ]}
    >
      {cardRef && cardRef.imageUrl ? (
        <Image
          source={{ uri: cardRef.imageUrl }}
          style={styles.cardThumb}
          resizeMode="contain"
        />
      ) : (
        <View style={styles.zoneInner}>
          <Text style={[styles.zoneEmoji, isMobile && styles.zoneEmojiMobile]}>
            {zone.id === 'oshi' ? '⭐' :
             zone.id === 'center' ? '🎯' :
             zone.id === 'collab' ? '🔗' :
             zone.id === 'backstage' ? '🎪' :
             zone.id === 'deck' ? '📚' :
             zone.id === 'energy' ? '⚡' :
             zone.id === 'life' ? '❤️' :
             zone.id === 'cheerDeck' ? '📣' :
             zone.id === 'archive' ? '📦' : '🃏'}
          </Text>
        </View>
      )}
      <Text style={[styles.zoneLabel, isMobile && styles.zoneLabelMobile, isHighlighted && styles.zoneLabelHighlighted]}>
        {zone.shortLabel}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    alignItems: 'center',
    paddingVertical: 4,
  },
  boardTitle: {
    color: COLORS.text,
    fontSize: 13,
    fontWeight: '600',
    marginBottom: 8,
    letterSpacing: 1,
  },
  boardTitleMobile: {
    fontSize: 11,
    marginBottom: 6,
  },
  grid: {
    gap: 5,
  },
  row: {
    flexDirection: 'row',
    gap: 5,
    marginBottom: 5,
  },
  rowMobile: {
    gap: 4,
    marginBottom: 4,
  },
  zone: {
    flex: 1,
    aspectRatio: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 10,
    borderWidth: 1.5,
    borderColor: COLORS.border,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 4,
    position: 'relative',
    overflow: 'hidden',
  },
  zoneMobile: {
    borderRadius: 8,
    borderWidth: 1,
    aspectRatio: undefined,
    height: 50,
  },
  zoneHighlighted: {
    borderColor: COLORS.primary,
    borderWidth: 2.5,
    backgroundColor: COLORS.surfaceLight,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 6,
  },
  zoneInner: {
    justifyContent: 'center',
    alignItems: 'center',
  },
  zoneEmoji: {
    fontSize: 22,
  },
  zoneEmojiMobile: {
    fontSize: 18,
  },
  cardThumb: {
    width: '80%',
    height: '80%',
    borderRadius: 6,
  },
  zoneLabel: {
    color: COLORS.textSecondary,
    fontSize: 9,
    fontWeight: '600',
    position: 'absolute',
    bottom: 3,
    textAlign: 'center',
  },
  zoneLabelMobile: {
    fontSize: 8,
    bottom: 2,
  },
  zoneLabelHighlighted: {
    color: COLORS.primary,
    fontWeight: '700',
  },
});
