import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, Modal,
} from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useDeckStore } from '../store/deckStore';
import {
  validateDeck, deckStats, computeGap, eligibleZone, isDeckLegal, ownershipKey,
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

const ZONE_LABELS: Record<DeckZone, string> = {
  oshi: '推しホロメン',
  main: '主牌組',
  yell: 'エール',
};

const ZONES: DeckZone[] = ['oshi', 'main', 'yell'];

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
}): string {
  if (card.unresolvedPrinting) {
    return card.sourceVersion ? `版本未確認（來源：${card.sourceVersion}）` : '版本未確認';
  }
  return card.printingLabel?.trim() || card.printing;
}

export default function DeckEditorScreen() {
  const { isDesktop, isWide } = useBreakpoint();
  const [db, setDb] = useState<CardDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [newDeckName, setNewDeckName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(false);
  const [activeZone, setActiveZone] = useState<DeckZone>('oshi');
  const [criteria, setCriteria] = useState<PickerCriteria>(EMPTY_CRITERIA);
  const [filtersOpen, setFiltersOpen] = useState(false);
  // Full rule validation is surfaced ONLY when the player presses 完成組牌
  // (DIC-1004 §B) — null means the result sheet is closed.
  const [finalizeIssues, setFinalizeIssues] = useState<ValidationIssue[] | null>(null);
  const [alertTarget, setAlertTarget] = useState<PriceAlertTarget | null>(null);
  const priceAlerts = usePriceAlertStore((s) => s.alerts);

  const decks = useDeckStore((s) => s.decks);
  const activeDeckId = useDeckStore((s) => s.activeDeckId);
  const collection = useDeckStore((s) => s.collection);
  const createDeck = useDeckStore((s) => s.createDeck);
  const renameDeck = useDeckStore((s) => s.renameDeck);
  const setActiveDeck = useDeckStore((s) => s.setActiveDeck);
  const changeCard = useDeckStore((s) => s.changeCard);
  const removeCard = useDeckStore((s) => s.removeCard);
  const applyLowCostVariants = useDeckStore((s) => s.applyLowCostVariants);
  const migrateLegacyPrintings = useDeckStore((s) => s.migrateLegacyPrintings);
  const migrateTournamentDefaults = useDeckStore((s) => s.migrateTournamentDefaults);
  const setOwned = useDeckStore((s) => s.setOwned);
  const adjustOwned = useDeckStore((s) => s.adjustOwned);

  const activeDeck = useMemo(
    () => decks.find((d) => d.id === activeDeckId) || null,
    [decks, activeDeckId],
  );

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

  // Resolve a collection entry (keyed by normalized ownershipKey) back to a
  // displayable card. Built from the loaded database so the global inventory can
  // show real names/versions for owned entries independent of any deck.
  const cardByOwnershipKey = useMemo(() => {
    const map = new Map<string, DeckCard>();
    if (db) for (const c of db.cards) map.set(ownershipKey(c.cardNumber, c.printing), c);
    return map;
  }, [db]);

  const collectionEntries = useMemo(() => {
    return Object.entries(collection)
      .filter(([, qty]) => qty > 0)
      .map(([key, qty]) => {
        const sep = key.indexOf('|');
        const cardNumber = sep === -1 ? key : key.slice(0, sep);
        const version = sep === -1 ? '' : key.slice(sep + 1);
        const card = cardByOwnershipKey.get(key);
        return {
          key, cardNumber, version, qty,
          name: card?.name || cardNumber,
          // 找不到卡片（例如 DIC-1013 前以 rarity 記錄的舊項目）就照原樣顯示版本碼，不臆測。
          versionLabel: card ? printingLabelOf(card) : version,
        };
      })
      .sort((a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.version.localeCompare(b.version));
  }, [collection, cardByOwnershipKey]);

  const stats = activeDeck ? deckStats(activeDeck) : null;
  const gap = activeDeck && db ? computeGap(activeDeck, collection, db.priceRecords) : null;

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

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator color={COLORS.primary} size="large" />
          <Text style={styles.muted}>載入卡片資料庫…</Text>
        </View>
      </SafeAreaView>
    );
  }

  // ── No active deck → deck picker / creator ──
  if (!activeDeck) {
    return (
      <SafeAreaView style={styles.container}>
        <ScrollView contentContainerStyle={styles.pad}>
          <Text style={styles.h1}>牌組編輯器</Text>
          <Text style={styles.muted}>本地牌組（僅存於此裝置）。建立或選擇一個牌組開始編輯。</Text>

          <View style={styles.row}>
            <TextInput
              style={[styles.input, { flex: 1 }]}
              placeholder="新牌組名稱"
              placeholderTextColor={COLORS.textSecondary}
              value={newDeckName}
              onChangeText={setNewDeckName}
            />
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={() => { createDeck(newDeckName); setNewDeckName(''); }}
            >
              <Text style={styles.primaryBtnText}>建立</Text>
            </TouchableOpacity>
          </View>

          {decks.length > 0 && <Text style={styles.h2}>我的牌組</Text>}
          {decks.map((d) => (
            <TouchableOpacity key={d.id} style={styles.deckRow} onPress={() => setActiveDeck(d.id)}>
              <Text style={styles.deckName}>{d.name}</Text>
              <LegalBadge deck={d} />
            </TouchableOpacity>
          ))}
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
            accessibilityLabel={`${ZONE_LABELS[zone]} ${value}/${target}`}
            testID={`deck-zone-tab-${zone}`}
          >
            <Text style={[styles.tabLabel, active && styles.tabLabelActive]} numberOfLines={1}>
              {ZONE_LABELS[zone]}
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
      <Text style={styles.h2}>選擇卡片</Text>
      {!isDesktop && (
        <View style={styles.mobileFilterRow}>
          <TouchableOpacity
            style={styles.filterBtn}
            onPress={() => setFiltersOpen(true)}
            accessibilityRole="button"
            accessibilityLabel="開啟搜尋與篩選"
            testID="open-filters"
          >
            <Text style={styles.filterBtnText}>搜尋 / 篩選</Text>
          </TouchableOpacity>
          <Text style={styles.resultCount} testID="card-result-count-mobile">
            {results.length} 張卡片
          </Text>
        </View>
      )}
      <CardPickerGrid
        groups={results}
        numColumns={numColumns}
        height={isDesktop ? 620 : 460}
        qtyOf={(cardNumber) => qtyByCardNumber.get(cardNumber) ?? 0}
        onAdd={addToDeck}
        onAddOwned={(card) => adjustOwned(card.cardNumber, card.printing, 1)}
        emptyLabel="沒有符合條件的卡片，請調整搜尋或篩選條件。"
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
            placeholder="牌組名稱"
            placeholderTextColor={COLORS.textSecondary}
            value={renameValue}
            onChangeText={(t) => { setRenameValue(t); if (renameError) setRenameError(false); }}
            onSubmitEditing={commitRename}
            autoFocus
            testID="deck-rename-input"
            accessibilityLabel="牌組名稱"
          />
          <View style={styles.renameActions}>
            <TouchableOpacity
              style={styles.primaryBtn}
              onPress={commitRename}
              testID="deck-rename-save"
              accessibilityRole="button"
              accessibilityLabel="儲存牌組名稱"
            >
              <Text style={styles.primaryBtnText}>儲存</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={cancelRename}
              testID="deck-rename-cancel"
              accessibilityRole="button"
              accessibilityLabel="取消重新命名"
            >
              <Text style={styles.link}>取消</Text>
            </TouchableOpacity>
          </View>
          {renameError && (
            <Text style={styles.renameErrorText}>名稱不可為空白</Text>
          )}
        </View>
      ) : (
        <View style={styles.deckHeaderRow}>
          <Text style={[styles.h2, { flexShrink: 1 }]} numberOfLines={1}>{activeDeck.name}</Text>
          <View style={styles.deckHeaderActions}>
            <TouchableOpacity
              onPress={startRename}
              testID="deck-rename-button"
              accessibilityRole="button"
              accessibilityLabel="重新命名牌組"
            >
              <Text style={styles.link}>重新命名</Text>
            </TouchableOpacity>
            <TouchableOpacity onPress={() => setActiveDeck(null)}>
              <Text style={styles.link}>切換牌組</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {activeDeck.origin?.kind === 'tournament' && (
        <View style={styles.originBanner} testID="deck-origin-banner">
          <Text style={styles.originText}>
            ✓ 已從賽事牌組匯入：{activeDeck.origin.eventName}
            {activeDeck.origin.decklogCode ? `（${activeDeck.origin.decklogCode}）` : ''}
          </Text>
        </View>
      )}

      {stats && (
        <View style={styles.statsRow}>
          <Stat label={ZONE_LABELS.oshi} value={stats.oshi} target={stats.oshiTarget} />
          <Stat label={ZONE_LABELS.main} value={stats.main} target={stats.mainTarget} />
          <Stat label={ZONE_LABELS.yell} value={stats.yell} target={stats.yellTarget} />
          <Stat label="總計" value={stats.total} target={stats.totalTarget} emphasize />
        </View>
      )}

      <View style={styles.finalizeRow}>
        <TouchableOpacity
          style={styles.primaryBtn}
          onPress={finalizeDeck}
          testID="deck-finalize-button"
          accessibilityRole="button"
          accessibilityLabel="完成組牌並檢查規則"
        >
          <Text style={styles.primaryBtnText}>完成組牌</Text>
        </TouchableOpacity>
        {lowCostDrift > 0 && (
          <TouchableOpacity
            onPress={() => applyLowCostVariants(activeDeck.id, lowCostIndex)}
            testID="deck-apply-low-cost"
            accessibilityRole="button"
            accessibilityLabel={`套用低配版本，將改寫 ${lowCostDrift} 張卡片`}
          >
            <Text style={styles.link}>套用低配版本（{lowCostDrift}）</Text>
          </TouchableOpacity>
        )}
      </View>

      <View style={styles.zoneBlock}>
        <Text style={styles.zoneTitle}>{ZONE_LABELS[activeZone]}（已選）</Text>
        {selectedSlots.length === 0 && <Text style={styles.muted}>（尚無卡片）</Text>}
        {selectedSlots.map((slot) => (
          <View key={slot.card.id} style={styles.slotRow} testID={`deck-slot-${slot.card.cardNumber}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{slot.card.name}</Text>
              <Text style={styles.cardMeta}>
                {slot.card.cardNumber} · {printingLabelOf(slot.card)}
              </Text>
            </View>
            <View style={styles.qtyControls}>
              <TouchableOpacity
                style={styles.qtyBtn}
                onPress={() => changeCard(activeDeck.id, activeZone, slot.card, -1)}
                accessibilityRole="button"
                accessibilityLabel={`減少 ${slot.card.name}`}
                testID={`deck-slot-dec-${slot.card.cardNumber}`}
              >
                <Text style={styles.qtyBtnText}>－</Text>
              </TouchableOpacity>
              <Text style={styles.qtyValue}>{slot.qty}</Text>
              <TouchableOpacity
                style={styles.qtyBtn}
                onPress={() => changeCard(activeDeck.id, activeZone, slot.card, 1)}
                accessibilityRole="button"
                accessibilityLabel={`增加 ${slot.card.name}`}
                testID={`deck-slot-inc-${slot.card.cardNumber}`}
              >
                <Text style={styles.qtyBtnText}>＋</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={styles.removeBtn}
                onPress={() => removeCard(activeDeck.id, activeZone, slot.card.id)}
                accessibilityRole="button"
                accessibilityLabel={`移除 ${slot.card.name}`}
                testID={`deck-slot-remove-${slot.card.cardNumber}`}
              >
                <Text style={styles.link}>移除</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))}
      </View>
    </View>
  );

  const collectionPanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      <Text style={styles.h2}>收藏擁有數量</Text>
      <Text style={styles.muted}>
        全域收藏（跨所有牌組共用，僅存於此裝置）· 依精確卡號＋版本記錄擁有張數
      </Text>
      {collectionEntries.length === 0 ? (
        <Text style={styles.muted}>尚無收藏紀錄。</Text>
      ) : (
        collectionEntries.map((e) => (
          <View key={e.key} style={styles.slotRow} testID={`collection-row-${e.key}`}>
            <View style={{ flex: 1 }}>
              <Text style={styles.cardName}>{e.name}</Text>
              <Text style={styles.cardMeta}>
                {e.cardNumber}{e.versionLabel ? ` · ${e.versionLabel}` : ''}
              </Text>
            </View>
            <View style={styles.qtyControls}>
              <TouchableOpacity
                style={styles.qtyBtn}
                onPress={() => adjustOwned(e.cardNumber, e.version, -1)}
                accessibilityRole="button"
                accessibilityLabel={`收藏 -1 ${e.name}`}
                testID={`collection-dec-${e.key}`}
              >
                <Text style={styles.qtyBtnText}>－</Text>
              </TouchableOpacity>
              <Text style={styles.qtyValue}>{e.qty}</Text>
              <TouchableOpacity
                style={styles.qtyBtn}
                onPress={() => adjustOwned(e.cardNumber, e.version, 1)}
                accessibilityRole="button"
                accessibilityLabel={`收藏 +1 ${e.name}`}
                testID={`collection-inc-${e.key}`}
              >
                <Text style={styles.qtyBtnText}>＋</Text>
              </TouchableOpacity>
              <TouchableOpacity
                onPress={() => setOwned(e.cardNumber, e.version, 0)}
                accessibilityRole="button"
                accessibilityLabel={`移除收藏 ${e.name}`}
                testID={`collection-remove-${e.key}`}
              >
                <Text style={styles.link}>移除</Text>
              </TouchableOpacity>
            </View>
          </View>
        ))
      )}
    </View>
  );

  const estimatePanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      <Text style={styles.h2}>缺卡預估（參考售價）</Text>
      <Text style={styles.muted}>
        需求 / 擁有 / 缺少 · 單價採 yuyu-tei「參考售價」（玩家購入價），僅取同卡號＋同版本精確匹配
      </Text>
      {gap && gap.rows.map((r) => {
        const alert = priceAlerts[priceAlertKey(r.cardNumber, r.version)] ?? null;
        return (
          <View key={`${r.cardNumber}|${r.version}`} style={styles.gapBlock}>
            <View style={styles.gapRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{r.name}</Text>
                <Text style={styles.cardMeta}>
                  {r.cardNumber} · {r.versionLabel || r.version}
                </Text>
              </View>
              <View style={styles.gapNumbers}>
                <Text style={styles.gapNeed}>需 {r.required}</Text>
                <View style={styles.ownedControls}>
                  <TouchableOpacity style={styles.qtyBtnSm} onPress={() => setOwned(r.cardNumber, r.version, Math.max(0, r.owned - 1))}>
                    <Text style={styles.qtyBtnText}>－</Text>
                  </TouchableOpacity>
                  <Text style={styles.gapOwned}>有 {r.owned}</Text>
                  <TouchableOpacity style={styles.qtyBtnSm} onPress={() => setOwned(r.cardNumber, r.version, r.owned + 1)}>
                    <Text style={styles.qtyBtnText}>＋</Text>
                  </TouchableOpacity>
                </View>
                <Text style={[styles.gapMissing, r.missing > 0 && { color: COLORS.error }]}>缺 {r.missing}</Text>
                <Text style={styles.gapPrice}>
                  {r.missing === 0
                    ? '—'
                    : r.price.status === 'ok'
                      ? `${r.subtotal} ${r.price.currency}`
                      : '無精確版本價格'}
                </Text>
              </View>
            </View>
            {r.missing > 0 && (
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
                  accessibilityLabel={`設定 ${r.name} ${r.versionLabel || r.version} 的期望入手價格區間`}
                  testID={`price-alert-open-${r.cardNumber}|${r.version}`}
                >
                  <Text style={styles.alertLink}>
                    {alert ? `🔔 期望入手 ${formatInterval(alert)}・編輯` : '🔔 設定期望入手價格區間'}
                  </Text>
                </TouchableOpacity>
              ) : (
                <Text style={styles.alertDisabled} testID={`price-alert-unavailable-${r.cardNumber}|${r.version}`}>
                  無精確版本價格，無法設定到價提醒
                </Text>
              )
            )}
          </View>
        );
      })}
      {gap && (gap.rows.length === 0
        ? <Text style={styles.muted}>牌組為空，無缺卡。</Text>
        : (
          <View style={styles.totalCard}>
            {gap.subtotals.length === 0 ? (
              <Text style={styles.totalText}>缺卡預估總額（參考售價）：—（無精確版本價格）</Text>
            ) : (
              gap.subtotals.map((s) => (
                <View key={s.currency}>
                  <Text style={styles.totalText} testID={`gap-subtotal-${s.currency}`}>
                    缺卡預估小計（參考售價 · {s.currency}）：{s.total} {s.currency}
                  </Text>
                  <Text style={styles.muted}>
                    來源 yuyu-tei.jp 參考售價 · 幣別 {s.currency}
                    {s.dataAsOf ? ` · 資料截至 ${s.dataAsOf}` : ''}
                  </Text>
                </View>
              ))
            )}
            {gap.unpriced.length > 0 && (
              <Text style={[styles.muted, { color: COLORS.warning }]}>
                未計價項目（{gap.unpriced.length}）（無精確版本價格）：
                {gap.unpriced.map((u) => `${u.cardNumber}${u.version ? `·${u.version}` : ''}`).join('、')}
              </Text>
            )}
          </View>
        ))}
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
              <Text style={[styles.h2, { color: COLORS.success }]}>✓ 組牌完成</Text>
              <Text style={styles.muted}>此牌組符合所有規則，已可出賽。</Text>
            </>
          ) : (
            <>
              <Text style={styles.h2}>尚未完成，還有 {finalizeIssues?.length ?? 0} 項需要調整</Text>
              <ScrollView style={styles.modalList}>
                {finalizeIssues?.map((i, idx) => (
                  <View
                    key={`${i.code}-${idx}`}
                    style={[styles.issue, i.level === 'error' ? styles.issueError : styles.issueWarn]}
                  >
                    <Text style={styles.issueLevel}>{i.level === 'error' ? '🚫 錯誤' : '⚠️ 警告'}</Text>
                    <Text style={styles.issueMsg}>{i.message}</Text>
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
            accessibilityLabel="關閉並回到編輯"
          >
            <Text style={styles.primaryBtnText}>
              {finalizeIssues && finalizeIssues.length === 0 ? '完成' : '回到編輯'}
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
            <Text style={styles.h2}>搜尋 / 篩選</Text>
            <TouchableOpacity
              onPress={() => setFiltersOpen(false)}
              accessibilityRole="button"
              accessibilityLabel="關閉篩選"
              testID="close-filters"
              style={styles.sheetClose}
            >
              <Text style={styles.link}>完成</Text>
            </TouchableOpacity>
          </View>
          <ScrollView>{filterPanel}</ScrollView>
        </View>
      </View>
    </Modal>
  );

  return (
    <SafeAreaView style={styles.container}>
      {finalizeSheet}
      {filterSheet}
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      {zoneTabs}
      {isDesktop ? (
        <ScrollView contentContainerStyle={styles.desktopWrap}>
          <View style={styles.desktopCols}>
            <View style={[styles.panel, styles.panelCol]}>
              <Text style={styles.h2}>搜尋與篩選</Text>
              {filterPanel}
            </View>
            {pickerPanel}
            <View style={styles.desktopStackCol}>
              {deckPanel}
              {collectionPanel}
              {estimatePanel}
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.pad}>
          {pickerPanel}
          {deckPanel}
          {collectionPanel}
          {estimatePanel}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

// An incomplete deck is a 草稿, not a failure — error wording is reserved for a
// failed 完成組牌 attempt (DIC-1004 §B5).
function LegalBadge({ deck }: { deck: Deck }) {
  const legal = isDeckLegal(deck);
  return (
    <Text
      style={[styles.badgeText, { color: legal ? COLORS.success : COLORS.textSecondary }]}
      testID={`deck-badge-${deck.id}`}
    >
      {legal ? '可出賽' : '草稿'}
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
  tabBar: { flexDirection: 'row', gap: 6, paddingHorizontal: 12, paddingVertical: 8, backgroundColor: COLORS.surface, borderBottomWidth: 1, borderBottomColor: COLORS.border },
  tab: { flex: 1, minHeight: 48, borderRadius: 10, paddingHorizontal: 6, paddingVertical: 6, alignItems: 'center', justifyContent: 'center', backgroundColor: COLORS.surfaceLight, borderWidth: 1, borderColor: COLORS.border },
  tabActive: { borderColor: COLORS.primary, backgroundColor: COLORS.background },
  tabLabel: { color: COLORS.textSecondary, fontSize: 12, fontWeight: '600' },
  tabLabelActive: { color: COLORS.primary },
  tabProgress: { color: COLORS.text, fontSize: 14, fontWeight: 'bold', marginTop: 2 },
  mobileFilterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  filterBtn: { minHeight: 44, paddingHorizontal: 16, justifyContent: 'center', borderRadius: 8, borderWidth: 1, borderColor: COLORS.primary, backgroundColor: COLORS.surfaceLight },
  filterBtnText: { color: COLORS.primary, fontSize: 14, fontWeight: 'bold' },
  resultCount: { color: COLORS.text, fontSize: 13, fontWeight: 'bold' },
  deckRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', backgroundColor: COLORS.surfaceLight, borderRadius: 8, padding: 12, marginTop: 8 },
  deckName: { color: COLORS.text, fontSize: 15, fontWeight: '600' },
  deckHeaderRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8, gap: 8 },
  deckHeaderActions: { flexDirection: 'row', alignItems: 'center', gap: 14 },
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
  cardMeta: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  qtyControls: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  qtyBtn: { width: 44, height: 44, borderRadius: 6, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  qtyBtnSm: { width: 24, height: 24, borderRadius: 5, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
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
  ownedControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gapOwned: { color: COLORS.text, fontSize: 12, minWidth: 40, textAlign: 'center' },
  gapMissing: { color: COLORS.textSecondary, fontSize: 12 },
  gapPrice: { color: COLORS.primaryLight, fontSize: 12 },
  totalCard: { marginTop: 12, backgroundColor: COLORS.surfaceLight, borderRadius: 8, padding: 12 },
  totalText: { color: COLORS.text, fontSize: 15, fontWeight: 'bold' },
  finalizeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 460, backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  modalList: { maxHeight: 300 },
  modalBtn: { marginTop: 14, alignSelf: 'flex-end' },
  sheetBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '85%', backgroundColor: COLORS.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, padding: 16, borderTopWidth: 1, borderColor: COLORS.border },
  sheetHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  sheetClose: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 8 },
});
