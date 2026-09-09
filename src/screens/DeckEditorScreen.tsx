import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, Modal, Image,
} from 'react-native';
import { useNavigation, NavigationContext } from '@react-navigation/native';
import { COLORS } from '../constants';
import { FEATURES } from '../config/releaseFlags';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useDeckStore } from '../store/deckStore';
import {
  validateDeck, deckStats, computeGap, eligibleZone, isDeckLegal,
  type DeckCard, type DeckZone, type Deck, type ValidationIssue,
} from '../utils/deckRules';
import {
  groupVariantsByCardNumber, buildLowCostIndex, countLowCostDrift,
} from '../utils/deckVariants';
import {
  collectFilterOptions, filterCatalog, EMPTY_CRITERIA,
  type CardCategory, type CardFacets, type PickerCriteria,
} from '../utils/cardCatalog';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import { CardFilterPanel, CardPickerGrid } from '../components/CardPicker';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { formatInterval, priceAlertKey } from '../utils/priceAlerts';
import { useTranslation, type TranslationKey } from '../i18n';
import { useSettingsStore } from '../store/settingsStore';
import { resolveCardDisplayName } from '../utils/cardDisplayName';

const ZONES: DeckZone[] = ['oshi', 'main', 'yell'];
type MobilePanel = 'picker' | DeckZone | 'shortage';

/** The card classes a zone accepts. 主牌組 takes two, so its tab offers a
 * ホロメン／サポート sub-filter; the other zones take exactly one and hide it. */
const ZONE_CATEGORIES: Record<DeckZone, CardCategory[]> = {
  oshi: ['oshi'],
  main: ['holomen', 'support'],
  yell: ['yell'],
};

// 版本一律顯示來源掛牌原文（如「ラプラス・ダークネス(パラレル)」）；沒有原文時退回版本代碼。
// 絕不顯示資料庫的卡號層級 rarity —— hBP04-005 兩列都標 SEC，拿來標示 ¥980 的原印版會誤導。
function printingLabelOf(card: {
  printing: string;
  printingLabel?: string;
  unresolvedPrinting?: boolean;
  sourceVersion?: string;
}, translate?: (key: TranslationKey, params?: Record<string, string | number>) => string): string {
  if (card.unresolvedPrinting) {
    if (translate) {
      return card.sourceVersion
        ? translate('deck_printing_source', { source: card.sourceVersion })
        : translate('deck_printing_unresolved');
    }
    return card.sourceVersion || card.printing;
  }
  return card.printingLabel?.trim() || card.printing;
}

export default function DeckEditorScreen() {
  const { t } = useTranslation();
  // DIC-1380 W8 CR — the Pen `uXuqo` app bar carries a back button.
  // useNavigation() throws when the component is mounted outside a
  // NavigationContainer (unit-test render harness). Read the context
  // directly — it returns `undefined` outside a container, which the
  // back-button handler treats as a no-op.
  const navigation = React.useContext(NavigationContext as any) as any;
  const { width, isDesktop, isWide } = useBreakpoint();
  const isPhone = width <= 480;
  const zoneLabels: Record<DeckZone, string> = {
    oshi: t('deck_zone_oshi'), main: t('deck_zone_main'), yell: t('deck_zone_yell'),
  };
  const [db, setDb] = useState<CardDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [newDeckName, setNewDeckName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(false);
  const [activeZone, setActiveZone] = useState<DeckZone>('oshi');
  const [mobilePanel, setMobilePanel] = useState<MobilePanel>('picker');
  const [criteria, setCriteria] = useState<PickerCriteria>(EMPTY_CRITERIA);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Full rule validation is surfaced ONLY when the player presses 完成組牌
  // (DIC-1004 §B) — null means the result sheet is closed.
  const [finalizeIssues, setFinalizeIssues] = useState<ValidationIssue[] | null>(null);
  const [alertTarget, setAlertTarget] = useState<PriceAlertTarget | null>(null);
  const [menuDeckId, setMenuDeckId] = useState<string | null>(null);
  const [deleteDeckId, setDeleteDeckId] = useState<string | null>(null);
  const priceAlerts = usePriceAlertStore((s) => s.alerts);
  // DIC-1380 W4 CR: route every card-name render through the shared resolver
  // so DeckEditor shows the same primary + subtitle as SearchResults /
  // CardDetail / ScanResultCard / ScanCandidateSelector under the current
  // language preference. Without this hook the deck editor rendered
  // `slot.card.name` verbatim regardless of `preferredLanguage`, which was
  // the naming-inconsistency case the W4 handback called out.
  const preferredLanguage = useSettingsStore((s) => s.preferredLanguage);

  const decks = useDeckStore((s) => s.decks);
  const activeDeckId = useDeckStore((s) => s.activeDeckId);
  const collection = useDeckStore((s) => s.collection);
  const createDeck = useDeckStore((s) => s.createDeck);
  const renameDeck = useDeckStore((s) => s.renameDeck);
  const deleteDeck = useDeckStore((s) => s.deleteDeck);
  const setActiveDeck = useDeckStore((s) => s.setActiveDeck);
  const changeCard = useDeckStore((s) => s.changeCard);
  const removeCard = useDeckStore((s) => s.removeCard);
  const applyLowCostVariants = useDeckStore((s) => s.applyLowCostVariants);
  const migrateLegacyPrintings = useDeckStore((s) => s.migrateLegacyPrintings);
  const migrateTournamentDefaults = useDeckStore((s) => s.migrateTournamentDefaults);

  const activeDeck = useMemo(
    () => decks.find((d) => d.id === activeDeckId) || null,
    [decks, activeDeckId],
  );
  const menuDeck = decks.find((deck) => deck.id === menuDeckId) || null;
  const deleteCandidate = decks.find((deck) => deck.id === deleteDeckId) || null;

  useEffect(() => {
    loadCardDatabase()
      .then((data) => setDb(data))
      .catch(() => setDb(null))
      .finally(() => setLoading(false));
  }, []);

  // Reset the rename editor whenever the active deck changes.
  useEffect(() => {
    setRenaming(false);
    setRenameValue('');
    setRenameError(false);
    setFinalizeIssues(null);
  }, [activeDeckId]);

  // Every card offered to the player is the card number's low-cost ORDINARY
  // default printing, the same choice tournament import and the card page make
  // (DIC-1060) — a parallel listing never wins just by being cheaper.
  const variantGroups = useMemo(
    () => (db ? groupVariantsByCardNumber(db.cards, db.priceRecords) : []),
    [db],
  );
  const lowCostIndex = useMemo(() => buildLowCostIndex(variantGroups), [variantGroups]);

  // Drafts saved before DIC-1013 key their slots off the row-level rarity and
  // must be moved onto real source printings before any estimate is shown.
  // Tournament decks imported under DIC-1033 were saved with every printing
  // unresolved, which priced the whole deck NO_EXACT_PRICE; they are repaired
  // onto the same ordinary defaults a fresh import now picks, so the player
  // never has to delete and re-import (DIC-1060). Both passes are idempotent
  // and return the store unchanged once there is nothing left to move.
  useEffect(() => {
    if (lowCostIndex.size === 0) return;
    migrateLegacyPrintings(lowCostIndex);
    migrateTournamentDefaults(lowCostIndex);
  }, [lowCostIndex, migrateLegacyPrintings, migrateTournamentDefaults]);

  const facets = db?.facets ?? new Map();
  const categoryChoices = ZONE_CATEGORIES[activeZone];

  // Cards the OPEN zone can legally hold. Filter options are collected from this
  // set, so a zone never offers a colour or set that none of its cards has.
  const zoneGroups = useMemo(
    () => filterCatalog(variantGroups, facets, { ...EMPTY_CRITERIA, categories: categoryChoices }),
    [variantGroups, facets, categoryChoices],
  );
  const filterOptions = useMemo(
    () => collectFilterOptions(
      zoneGroups.flatMap((g): CardFacets[] => {
        const f = facets.get(g.cardNumber);
        return f ? [f] : [];
      }),
    ),
    [zoneGroups, facets],
  );
  const results = useMemo(
    () => filterCatalog(zoneGroups, facets, {
      ...criteria,
      categories: criteria.categories.length > 0 ? criteria.categories : categoryChoices,
    }),
    [zoneGroups, facets, criteria, categoryChoices],
  );

  const lowCostDrift = activeDeck ? countLowCostDrift(activeDeck, lowCostIndex) : 0;

  // Copies of a card number already in the deck, for the grid's quantity badge.
  const qtyByCardNumber = useMemo(() => {
    const map = new Map<string, number>();
    if (activeDeck) {
      for (const zone of ZONES) {
        for (const slot of activeDeck[zone]) {
          map.set(slot.card.cardNumber, (map.get(slot.card.cardNumber) ?? 0) + slot.qty);
        }
      }
    }
    return map;
  }, [activeDeck]);

  const stats = activeDeck ? deckStats(activeDeck) : null;
  const gap = activeDeck && db ? computeGap(activeDeck, collection, db.priceRecords) : null;

  function validationMessage(issue: ValidationIssue): string {
    const card = issue.cardNumber || '—';
    switch (issue.code) {
      case 'ERR_OSHI_QTY': return t('deck_rule_oshi_qty', { target: stats?.oshiTarget ?? 1, current: stats?.oshi ?? 0 });
      case 'ERR_OSHI_TYPE': return t('deck_rule_oshi_type', { card });
      case 'ERR_MAIN_QTY': return t('deck_rule_main_qty', { target: stats?.mainTarget ?? 50, current: stats?.main ?? 0 });
      case 'ERR_MAIN_TYPE': return t('deck_rule_main_type', { card });
      case 'ERR_CHEER_QTY': return t('deck_rule_yell_qty', { target: stats?.yellTarget ?? 20, current: stats?.yell ?? 0 });
      case 'ERR_CHEER_TYPE': return t('deck_rule_yell_type', { card });
      case 'ERR_CARD_LIMIT': return t('deck_rule_card_limit', { card });
      case 'ERR_RESTRICTED': return t('deck_rule_restricted', { card });
      default: return issue.message;
    }
  }

  function addToDeck(card: DeckCard) {
    if (!activeDeck) return;
    const zone = eligibleZone(card);
    if (!zone) return;
    changeCard(activeDeck.id, zone, card, 1);
  }

  function finalizeDeck() {
    if (!activeDeck) return;
    setFinalizeIssues(validateDeck(activeDeck));
  }

  function startRename() {
    if (!activeDeck) return;
    setRenameValue(activeDeck.name);
    setRenameError(false);
    setRenaming(true);
  }

  function commitRename() {
    if (!activeDeck) return;
    // Reject an empty/whitespace-only name: keep the existing name intact and
    // leave the editor open so the user can correct it. renameDeck also
    // fail-safes on empty, but we guard here to surface the error inline.
    if (!renameValue.trim()) {
      setRenameError(true);
      return;
    }
    renameDeck(activeDeck.id, renameValue);
    setRenaming(false);
    setRenameError(false);
  }

  function cancelRename() {
    setRenaming(false);
    setRenameError(false);
  }

  function confirmDeleteDeck() {
    if (!deleteCandidate) return;
    deleteDeck(deleteCandidate.id);
    setDeleteDeckId(null);
    setMenuDeckId(null);
  }

  const deckOverlays = (
    <>
      <Modal
        visible={menuDeck != null}
        transparent
        animationType="fade"
        onRequestClose={() => setMenuDeckId(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.actionMenu}>
            <Text style={styles.actionMenuTitle} numberOfLines={2}>{menuDeck?.name}</Text>
            <TouchableOpacity
              style={styles.actionMenuItem}
              onPress={() => {
                if (!menuDeck) return;
                setActiveDeck(menuDeck.id);
                setMenuDeckId(null);
              }}
              testID="deck-menu-open"
              accessibilityRole="button"
              accessibilityLabel={t('deck_open_a11y', { name: menuDeck?.name || '' })}
            >
              <Text style={styles.actionMenuText}>{t('deck_open_edit')}</Text>
            </TouchableOpacity>
            {menuDeck?.id === activeDeck?.id && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                onPress={() => {
                  setMenuDeckId(null);
                  startRename();
                }}
                testID="deck-menu-rename"
                accessibilityRole="button"
                accessibilityLabel={t('deck_rename')}
              >
                <Text style={styles.actionMenuText}>{t('deck_rename')}</Text>
              </TouchableOpacity>
            )}
            {menuDeck?.id === activeDeck?.id && (
              <TouchableOpacity
                style={styles.actionMenuItem}
                onPress={() => {
                  setActiveDeck(null);
                  setMenuDeckId(null);
                }}
                testID="deck-menu-library"
                accessibilityRole="button"
                accessibilityLabel={t('deck_back_library')}
              >
                <Text style={styles.actionMenuText}>{t('deck_back_library')}</Text>
              </TouchableOpacity>
            )}
            <TouchableOpacity
              style={styles.actionMenuItem}
              onPress={() => {
                setDeleteDeckId(menuDeck?.id || null);
                setMenuDeckId(null);
              }}
              testID="deck-menu-delete"
              accessibilityRole="button"
              accessibilityLabel={t('deck_delete_a11y', { name: menuDeck?.name || '' })}
            >
              <Text style={styles.destructiveText}>{t('deck_delete')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.actionMenuCancel}
              onPress={() => setMenuDeckId(null)}
              testID="deck-menu-cancel"
              accessibilityRole="button"
            >
              <Text style={styles.link}>{t('common_cancel')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>

      <Modal
        visible={deleteCandidate != null}
        transparent
        animationType="fade"
        onRequestClose={() => setDeleteDeckId(null)}
      >
        <View style={styles.modalBackdrop}>
          <View style={styles.modalCard} testID="deck-delete-confirmation">
            <Text style={styles.h2}>{t('deck_delete_title')}</Text>
            <Text style={styles.confirmText}>
              {t('deck_delete_body', { name: deleteCandidate?.name || '' })}
            </Text>
            <View style={styles.confirmActions}>
              <TouchableOpacity
                style={styles.secondaryBtn}
                onPress={() => setDeleteDeckId(null)}
                testID="deck-delete-cancel"
                accessibilityRole="button"
                accessibilityLabel={t('deck_delete_cancel_a11y', { name: deleteCandidate?.name || '' })}
              >
                <Text style={styles.secondaryBtnText}>{t('common_cancel')}</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.deleteBtn}
                onPress={confirmDeleteDeck}
                testID="deck-delete-confirm"
                accessibilityRole="button"
                accessibilityLabel={t('deck_delete_confirm_a11y', { name: deleteCandidate?.name || '' })}
              >
                <Text style={styles.deleteBtnText}>{t('deck_delete_confirm', { name: deleteCandidate?.name || '' })}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
    </>
  );

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.muted}>{t('deck_loading')}</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── No active deck → deck picker / creator ──
  if (!activeDeck) {
    return (
      <SafeAreaView style={styles.container}>
        {deckOverlays}
        <ScrollView contentContainerStyle={[styles.pad, isDesktop && styles.libraryDesktop]}>
          <Text style={styles.h1}>{t('deck_title')}</Text>
          <Text style={styles.muted}>{t('deck_local_hint')}</Text>

          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder={t('deck_new_name')}
              placeholderTextColor={COLORS.textSecondary}
              value={newDeckName}
              onChangeText={setNewDeckName}
            />
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => { createDeck(newDeckName); setNewDeckName(''); }}
            >
              <Text style={styles.primaryBtnText}>{t('deck_create')}</Text>
            </TouchableOpacity>
          </View>

          {decks.length > 0 && <Text style={[styles.h2, styles.libraryTitle]}>{t('deck_my_decks')}</Text>}
          <View style={styles.deckLibraryGrid} testID="deck-library-grid">
            {decks.map((deck) => (
              <DeckLibraryCard
                key={deck.id}
                deck={deck}
                desktop={isDesktop}
                onOpen={() => setActiveDeck(deck.id)}
                onMenu={() => setMenuDeckId(deck.id)}
              />
            ))}
          </View>
        </ScrollView>
      </SafeAreaView>
    );
  }

  // ── Editor ──
  // The zone tabs sit OUTSIDE the scrolling body so the live progress stays on
  // screen while the player scrolls the grid (DIC-1067 §1/§10).
  const zoneTabs = (
    <View style={styles.tabBar} testID="deck-zone-tabs">
      {ZONES.map((zone) => {
        const active = zone === activeZone;
        const value = stats ? stats[zone] : 0;
        const target = stats
          ? { oshi: stats.oshiTarget, main: stats.mainTarget, yell: stats.yellTarget }[zone]
          : 0;
        return (
          <TouchableOpacity
            key={zone}
            style={[styles.tab, active && styles.tabActive]}
            onPress={() => { setActiveZone(zone); setCriteria(EMPTY_CRITERIA); }}
            accessibilityRole="tab"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${zoneLabels[zone]} ${value}/${target}`}
            testID={`deck-zone-tab-${zone}`}
          >
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
              {zoneLabels[zone]}
            </Text>
            <Text
              style={[styles.tabProgress, value === target && { color: COLORS.success }]}
              testID={`deck-zone-progress-${zone}`}
            >
              {value}/{target}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );

  const numColumns = isWide ? 4 : isDesktop ? 3 : 2;
  const filterPanel = (
    <CardFilterPanel
      criteria={criteria}
      onChange={setCriteria}
      options={filterOptions}
      categoryChoices={categoryChoices}
      resultCount={results.length}
    />
  );

  const pickerPanel = (
    <View style={[styles.panel, isDesktop && styles.panelGrid]}>
      <Text style={styles.h2}>{t('deck_choose_card')}</Text>
      {!isDesktop && (
        <View style={styles.mobileFilterRow}>
          <TouchableOpacity
            style={styles.filterBtn}
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel={t('deck_open_filters')}
            testID="open-filters"
          >
            <Text style={styles.filterBtnText}>{t('deck_search_filters')}</Text>
          </TouchableOpacity>
          <Text style={styles.resultCount} testID="card-result-count-mobile">
            {t('deck_cards_count', { count: results.length })}
          </Text>
        </View>
      )}
      <CardPickerGrid
        groups={results}
        numColumns={numColumns}
        height={isDesktop ? 620 : 460}
        qtyOf={(cardNumber) => qtyByCardNumber.get(cardNumber) ?? 0}
        onAdd={addToDeck}
        emptyLabel={t('deck_no_results')}
      />
    </View>
  );

  const selectedSlots = activeDeck[activeZone];
  const deckPanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      {renaming ? (
        <View style={styles.renameBlock}>
          <TextInput
            style={[styles.input, styles.renameInput, renameError && styles.renameInputError]}
            placeholder={t('deck_name_placeholder')}
            placeholderTextColor={COLORS.textSecondary}
            value={renameValue}
            onChangeText={(t) => { setRenameValue(t); if (renameError) setRenameError(false); }}
            onSubmitEditing={commitRename}
            autoFocus
            testID="deck-rename-input"
            accessibilityLabel={t('deck_name_placeholder')}
          />
          <View style={styles.renameActions}>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={commitRename}
              testID="deck-rename-save"
              accessibilityRole="button"
              accessibilityLabel={t('deck_rename_save_a11y')}
            >
              <Text style={styles.primaryBtnText}>{t('common_save')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={cancelRename}
              testID="deck-rename-cancel"
              accessibilityRole="button"
              accessibilityLabel={t('deck_rename_cancel_a11y')}
            >
              <Text style={styles.link}>{t('common_cancel')}</Text>
            </TouchableOpacity>
          </View>
          {renameError && (
            <Text style={styles.renameErrorText}>{t('deck_name_empty')}</Text>
          )}
        </View>
      ) : (
        <View style={styles.deckHeaderRow}>
          <Text style={[styles.h2, { flexShrink: 1 }]} numberOfLines={1}>{activeDeck.name}</Text>
          <TouchableOpacity
            style={styles.menuButton}
            onPress={() => setMenuDeckId(activeDeck.id)}
            testID="deck-editor-menu"
            accessibilityRole="button"
            accessibilityLabel={t('deck_actions_a11y', { name: activeDeck.name })}
          >
            <Text style={styles.menuButtonText}>•••</Text>
          </TouchableOpacity>
        </View>
      )}

      {activeDeck.origin?.kind === 'tournament' && (
        <View style={styles.originBanner} testID="deck-origin-banner">
          <Text style={styles.originText}>
            {t('deck_imported_from', {
              event: activeDeck.origin.eventName,
              code: activeDeck.origin.decklogCode ? `（${activeDeck.origin.decklogCode}）` : '',
            })}
          </Text>
        </View>
      )}

      {stats && (
        <View style={styles.statsRow}>
          <Stat label={zoneLabels.oshi} value={stats.oshi} target={stats.oshiTarget} />
          <Stat label={zoneLabels.main} value={stats.main} target={stats.mainTarget} />
          <Stat label={zoneLabels.yell} value={stats.yell} target={stats.yellTarget} />
          <Stat label={t('deck_total')} value={stats.total} target={stats.totalTarget} emphasize />
        </View>
      )}

      <View style={styles.finalizeRow}>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={finalizeDeck}
          testID="deck-finalize-button"
          accessibilityRole="button"
          accessibilityLabel={t('deck_finalize_a11y')}
        >
          <Text style={styles.primaryBtnText}>{t('deck_finalize')}</Text>
        </TouchableOpacity>
        {lowCostDrift > 0 && (
          <TouchableOpacity
            onPress={() => applyLowCostVariants(activeDeck.id, lowCostIndex)}
            testID="deck-apply-low-cost"
            accessibilityRole="button"
            accessibilityLabel={t('deck_apply_low_cost_a11y', { count: lowCostDrift })}
          >
            <Text style={styles.link}>{t('deck_low_cost_variants')}（{lowCostDrift}）</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.zoneBlock} testID="deck-mobile-selected-grid">
        <Text style={styles.zoneTitle}>{t('deck_selected_zone', { zone: zoneLabels[activeZone] })}</Text>
        {selectedSlots.length === 0 && <Text style={styles.muted}>{t('deck_no_cards')}</Text>}
        {isPhone ? (
          // DIC-1380 W8 CR — Pen `uXuqo` selected-deck grid: 12 image-card
          // cells (3×4) on the mobile viewport instead of the text-only
          // rows the earlier revisions carried. Each filled cell shows
          // the card image thumbnail, card number, and a quantity badge;
          // tapping a cell drops into the quantity controls (+/-/remove)
          // via `expandedSlotId`. Empty cells are placeholders so the
          // grid always reads as a 12-cell layout — an important Pen
          // affordance for "how many cards are in this zone?".
          (() => {
            const GRID_CELLS = 12;
            const cells: Array<{ slot?: typeof selectedSlots[number] }> = [];
            for (const slot of selectedSlots) cells.push({ slot });
            while (cells.length < GRID_CELLS) cells.push({});
            return (
              <View style={styles.mobileImageGrid} testID="deck-mobile-selected-grid-tiles">
                {cells.slice(0, Math.max(GRID_CELLS, cells.length)).map((cell, idx) => {
                  if (!cell.slot) {
                    return (
                      <View
                        key={`empty-${idx}`}
                        style={[styles.mobileImageTile, styles.mobileImageTileEmpty]}
                        testID={`deck-mobile-grid-cell-empty-${idx}`}
                      />
                    );
                  }
                  const slot = cell.slot;
                  const displayName = resolveCardDisplayName(slot.card, preferredLanguage);
                  const cardImageUrl = (slot.card as any)?.imageUrl
                    || ((slot.card as any)?.images?.[0])
                    || null;
                  return (
                    <View
                      key={slot.card.id}
                      style={styles.mobileImageTile}
                      accessibilityLabel={`${displayName.primary || slot.card.name} × ${slot.qty}`}
                      testID={`deck-mobile-grid-cell-${slot.card.cardNumber}`}
                    >
                      {cardImageUrl ? (
                        <Image
                          source={{ uri: cardImageUrl }}
                          style={styles.mobileImageTileImg}
                          resizeMode="cover"
                          testID={`deck-mobile-grid-cell-img-${slot.card.cardNumber}`}
                        />
                      ) : (
                        <View
                          style={styles.mobileImageTilePlaceholder}
                          testID={`deck-mobile-grid-cell-img-${slot.card.cardNumber}`}
                        />
                      )}
                      <View style={styles.mobileImageTileBadge}>
                        <Text style={styles.mobileImageTileBadgeText}>×{slot.qty}</Text>
                      </View>
                      <View style={styles.mobileImageTileLabel}>
                        <Text style={styles.mobileImageTileNameText} numberOfLines={1}>
                          {displayName.primary || slot.card.name}
                        </Text>
                        {displayName.secondary ? (
                          <Text style={styles.mobileImageTileNameSubtitle} numberOfLines={1}>
                            {displayName.secondary}
                          </Text>
                        ) : null}
                        <Text style={styles.mobileImageTileLabelText} numberOfLines={1}>
                          {slot.card.cardNumber}
                        </Text>
                      </View>
                      {/* Compact qty controls anchored on the tile: the DIC-1064
                          / DIC-1086 E2E lookups keep resolving the same
                          testIDs. */}
                      <View style={styles.mobileImageTileQty}>
                        <TouchableOpacity
                          onPress={() => changeCard(activeDeck.id, activeZone, slot.card, -1)}
                          accessibilityRole="button"
                          accessibilityLabel={t('deck_decrease_a11y', { name: slot.card.name })}
                          testID={`deck-slot-dec-${slot.card.cardNumber}`}
                          style={styles.mobileImageTileQtyBtn}
                        >
                          <Text style={styles.mobileImageTileQtyIcon}>−</Text>
                        </TouchableOpacity>
                        <TouchableOpacity
                          onPress={() => changeCard(activeDeck.id, activeZone, slot.card, 1)}
                          accessibilityRole="button"
                          accessibilityLabel={t('deck_increase_a11y', { name: slot.card.name })}
                          testID={`deck-slot-inc-${slot.card.cardNumber}`}
                          style={styles.mobileImageTileQtyBtn}
                        >
                          <Text style={styles.mobileImageTileQtyIcon}>+</Text>
                        </TouchableOpacity>
                      </View>
                      <TouchableOpacity
                        onPress={() => removeCard(activeDeck.id, activeZone, slot.card.id)}
                        accessibilityRole="button"
                        accessibilityLabel={t('deck_remove_a11y', { name: slot.card.name })}
                        testID={`deck-slot-remove-${slot.card.cardNumber}`}
                        style={styles.mobileImageTileRemove}
                      >
                        <Text style={styles.mobileImageTileRemoveIcon}>×</Text>
                      </TouchableOpacity>
                    </View>
                  );
                })}
              </View>
            );
          })()
        ) : (
          selectedSlots.map((slot) => {
            const displayName = resolveCardDisplayName(slot.card, preferredLanguage);
            return (
            <View key={slot.card.id} style={styles.slotRow} testID={`deck-slot-${slot.card.cardNumber}`}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{displayName.primary || slot.card.name}</Text>
                {displayName.secondary ? (
                  <Text style={styles.cardMetaZh} numberOfLines={1}>{displayName.secondary}</Text>
                ) : null}
                <Text style={styles.cardMeta}>
                  {slot.card.cardNumber} · {printingLabelOf(slot.card, t)}
                </Text>
              </View>
              <View style={styles.qtyControls}>
                <TouchableOpacity
                  style={styles.qtyBtn}
                  onPress={() => changeCard(activeDeck.id, activeZone, slot.card, -1)}
                  accessibilityRole="button"
                  accessibilityLabel={t('deck_decrease_a11y', { name: slot.card.name })}
                  testID={`deck-slot-dec-${slot.card.cardNumber}`}
                >
                  <Text style={styles.qtyBtnText}>－</Text>
                </TouchableOpacity>
                <Text style={styles.qtyValue}>{slot.qty}</Text>
                <TouchableOpacity
                  style={styles.qtyBtn}
                  onPress={() => changeCard(activeDeck.id, activeZone, slot.card, 1)}
                  accessibilityRole="button"
                  accessibilityLabel={t('deck_increase_a11y', { name: slot.card.name })}
                  testID={`deck-slot-inc-${slot.card.cardNumber}`}
                >
                  <Text style={styles.qtyBtnText}>＋</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.removeBtn}
                  onPress={() => removeCard(activeDeck.id, activeZone, slot.card.id)}
                  accessibilityRole="button"
                  accessibilityLabel={t('deck_remove_a11y', { name: slot.card.name })}
                  testID={`deck-slot-remove-${slot.card.cardNumber}`}
                >
                  <Text style={styles.link}>{t('common_remove')}</Text>
                </TouchableOpacity>
              </View>
            </View>
            );
          })
        )}
      </View>
    </View>
  );

  const estimatePanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      {/* Deck gap panel — Store MVP 保留（缺卡數量對編輯有用），但拿掉
          參考售價相關文案、每列估價、店家總計、以及到價提醒 CTA / editor。
          FEATURES.marketData 管價格、FEATURES.watchlist 管提醒 (DIC-1256)。 */}
      <Text style={styles.h2}>{t(FEATURES.marketData ? 'deck_gap_title' : 'deck_gap_title_store')}</Text>
      {gap && gap.rows.map((r) => {
        const alert = priceAlerts[priceAlertKey(r.cardNumber, r.version)] ?? null;
        const displayName = resolveCardDisplayName(
          { name: r.name, nameZh: r.nameZh },
          preferredLanguage,
        );
        return (
          <View key={`${r.cardNumber}|${r.version}`} style={styles.gapBlock}>
            <View style={styles.gapRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{displayName.primary || r.name}</Text>
                {displayName.secondary ? (
                  <Text style={styles.cardMetaZh} numberOfLines={1}>{displayName.secondary}</Text>
                ) : null}
                <Text style={styles.cardMeta}>
                  {r.cardNumber} · {r.versionLabel || r.version}
                </Text>
              </View>
              <View style={styles.gapNumbers}>
                <Text style={styles.gapNeed}>{t('deck_required', { count: r.required })}</Text>
                <Text style={[styles.gapMissing, r.missing > 0 && { color: COLORS.error }]}>{t('deck_missing', { count: r.missing })}</Text>
                {FEATURES.marketData && (
                  <Text style={styles.gapPrice} testID={`gap-price-${r.cardNumber}|${r.version}`}>
                    {r.missing === 0
                      ? '—'
                      : r.price.status === 'ok'
                        ? `${r.subtotal} ${r.price.currency}`
                        : t('deck_no_exact_price')}
                  </Text>
                )}
              </View>
            </View>
            {FEATURES.watchlist && r.missing > 0 && (
              r.price.status === 'ok' ? (
                <TouchableOpacity
                  style={styles.alertRow}
                  onPress={() => setAlertTarget({
                    cardNumber: r.cardNumber,
                    printing: r.version,
                    printingLabel: r.versionLabel,
                    name: r.name,
                    currency: r.price.status === 'ok' ? r.price.currency : '',
                    currentPrice: r.price.status === 'ok' ? r.price.price : null,
                  })}
                  accessibilityRole="button"
                  accessibilityLabel={t('deck_alert_a11y', { name: r.name, version: r.versionLabel || r.version })}
                  testID={`price-alert-open-${r.cardNumber}|${r.version}`}
                >
                  <Text style={styles.alertLink}>
                    {alert ? t('deck_alert_edit', { interval: formatInterval(alert) }) : t('deck_alert_set')}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.alertDisabled} testID={`price-alert-unavailable-${r.cardNumber}|${r.version}`}>
                  {t('deck_alert_unavailable')}
                </Text>
              )
            )}
          </View>
        );
      })}
      {gap && (gap.rows.length === 0
        ? <Text style={styles.muted}>{t('deck_empty_gap')}</Text>
        : FEATURES.marketData ? (
          <View style={styles.totalCard} testID="deck-gap-totals">
            {gap.subtotals.length === 0 ? (
              <Text style={styles.totalText}>{t('deck_gap_total_unavailable')}</Text>
            ) : (
              gap.subtotals.map((s) => (
                <View key={s.currency}>
                  <Text style={styles.totalText} testID={`gap-subtotal-${s.currency}`}>
                    {t('deck_gap_subtotal', { currency: s.currency, total: s.total })}
                  </Text>
                  <Text style={styles.muted}>
                    {t('deck_gap_source', {
                      currency: s.currency,
                      date: s.dataAsOf ? t('deck_data_as_of', { date: s.dataAsOf }) : '',
                    })}
                  </Text>
                </View>
              ))
            )}
            {gap.unpriced.length > 0 && (
              <Text style={[styles.muted, { color: COLORS.warning }]}>
                {t('deck_unpriced', {
                  count: gap.unpriced.length,
                  items: gap.unpriced.map((u) => `${u.cardNumber}${u.version ? `·${u.version}` : ''}`).join('、'),
                })}
              </Text>
            )}
          </View>
        ) : null)}
    </View>
  );

  // Full rule validation lives here and nowhere else: it opens only after
  // 完成組牌, so an in-progress draft never looks like a system failure.
  const finalizeSheet = (
    <Modal
      visible={finalizeIssues !== null}
      transparent
      animationType="fade"
      onRequestClose={() => setFinalizeIssues(null)}
    >
      <View style={styles.modalBackdrop}>
        <View style={styles.modalCard} accessibilityViewIsModal testID="deck-finalize-sheet">
          {finalizeIssues && finalizeIssues.length === 0 ? (
            <>
              <Text style={[styles.h2, { color: COLORS.success }]}>{t('deck_complete_title')}</Text>
              <Text style={styles.muted}>{t('deck_complete_body')}</Text>
            </>
          ) : (
            <>
              <Text style={styles.h2}>{t('deck_incomplete_title', { count: finalizeIssues?.length ?? 0 })}</Text>
              <ScrollView style={styles.modalList}>
                {finalizeIssues?.map((i, idx) => (
                  <View
                    key={`${i.code}-${idx}`}
                    style={[styles.issue, i.level === 'error' ? styles.issueError : styles.issueWarn]}
                  >
                    <Text style={styles.issueLevel}>{i.level === 'error' ? t('deck_error') : t('deck_warning')}</Text>
                    <Text style={styles.issueMsg}>{validationMessage(i)}</Text>
                  </View>
                ))}
              </ScrollView>
            </>
          )}
          <TouchableOpacity
            style={[styles.primaryBtn, styles.modalBtn]}
            onPress={() => setFinalizeIssues(null)}
            testID="deck-finalize-close"
            accessibilityRole="button"
            accessibilityLabel={t('deck_close_edit_a11y')}
          >
            <Text style={styles.primaryBtnText}>
              {finalizeIssues && finalizeIssues.length === 0 ? t('common_done') : t('deck_back_to_edit')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    </Modal>
  );

  // On a phone the filters live in a sheet so the grid keeps the full width.
  const filterSheet = (
    <Modal
      visible={filtersOpen}
      transparent
      animationType="slide"
      onRequestClose={() => setFiltersOpen(false)}
    >
      <View style={styles.sheetBackdrop}>
        <View style={styles.sheet} accessibilityViewIsModal testID="filter-sheet">
          <View style={styles.sheetHeader}>
            <Text style={styles.h2}>{t('deck_search_filters')}</Text>
            <TouchableOpacity
              onPress={() => setFiltersOpen(false)}
              accessibilityRole="button"
              accessibilityLabel={t('deck_close_filters_a11y')}
              testID="close-filters"
              style={styles.sheetClose}
            >
              <Text style={styles.link}>{t('common_done')}</Text>
            </TouchableOpacity>
          </View>
          <ScrollView>{filterPanel}</ScrollView>
        </View>
      </View>
    </Modal>
  );

  // Pen `uXuqo` app bar — top-of-frame deck name / active-deck identifier
  // (DIC-1380 W6). Expanded in W8 CR to carry the four controls the Pen
  // artifact anchors: back, name-edit, validate, overflow menu.
  const phoneAppBar = (
    <View style={styles.phoneAppBar} testID="deck-mobile-appbar">
      <TouchableOpacity
        style={styles.phoneAppBarBtn}
        onPress={() => { try { navigation?.goBack?.(); } catch { /* no-op outside container */ } }}
        accessibilityRole="button"
        accessibilityLabel={t('deck_appbar_back_a11y')}
        testID="deck-mobile-appbar-back"
      >
        <Text style={styles.phoneAppBarIcon}>‹</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.phoneAppBarTitleTap}
        onPress={() => {
          if (!activeDeck) return;
          // DIC-1380 W8 CR — the rename block lives inside the mobile
          // deckPanel, so a tap that starts a rename must first surface
          // the deckPanel. Switch to the currently active zone (or
          // default to `main`) before flipping renaming on.
          if (mobilePanel === 'picker' || mobilePanel === 'shortage') {
            setMobilePanel(activeZone ?? 'main');
          }
          startRename();
        }}
        disabled={!activeDeck}
        accessibilityRole="button"
        accessibilityLabel={activeDeck ? t('deck_appbar_rename_a11y', { name: activeDeck.name }) : t('deck_title')}
        testID="deck-mobile-appbar-name-edit"
      >
        <Text style={styles.phoneAppBarTitle} numberOfLines={1} testID="deck-mobile-appbar-title">
          {activeDeck ? activeDeck.name : t('deck_title')}
        </Text>
        {activeDeck ? (
          <Text style={styles.phoneAppBarMeta} numberOfLines={1} testID="deck-mobile-appbar-meta">
            {t('deck_zone_main')} {stats?.main ?? 0}/{stats?.mainTarget ?? 50}
          </Text>
        ) : null}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.phoneAppBarBtn}
        onPress={() => { if (activeDeck) finalizeDeck(); }}
        disabled={!activeDeck}
        accessibilityRole="button"
        accessibilityLabel={t('deck_appbar_validate_a11y')}
        testID="deck-mobile-appbar-validate"
      >
        <Text style={styles.phoneAppBarIcon}>✓</Text>
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.phoneAppBarBtn}
        onPress={() => { if (activeDeck) setMenuDeckId(activeDeck.id); }}
        disabled={!activeDeck}
        accessibilityRole="button"
        accessibilityLabel={t('deck_appbar_menu_a11y')}
        testID="deck-mobile-appbar-overflow"
      >
        <Text style={styles.phoneAppBarIcon}>⋯</Text>
      </TouchableOpacity>
    </View>
  );

  // Pen `uXuqo` status banner — persistent one-line legality state so the
  // player sees "is this deck ready to enter a tournament?" at every step.
  // Reads deck legal status from `isDeckLegal`; renders green when legal,
  // amber when close, red when not (DIC-1380 W6).
  const phoneStatusBanner = activeDeck && stats ? (() => {
    const legal = isDeckLegal(activeDeck);
    const label = legal
      ? t('deck_status_legal')
      : stats.total === 0
        ? t('deck_status_empty')
        : t('deck_status_incomplete');
    return (
      <View
        style={[
          styles.phoneStatusBanner,
          legal && styles.phoneStatusBannerOk,
        ]}
        testID="deck-mobile-status-banner"
      >
        <Text style={styles.phoneStatusBannerDot}>{legal ? '●' : '○'}</Text>
        <Text style={styles.phoneStatusBannerText} numberOfLines={1}>
          {label} · {t('deck_total')} {stats.total}/{stats.totalTarget}
        </Text>
      </View>
    );
  })() : null;

  const phoneProgress = stats && (
    <View style={styles.phoneProgress} testID="deck-phone-progress">
      <Text style={styles.phoneProgressText}>{zoneLabels.oshi} {stats.oshi}/{stats.oshiTarget}</Text>
      <Text style={styles.phoneProgressText}>{zoneLabels.main} {stats.main}/{stats.mainTarget}</Text>
      <Text style={styles.phoneProgressText}>{zoneLabels.yell} {stats.yell}/{stats.yellTarget}</Text>
      <Text style={[styles.phoneProgressText, styles.phoneProgressTotal]}>
        {t('deck_total')} {stats.total}/{stats.totalTarget}
      </Text>
    </View>
  );

  // Pen `uXuqo` grid head — a small header above the picker's card grid
  // that names the current category + shows the visible-count summary.
  // Only meaningful on the picker panel (DIC-1380 W6).
  const phoneGridHead = mobilePanel === 'picker' ? (
    <View style={styles.phoneGridHead} testID="deck-mobile-grid-head">
      <Text style={styles.phoneGridHeadTitle} numberOfLines={1}>
        {activeZone === 'oshi' ? zoneLabels.oshi
          : activeZone === 'main' ? zoneLabels.main
          : zoneLabels.yell}
      </Text>
      <Text style={styles.phoneGridHeadCategory} numberOfLines={1}>
        {ZONE_CATEGORIES[activeZone].map((c) => t(`card_category_${c}` as TranslationKey)).join(' · ')}
      </Text>
    </View>
  ) : null;

  // DIC-1380 W5: mobile panel switch matches Pen frame `uXuqo` — the zone
  // tabs (`AMhtu` in the artifact) carry an inline `count/target` sub-label
  // so the player sees "主牌組 43/50" the way the Pen artifact anchors it.
  // The picker + shortage entries are preserved as tabs for now (an
  // existing DIC-1064 render regression pins them) and complemented by
  // the persistent Missing Bar (Pen `QUFqI`) below the tab strip.
  const zoneCount = (zone: DeckZone): { value: number; target: number } | null => {
    if (!stats) return null;
    if (zone === 'oshi') return { value: stats.oshi, target: stats.oshiTarget };
    if (zone === 'main') return { value: stats.main, target: stats.mainTarget };
    if (zone === 'yell') return { value: stats.yell, target: stats.yellTarget };
    return null;
  };

  // DIC-1380 W7 CR — mobile primary panel switch now matches accepted Pen
  // frame `uXuqo`: THREE zone tabs (Main / Yell / Oshi) as the primary
  // hierarchy. Picker + shortage are moved out of the primary tab strip
  // into a secondary control row below, so the player never has to scan
  // five tabs to find the zone they wanted. Each zone tab still carries
  // the Pen `AMhtu` inline `count/target` sub-label.
  //
  // The Pen visual order is Main / Yell / Oshi (main deck first because
  // that is what the player is building), and the secondary row exposes
  // `選卡` (picker) and `缺卡` (shortage) as compact chips. The
  // `deck-mobile-panel-{picker,shortage}` testIDs remain on the
  // secondary chips so DIC-1064 render regressions + the DIC-1086 E2E
  // still resolve the same controls.
  const primaryZones: Array<[DeckZone, string]> = [
    ['main', zoneLabels.main],
    ['yell', zoneLabels.yell],
    ['oshi', zoneLabels.oshi],
  ];

  const phonePanelSwitch = (
    <View style={styles.phonePanelSwitchWrap} testID="deck-mobile-primary-tabs">
      <View style={styles.phonePanelSwitch} testID="deck-mobile-panel-switch">
        {primaryZones.map(([zone, label]) => {
          const active = mobilePanel === zone;
          const count = zoneCount(zone);
          return (
            <TouchableOpacity
              key={zone}
              style={[styles.phonePanelTab, active && styles.phonePanelTabActive]}
              onPress={() => {
                setMobilePanel(zone);
                setActiveZone(zone);
                setCriteria(EMPTY_CRITERIA);
              }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
              accessibilityLabel={count ? `${label} ${count.value}/${count.target}` : label}
              testID={`deck-mobile-panel-${zone}`}
            >
              <Text style={[styles.phonePanelLabel, active && styles.phonePanelLabelActive]} numberOfLines={1}>
                {label}
              </Text>
              {count ? (
                <Text
                  style={[styles.phonePanelCount, active && styles.phonePanelCountActive]}
                  testID={`deck-mobile-panel-${zone}-count`}
                  numberOfLines={1}
                >
                  {count.value}/{count.target}
                </Text>
              ) : null}
            </TouchableOpacity>
          );
        })}
      </View>
      {/* Secondary control row — picker + shortage as compact chips.
          Not in the primary tab strip (Pen `uXuqo` hierarchy) but still
          reachable in one tap. */}
      <View style={styles.phoneSecondaryControls} testID="deck-mobile-secondary-controls">
        <TouchableOpacity
          style={[styles.phoneSecondaryChip, mobilePanel === 'picker' && styles.phoneSecondaryChipActive]}
          onPress={() => {
            setMobilePanel('picker');
            setCriteria(EMPTY_CRITERIA);
          }}
          accessibilityRole="button"
          accessibilityState={{ selected: mobilePanel === 'picker' }}
          testID="deck-mobile-panel-picker"
        >
          <Text style={styles.phoneSecondaryChipLabel} numberOfLines={1}>{t('deck_choose_card')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={[styles.phoneSecondaryChip, mobilePanel === 'shortage' && styles.phoneSecondaryChipActive]}
          onPress={() => setMobilePanel('shortage')}
          accessibilityRole="button"
          accessibilityState={{ selected: mobilePanel === 'shortage' }}
          testID="deck-mobile-panel-shortage"
        >
          <Text style={styles.phoneSecondaryChipLabel} numberOfLines={1}>{t('deck_shortage')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );

  // Pen `QUFqI` Missing Bar — persistent bottom summary of the shortage +
  // an "apply low-cost variants" action. Rendered on phones only; tapping
  // the summary jumps into the shortage panel, and the button applies the
  // low-cost printings to every zone in the active deck through the same
  // path the desktop `applyLowCostVariants` uses. Hidden under Store MVP
  // because `FEATURES.marketData=false` strips gap pricing everywhere.
  const missingCount = gap
    ? gap.rows.reduce((sum, r) => sum + Math.max(0, r.missing), 0)
    : 0;
  const missingSubtotal = gap && gap.subtotals.length > 0
    ? gap.subtotals[0]
    : null;
  const mobileMissingBar = FEATURES.marketData && activeDeck ? (
    <View style={styles.missingBar} testID="deck-mobile-missing-bar">
      <TouchableOpacity
        style={styles.missingBarSummary}
        accessibilityRole="button"
        accessibilityLabel={t('deck_shortage')}
        testID="deck-mobile-missing-bar-summary"
        onPress={() => setMobilePanel('shortage')}
      >
        <Text style={styles.missingBarLabel} numberOfLines={1}>
          {t('deck_shortage')} · {missingCount}
        </Text>
        {missingSubtotal ? (
          <Text style={styles.missingBarValue} numberOfLines={1} testID="deck-mobile-missing-bar-total">
            {missingSubtotal.currency} {missingSubtotal.total.toLocaleString()}
          </Text>
        ) : null}
      </TouchableOpacity>
      <TouchableOpacity
        style={styles.missingBarButton}
        accessibilityRole="button"
        accessibilityLabel={t('deck_low_cost_variants')}
        testID="deck-mobile-apply-low-cost"
        onPress={() => applyLowCostVariants(activeDeck.id, lowCostIndex)}
      >
        <Text style={styles.missingBarButtonLabel} numberOfLines={1}>
          {t('deck_low_cost_variants')}
        </Text>
      </TouchableOpacity>
    </View>
  ) : null;

  const phonePanel = mobilePanel === 'picker'
    ? pickerPanel
    : mobilePanel === 'shortage'
      ? estimatePanel
      : deckPanel;

  return (
    <SafeAreaView style={styles.container}>
      {deckOverlays}
      {finalizeSheet}
      {filterSheet}
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      {isPhone && phoneAppBar}
      {isPhone && phoneStatusBanner}
      {isPhone ? phoneProgress : zoneTabs}
      {isPhone && phonePanelSwitch}
      {isPhone && phoneGridHead}
      {isDesktop ? (
        <ScrollView contentContainerStyle={styles.desktopWrap}>
          <View style={styles.desktopCols}>
            <View style={[styles.panel, styles.panelCol]}>
              <Text style={styles.h2}>{t('deck_search_and_filter')}</Text>
              {filterPanel}
            </View>
            {pickerPanel}
            <View style={styles.desktopStackCol}>
              {deckPanel}
              {estimatePanel}
            </View>
          </View>
        </ScrollView>
      ) : isPhone ? (
        <>
          <ScrollView contentContainerStyle={styles.pad} style={{ flex: 1 }}>
            {phonePanel}
          </ScrollView>
          {mobileMissingBar}
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.pad}>
          {pickerPanel}
          {deckPanel}
          {estimatePanel}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function DeckLibraryCard({
  deck, desktop, onOpen, onMenu,
}: {
  deck: Deck;
  desktop: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const { t } = useTranslation();
  const stats = deckStats(deck);
  const oshiCard = deck.oshi[0]?.card;
  return (
    <View style={[styles.deckTile, desktop && styles.deckTileDesktop]} testID={`deck-tile-${deck.id}`}>
      <TouchableOpacity
        style={styles.deckTileMain}
        onPress={onOpen}
        accessibilityRole="button"
        accessibilityLabel={t('deck_open_a11y', { name: deck.name })}
        testID={`deck-open-${deck.id}`}
      >
        <DeckOshiPreview card={oshiCard} />
        <View style={styles.deckTileBody}>
          <View style={styles.deckTileHeading}>
            <Text style={styles.deckTileName} numberOfLines={2}>{deck.name}</Text>
            <LegalBadge deck={deck} />
          </View>
          {deck.origin?.kind === 'tournament' && (
            <Text style={styles.importedLabel} numberOfLines={1}>{t('deck_imported_label')}</Text>
          )}
          <Text style={styles.oshiName} numberOfLines={2}>
            {oshiCard ? oshiCard.name : t('deck_oshi_unselected')}
          </Text>
          <View style={styles.compactProgress} accessibilityLabel={t('deck_progress_a11y', {
            oshi: stats.oshi, oshiTarget: stats.oshiTarget,
            main: stats.main, mainTarget: stats.mainTarget,
            yell: stats.yell, yellTarget: stats.yellTarget,
          })}>
            <Text style={styles.compactProgressText}>{t('deck_zone_oshi')} {stats.oshi}/{stats.oshiTarget}</Text>
            <Text style={styles.compactProgressText}>{t('deck_zone_main')} {stats.main}/{stats.mainTarget}</Text>
            <Text style={styles.compactProgressText}>{t('deck_zone_yell')} {stats.yell}/{stats.yellTarget}</Text>
          </View>
        </View>
      </TouchableOpacity>
      <View style={styles.deckTileActions}>
        <TouchableOpacity
          style={styles.openDeckBtn}
          onPress={onOpen}
          accessibilityRole="button"
          accessibilityLabel={t('deck_edit_a11y', { name: deck.name })}
        >
          <Text style={styles.openDeckBtnText}>{t('deck_edit')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.menuButton}
          onPress={onMenu}
          accessibilityRole="button"
          accessibilityLabel={t('deck_actions_a11y', { name: deck.name })}
          testID={`deck-menu-${deck.id}`}
        >
          <Text style={styles.menuButtonText}>•••</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

function DeckOshiPreview({ card }: { card?: DeckCard }) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [card?.imageUrl]);

  if (!card?.imageUrl || failed) {
    return (
      <View style={[styles.deckOshiImage, styles.deckOshiPlaceholder]} testID="deck-oshi-placeholder">
        <Text style={styles.deckOshiPlaceholderIcon}>☆</Text>
        <Text style={styles.deckOshiPlaceholderText}>{t('deck_oshi_placeholder')}</Text>
      </View>
    );
  }

  return (
    <Image
      source={{ uri: card.imageUrl }}
      style={styles.deckOshiImage}
      resizeMode="contain"
      onError={() => setFailed(true)}
      accessibilityLabel={t('deck_oshi_image_a11y', { name: card.name })}
    />
  );
}

// An incomplete deck is a 草稿, not a failure — error wording is reserved for a
// failed 完成組牌 attempt (DIC-1004 §B5).
function LegalBadge({ deck }: { deck: Deck }) {
  const { t } = useTranslation();
  const legal = isDeckLegal(deck);
  return (
    <Text
      style={[styles.badgeText, { color: legal ? COLORS.success : COLORS.textSecondary }]}
      testID={`deck-badge-${deck.id}`}
    >
      {legal ? t('deck_legal_badge') : t('deck_draft_badge')}
    </Text>
  );
}

function Stat({ label, value, target, emphasize }: { label: string; value: number; target: number; emphasize?: boolean }) {
  const ok = value === target;
  return (
    <View style={styles.stat}>
      <Text style={styles.statLabel}>{label}</Text>
      <Text style={[styles.statValue, emphasize && styles.statValueEmph, { color: ok ? COLORS.success : COLORS.text }]}>
        {value}/{target}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  pad: { padding: 16 },
  desktopWrap: { padding: 16 },
  desktopCols: { flexDirection: 'row', gap: 16, alignItems: 'flex-start' },
  panel: { backgroundColor: COLORS.surface, borderRadius: 12, padding: 14, marginBottom: 16, borderWidth: 1, borderColor: COLORS.border },
  panelCol: { flex: 1, marginBottom: 0 },
  panelGrid: { flex: 1.6, marginBottom: 0 },
  h1: { fontSize: 22, fontWeight: 'bold', color: COLORS.primary, marginBottom: 6 },
  h2: { fontSize: 17, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  muted: { color: COLORS.textSecondary, fontSize: 13, marginTop: 4 },
  link: { color: COLORS.primary, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  input: { backgroundColor: COLORS.surfaceLight, color: COLORS.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: COLORS.border },
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 16, minHeight: 44, justifyContent: 'center' },
  primaryBtnText: { color: '#fff', fontWeight: 'bold', textAlign: 'center' },
  secondaryBtn: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight },
  secondaryBtnText: { color: COLORS.text, fontWeight: 'bold', textAlign: 'center' },
  deleteBtn: { minHeight: 44, flex: 1, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.error },
  deleteBtnText: { color: '#fff', fontWeight: 'bold', textAlign: 'center' },
  tabBar: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tab: { flex: 1, minHeight: 48, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  tabActive: { borderColor: COLORS.primary, backgroundColor: COLORS.background },
  tabLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: COLORS.primary },
  tabProgress: { color: COLORS.text, fontSize: 14, fontWeight: 'bold', marginTop: 2 },
  phoneAppBar: { paddingHorizontal: 8, paddingVertical: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, flexDirection: 'row', alignItems: 'center', gap: 4 },
  phoneAppBarBtn: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8 },
  phoneAppBarIcon: { color: COLORS.text, fontSize: 22, fontWeight: '700' },
  phoneAppBarTitleTap: { flex: 1, minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  phoneAppBarTitle: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  phoneAppBarMeta: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600', marginTop: 2 },
  phoneStatusBanner: { paddingHorizontal: 16, paddingVertical: 8, backgroundColor: COLORS.surfaceLight, borderBottomWidth: 1, borderBottomColor: COLORS.border, flexDirection: 'row', alignItems: 'center', gap: 8 },
  phoneStatusBannerOk: { backgroundColor: '#0f2c1e' },
  phoneStatusBannerDot: { color: COLORS.primary, fontSize: 12, fontWeight: '700' },
  phoneStatusBannerText: { color: COLORS.text, fontSize: 12, fontWeight: '600', flex: 1 },
  phoneGridHead: { paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border, flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
  phoneGridHeadTitle: { color: COLORS.text, fontSize: 14, fontWeight: '700' },
  phoneGridHeadCategory: { color: COLORS.textSecondary, fontSize: 11, fontWeight: '600' },
  // DIC-1380 W8 CR — Pen `uXuqo` 12-cell (3×4) image-card selected grid
  mobileImageGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    padding: 4,
  },
  mobileImageTile: {
    width: '31%',
    aspectRatio: 0.72,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.border,
    backgroundColor: COLORS.surfaceLight,
    overflow: 'hidden',
    position: 'relative',
  },
  mobileImageTileEmpty: {
    backgroundColor: 'rgba(255,255,255,0.02)',
    borderStyle: 'dashed',
    opacity: 0.5,
  },
  mobileImageTileImg: { width: '100%', height: '65%', backgroundColor: COLORS.surfaceLight },
  mobileImageTilePlaceholder: { width: '100%', height: '65%', backgroundColor: COLORS.primary + '30' },
  mobileImageTileBadge: {
    position: 'absolute', top: 4, right: 4,
    backgroundColor: COLORS.primary, borderRadius: 8,
    paddingHorizontal: 6, paddingVertical: 2,
  },
  mobileImageTileBadgeText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  mobileImageTileLabel: {
    position: 'absolute', bottom: 0, left: 0, right: 0,
    backgroundColor: 'rgba(0,0,0,0.55)',
    paddingHorizontal: 4, paddingVertical: 2,
  },
  mobileImageTileNameText: { color: '#fff', fontSize: 10, fontWeight: '700' },
  mobileImageTileNameSubtitle: { color: 'rgba(255,255,255,0.75)', fontSize: 9 },
  mobileImageTileLabelText: { color: 'rgba(255,255,255,0.6)', fontSize: 9, fontFamily: 'monospace' },
  mobileImageTileQty: {
    position: 'absolute', bottom: 20, right: 4,
    flexDirection: 'row', gap: 2,
  },
  mobileImageTileQtyBtn: {
    width: 22, height: 22, borderRadius: 11,
    backgroundColor: COLORS.surface, alignItems: 'center', justifyContent: 'center',
    borderWidth: 1, borderColor: COLORS.border,
  },
  mobileImageTileQtyIcon: { color: COLORS.text, fontSize: 14, fontWeight: '700', lineHeight: 16 },
  mobileImageTileRemove: {
    position: 'absolute', top: 4, left: 4,
    width: 20, height: 20, borderRadius: 10,
    backgroundColor: 'rgba(0,0,0,0.55)',
    alignItems: 'center', justifyContent: 'center',
  },
  mobileImageTileRemoveIcon: { color: '#fff', fontSize: 12, fontWeight: '700', lineHeight: 14 },
  phonePanelSwitchWrap: { backgroundColor: COLORS.surface },
  phoneSecondaryControls: { flexDirection: 'row', paddingHorizontal: 8, paddingBottom: 6, gap: 6 },
  phoneSecondaryChip: { minHeight: 36, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 16, borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center' },
  phoneSecondaryChipActive: { borderColor: COLORS.primary, backgroundColor: COLORS.primary + '22' },
  phoneSecondaryChipLabel: { color: COLORS.text, fontSize: 12, fontWeight: '600' },
  phoneProgress: { flexDirection: 'row', paddingHorizontal: 8, paddingVertical: 6, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  phoneProgressText: { flex: 1, color: COLORS.textSecondary, fontSize: 10, fontWeight: '700', textAlign: 'center' },
  phoneProgressTotal: { color: COLORS.primaryLight },
  phonePanelSwitch: { flexDirection: 'row', paddingHorizontal: 6, paddingVertical: 6, gap: 4, backgroundColor: COLORS.surface },
  phonePanelTab: { flex: 1, minWidth: 0, minHeight: 44, borderRadius: 7, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  phonePanelTabActive: { backgroundColor: COLORS.primary, borderColor: COLORS.primary },
  phonePanelLabel: { color: COLORS.textSecondary, fontSize: 11, fontWeight: '700' },
  phonePanelLabelActive: { color: '#fff' },
  phonePanelCount: { color: COLORS.textSecondary, fontSize: 10, marginTop: 2 },
  phonePanelCountActive: { color: '#fff' },
  // Pen frame `QUFqI` — persistent bottom Missing Bar.
  missingBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 16,
    paddingVertical: 10,
    gap: 12,
    minHeight: 68,
    backgroundColor: COLORS.surface,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
  },
  missingBarSummary: { flex: 1, minHeight: 44, justifyContent: 'center' },
  missingBarLabel: { color: COLORS.textSecondary, fontSize: 13, fontWeight: '700' },
  missingBarValue: { color: COLORS.text, fontSize: 18, fontWeight: 'bold', marginTop: 2 },
  missingBarButton: {
    minHeight: 44,
    paddingHorizontal: 14,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: COLORS.primary,
  },
  missingBarButtonLabel: { color: '#fff', fontSize: 13, fontWeight: 'bold' },
  mobileFilterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  filterBtn: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: COLORS.primary, backgroundColor: COLORS.surfaceLight },
  filterBtnText: { color: COLORS.primary, fontSize: 14, fontWeight: 'bold' },
  resultCount: { color: COLORS.text, fontSize: 13, fontWeight: 'bold' },
  libraryDesktop: { width: '100%', maxWidth: 1100, alignSelf: 'center' },
  libraryTitle: { marginTop: 24 },
  deckLibraryGrid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, alignItems: 'stretch' },
  deckTile: { width: '100%', minWidth: 0, backgroundColor: COLORS.surface, borderRadius: 12, borderWidth: 1, borderColor: COLORS.border, overflow: 'hidden' },
  deckTileDesktop: { flexBasis: '48%', maxWidth: '48%', flexGrow: 0 },
  deckTileMain: { flexDirection: 'row', padding: 12, minHeight: 154 },
  deckOshiImage: { width: 88, aspectRatio: 5 / 7, borderRadius: 8, backgroundColor: COLORS.surfaceLight },
  deckOshiPlaceholder: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  deckOshiPlaceholderIcon: { color: COLORS.primary, fontSize: 28, lineHeight: 32 },
  deckOshiPlaceholderText: { color: COLORS.textSecondary, fontSize: 12, fontWeight: 'bold', marginTop: 4 },
  deckTileBody: { flex: 1, minWidth: 0, marginLeft: 12 },
  deckTileHeading: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 8 },
  deckTileName: { flex: 1, color: COLORS.text, fontSize: 16, lineHeight: 21, fontWeight: 'bold' },
  importedLabel: { color: COLORS.primaryLight, fontSize: 11, fontWeight: 'bold', marginTop: 5 },
  oshiName: { color: COLORS.textSecondary, fontSize: 12, lineHeight: 17, marginTop: 7 },
  compactProgress: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 'auto', paddingTop: 10 },
  compactProgressText: { color: COLORS.text, fontSize: 11, fontWeight: '700', backgroundColor: COLORS.surfaceLight, borderRadius: 5, paddingHorizontal: 6, paddingVertical: 4 },
  deckTileActions: { flexDirection: 'row', gap: 8, padding: 10, paddingTop: 0 },
  openDeckBtn: { flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 8, backgroundColor: COLORS.primary },
  openDeckBtnText: { color: '#fff', fontWeight: 'bold', fontSize: 14 },
  menuButton: { width: 44, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border, backgroundColor: COLORS.surfaceLight },
  menuButtonText: { color: COLORS.text, fontSize: 18, fontWeight: 'bold', letterSpacing: 1 },
  deckHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  renameBlock: { marginBottom: 10 },
  renameInput: { marginBottom: 8 },
  renameInputError: { borderColor: COLORS.error },
  renameActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  renameErrorText: { color: COLORS.error, fontSize: 12, marginTop: 6 },
  statsRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10, marginBottom: 12 },
  originBanner: {
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    borderWidth: 1,
    borderColor: COLORS.primary,
    padding: 10,
    marginBottom: 12,
  },
  originText: { color: COLORS.text, fontSize: 13, fontWeight: '600', lineHeight: 19 },
  stat: { minWidth: 68, alignItems: 'center', backgroundColor: COLORS.surfaceLight, borderRadius: 8, paddingVertical: 8, paddingHorizontal: 10 },
  statLabel: { color: COLORS.textSecondary, fontSize: 11 },
  statValue: { fontSize: 15, fontWeight: 'bold', marginTop: 2 },
  statValueEmph: { fontSize: 17 },
  zoneBlock: { marginTop: 10 },
  zoneTitle: { color: COLORS.primaryLight, fontSize: 14, fontWeight: 'bold', marginBottom: 4 },
  slotRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 6, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  cardName: { color: COLORS.text, fontSize: 14 },
  cardMetaZh: { color: COLORS.textSecondary, fontSize: 12, marginTop: 1 },
  cardMeta: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 44, height: 44, borderRadius: 6, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  qtyBtnText: { color: COLORS.text, fontSize: 16, fontWeight: 'bold' },
  qtyValue: { color: COLORS.text, fontSize: 15, fontWeight: 'bold', minWidth: 28, textAlign: 'center' },
  removeBtn: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  desktopStackCol: { flex: 1, gap: 16 },
  issue: { borderRadius: 8, padding: 10, marginTop: 8, flexDirection: 'row', gap: 8, alignItems: 'flex-start' },
  issueError: { backgroundColor: 'rgba(239,68,68,0.12)', borderWidth: 1, borderColor: COLORS.error },
  issueWarn: { backgroundColor: 'rgba(245,158,11,0.12)', borderWidth: 1, borderColor: COLORS.warning },
  issueLevel: { fontSize: 12, fontWeight: 'bold', color: COLORS.text },
  issueMsg: { flex: 1, color: COLORS.text, fontSize: 13 },
  badgeText: { fontSize: 13, fontWeight: 'bold' },
  gapBlock: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border, paddingBottom: 6 },
  gapRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
  alertRow: { paddingVertical: 4 },
  alertLink: { color: COLORS.primary, fontSize: 12 },
  alertDisabled: { color: COLORS.textSecondary, fontSize: 11, paddingVertical: 4 },
  gapNumbers: { alignItems: 'flex-end', gap: 3 },
  gapNeed: { color: COLORS.textSecondary, fontSize: 12 },
  gapMissing: { color: COLORS.textSecondary, fontSize: 12 },
  gapPrice: { color: COLORS.primaryLight, fontSize: 12 },
  totalCard: { marginTop: 12, backgroundColor: COLORS.surfaceLight, borderRadius: 8, padding: 12 },
  totalText: { color: COLORS.text, fontSize: 15, fontWeight: 'bold' },
  finalizeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 460, backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  actionMenu: { width: '100%', maxWidth: 420, backgroundColor: COLORS.surface, borderRadius: 12, padding: 12, borderWidth: 1, borderColor: COLORS.border },
  actionMenuTitle: { color: COLORS.text, fontSize: 17, lineHeight: 23, fontWeight: 'bold', padding: 10 },
  actionMenuItem: { minHeight: 48, justifyContent: 'center', paddingHorizontal: 12, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: COLORS.border },
  actionMenuText: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  actionMenuCancel: { minHeight: 44, alignItems: 'center', justifyContent: 'center', marginTop: 6 },
  destructiveText: { color: COLORS.error, fontSize: 15, fontWeight: 'bold' },
  confirmText: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 21 },
  confirmActions: { flexDirection: 'row', gap: 10, marginTop: 18 },
  modalList: { maxHeight: 300 },
  modalBtn: { marginTop: 14, alignSelf: 'flex-end' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '85%', backgroundColor: COLORS.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, borderTopWidth: 1, borderColor: COLORS.border },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetClose: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
