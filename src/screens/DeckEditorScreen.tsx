import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, FlatList, Modal,
} from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useDeckStore } from '../store/deckStore';
import {
  validateDeck, deckStats, computeGap, eligibleZone, isDeckLegal, ownershipKey,
  type DeckCard, type DeckZone, type Deck, type ValidationIssue,
} from '../utils/deckRules';
import {
  groupVariantsByCardNumber, searchVariantGroups, buildLowCostIndex, countLowCostDrift,
} from '../utils/deckVariants';
import { loadCardDatabase, type CardDatabase } from '../utils/deckCardData';
import PriceAlertEditor, { type PriceAlertTarget } from '../components/PriceAlertEditor';
import { usePriceAlertStore } from '../stores/priceAlertStore';
import { formatInterval, priceAlertKey } from '../utils/priceAlerts';

const ZONE_LABELS: Record<DeckZone, string> = {
  oshi: '推しホロメン',
  main: '主牌組',
  yell: 'エール',
};

// 版本一律顯示來源掛牌原文（如「ラプラス・ダークネス(パラレル)」）；沒有原文時退回版本代碼。
// 絕不顯示資料庫的卡號層級 rarity —— hBP04-005 兩列都標 SEC，拿來標示 ¥980 的原印版會誤導。
// 只顯示選定版本本身，不附任何來源／預設值的說明文字（DIC-1064）；
// 同卡號完全沒有普通版本可用時才維持「版本未確認」，不冒用平行／簽名版的價格。
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
  const { isDesktop } = useBreakpoint();
  const [db, setDb] = useState<CardDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [newDeckName, setNewDeckName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(false);
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

  // MVP search shows ONE row per card number: its low-cost default printing,
  // not every premium reprint (DIC-1004 §A2).
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

  const results = useMemo(
    () => searchVariantGroups(variantGroups, query),
    [variantGroups, query],
  );
  const lowCostDrift = activeDeck ? countLowCostDrift(activeDeck, lowCostIndex) : 0;

  // Resolve a collection entry (keyed by normalized ownershipKey) back to a
  // displayable card. Built from the loaded database so the global inventory can
  // show real names/versions for owned entries independent of any deck.
  const cardByOwnershipKey = useMemo(() => {
    const map = new Map<string, DeckCard>();
    if (db) for (const c of db.cards) map.set(ownershipKey(c.cardNumber, c.printing), c);
    return map;
  }, [db]);

  // The global collection inventory, newest-heavier entries first is not needed;
  // sort by cardNumber for a stable, deterministic order.
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
  const searchPanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      <Text style={styles.h2}>搜尋卡片</Text>
      <TextInput
        style={styles.input}
        placeholder="卡號 / 名稱 / 系列"
        placeholderTextColor={COLORS.textSecondary}
        value={query}
        onChangeText={setQuery}
      />
      <Text style={styles.muted}>每個卡號只顯示一列，預設採用可出賽、參考售價最低的原印版本。</Text>
      <FlatList
        data={results}
        keyExtractor={(g) => g.cardNumber}
        style={styles.resultList}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item: group }) => {
          const card = group.card;
          const zone = eligibleZone(card);
          return (
            <View style={styles.resultRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{card.name}</Text>
                <Text style={styles.cardMeta}>
                  {card.cardNumber} · {printingLabelOf(card)}
                  {zone ? ` · ${ZONE_LABELS[zone]}` : ' · 無法分類'}
                </Text>
                {group.variants.length > 1 && (
                  <Text style={styles.lowCostTag} testID={`low-cost-tag-${group.cardNumber}`}>
                    預設低配版本（共 {group.variants.length} 種版本）
                  </Text>
                )}
              </View>
              <TouchableOpacity
                style={styles.ownBtn}
                onPress={() => adjustOwned(card.cardNumber, card.printing, 1)}
                accessibilityRole="button"
                accessibilityLabel={`收藏 +1 ${card.name}`}
                testID={`collection-add-${card.id}`}
              >
                <Text style={styles.ownBtnText}>＋擁有</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, !zone && styles.addBtnDisabled]}
                disabled={!zone}
                onPress={() => addToDeck(card)}
                accessibilityRole="button"
                accessibilityLabel={zone ? `加入牌組 ${card.name}` : '無法分類'}
              >
                <Text style={styles.addBtnText}>＋</Text>
              </TouchableOpacity>
            </View>
          );
        }}
        ListEmptyComponent={
          <Text style={styles.muted}>{query ? '找不到符合的卡片' : '輸入關鍵字搜尋卡片'}</Text>
        }
      />
    </View>
  );

  const zonesPanel = (
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

      {(['oshi', 'main', 'yell'] as DeckZone[]).map((zone) => (
        <View key={zone} style={styles.zoneBlock}>
          <Text style={styles.zoneTitle}>{ZONE_LABELS[zone]}</Text>
          {activeDeck[zone].length === 0 && <Text style={styles.muted}>（尚無卡片）</Text>}
          {activeDeck[zone].map((slot) => (
            <View key={slot.card.id} style={styles.slotRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{slot.card.name}</Text>
                <Text style={styles.cardMeta}>
                  {slot.card.cardNumber} · {printingLabelOf(slot.card)}
                </Text>
              </View>
              <View style={styles.qtyControls}>
                <TouchableOpacity style={styles.qtyBtn} onPress={() => changeCard(activeDeck.id, zone, slot.card, -1)}>
                  <Text style={styles.qtyBtnText}>－</Text>
                </TouchableOpacity>
                <Text style={styles.qtyValue}>{slot.qty}</Text>
                <TouchableOpacity style={styles.qtyBtn} onPress={() => changeCard(activeDeck.id, zone, slot.card, 1)}>
                  <Text style={styles.qtyBtnText}>＋</Text>
                </TouchableOpacity>
              </View>
            </View>
          ))}
        </View>
      ))}
    </View>
  );

  const collectionPanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      <Text style={styles.h2}>收藏擁有數量</Text>
      <Text style={styles.muted}>
        全域收藏（跨所有牌組共用，僅存於此裝置）· 依精確卡號＋版本記錄擁有張數
      </Text>
      {collectionEntries.length === 0 ? (
        <Text style={styles.muted}>尚無收藏紀錄。可從左側搜尋結果的「＋擁有」加入。</Text>
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

  return (
    <SafeAreaView style={styles.container}>
      {finalizeSheet}
      <PriceAlertEditor target={alertTarget} onClose={() => setAlertTarget(null)} />
      {isDesktop ? (
        <ScrollView horizontal={false} contentContainerStyle={styles.desktopWrap}>
          <View style={styles.desktopCols}>
            {searchPanel}
            {zonesPanel}
            <View style={styles.desktopStackCol}>
              {collectionPanel}
              {estimatePanel}
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.pad}>
          {zonesPanel}
          {searchPanel}
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
  h1: { fontSize: 22, fontWeight: 'bold', color: COLORS.primary, marginBottom: 6 },
  h2: { fontSize: 17, fontWeight: 'bold', color: COLORS.text, marginBottom: 8 },
  muted: { color: COLORS.textSecondary, fontSize: 13, marginTop: 4 },
  link: { color: COLORS.primary, fontSize: 14 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 12 },
  input: { backgroundColor: COLORS.surfaceLight, color: COLORS.text, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: COLORS.border },
  primaryBtn: { backgroundColor: COLORS.primary, borderRadius: 8, paddingHorizontal: 16, paddingVertical: 10 },
  primaryBtnText: { color: '#fff', fontWeight: 'bold' },
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
  qtyBtn: { width: 30, height: 30, borderRadius: 6, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  qtyBtnSm: { width: 24, height: 24, borderRadius: 5, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  qtyBtnText: { color: COLORS.text, fontSize: 16, fontWeight: 'bold' },
  qtyValue: { color: COLORS.text, fontSize: 15, fontWeight: 'bold', minWidth: 20, textAlign: 'center' },
  resultList: { maxHeight: 380, marginTop: 8 },
  resultRow: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  desktopStackCol: { flex: 1, gap: 16 },
  ownBtn: { height: 34, paddingHorizontal: 10, borderRadius: 8, backgroundColor: COLORS.surfaceLight, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: COLORS.border },
  ownBtnText: { color: COLORS.text, fontSize: 13, fontWeight: 'bold' },
  addBtn: { width: 34, height: 34, borderRadius: 8, backgroundColor: COLORS.primary, alignItems: 'center', justifyContent: 'center' },
  addBtnDisabled: { backgroundColor: COLORS.border },
  addBtnText: { color: '#fff', fontSize: 18, fontWeight: 'bold' },
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
  lowCostTag: { color: COLORS.primaryLight, fontSize: 11, marginTop: 2 },
  finalizeRow: { flexDirection: 'row', alignItems: 'center', gap: 14, marginBottom: 4 },
  modalBackdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.6)', alignItems: 'center', justifyContent: 'center', padding: 20 },
  modalCard: { width: '100%', maxWidth: 460, backgroundColor: COLORS.surface, borderRadius: 12, padding: 16, borderWidth: 1, borderColor: COLORS.border },
  modalList: { maxHeight: 300 },
  modalBtn: { marginTop: 14, alignSelf: 'flex-end' },
});
