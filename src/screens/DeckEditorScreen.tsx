import React, { useEffect, useMemo, useState } from 'react';
import {
  View, Text, StyleSheet, TextInput, TouchableOpacity, ScrollView,
  SafeAreaView, ActivityIndicator, FlatList,
} from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useDeckStore } from '../store/deckStore';
import {
  validateDeck, deckStats, computeGap, eligibleZone, isDeckLegal, ownershipKey,
  type DeckCard, type DeckZone, type Deck,
} from '../utils/deckRules';
import { loadCardDatabase, searchCards, type CardDatabase } from '../utils/deckCardData';

const ZONE_LABELS: Record<DeckZone, string> = {
  oshi: '推しホロメン',
  main: '主牌組',
  yell: 'エール',
};

export default function DeckEditorScreen() {
  const { isDesktop } = useBreakpoint();
  const [db, setDb] = useState<CardDatabase | null>(null);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [newDeckName, setNewDeckName] = useState('');
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState(false);

  const decks = useDeckStore((s) => s.decks);
  const activeDeckId = useDeckStore((s) => s.activeDeckId);
  const collection = useDeckStore((s) => s.collection);
  const createDeck = useDeckStore((s) => s.createDeck);
  const renameDeck = useDeckStore((s) => s.renameDeck);
  const setActiveDeck = useDeckStore((s) => s.setActiveDeck);
  const changeCard = useDeckStore((s) => s.changeCard);
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
  }, [activeDeckId]);

  const results = useMemo(
    () => (db ? searchCards(db.cards, query) : []),
    [db, query],
  );

  // Resolve a collection entry (keyed by normalized ownershipKey) back to a
  // displayable card. Built from the loaded database so the global inventory can
  // show real names/versions for owned entries independent of any deck.
  const cardByOwnershipKey = useMemo(() => {
    const map = new Map<string, DeckCard>();
    if (db) for (const c of db.cards) map.set(ownershipKey(c.cardNumber, c.rarity), c);
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
        return { key, cardNumber, version, qty, name: card?.name || cardNumber };
      })
      .sort((a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.version.localeCompare(b.version));
  }, [collection, cardByOwnershipKey]);

  const stats = activeDeck ? deckStats(activeDeck) : null;
  const issues = activeDeck ? validateDeck(activeDeck) : [];
  const errors = issues.filter((i) => i.level === 'error');
  const warnings = issues.filter((i) => i.level === 'warning');
  const gap = activeDeck && db ? computeGap(activeDeck, collection, db.priceRecords) : null;

  function addToDeck(card: DeckCard) {
    if (!activeDeck) return;
    const zone = eligibleZone(card);
    if (!zone) return;
    changeCard(activeDeck.id, zone, card, 1);
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
      <FlatList
        data={results}
        keyExtractor={(c) => c.id}
        style={styles.resultList}
        keyboardShouldPersistTaps="handled"
        renderItem={({ item }) => {
          const zone = eligibleZone(item);
          return (
            <View style={styles.resultRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{item.name}</Text>
                <Text style={styles.cardMeta}>
                  {item.cardNumber}{item.rarity ? ` · ${item.rarity}` : ''}
                  {zone ? ` · ${ZONE_LABELS[zone]}` : ' · 無法分類'}
                </Text>
              </View>
              <TouchableOpacity
                style={styles.ownBtn}
                onPress={() => adjustOwned(item.cardNumber, item.rarity, 1)}
                accessibilityRole="button"
                accessibilityLabel={`收藏 +1 ${item.name}`}
                testID={`collection-add-${item.id}`}
              >
                <Text style={styles.ownBtnText}>＋擁有</Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.addBtn, !zone && styles.addBtnDisabled]}
                disabled={!zone}
                onPress={() => addToDeck(item)}
                accessibilityRole="button"
                accessibilityLabel={zone ? `加入牌組 ${item.name}` : '無法分類'}
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

      {stats && (
        <View style={styles.statsRow}>
          <Stat label={ZONE_LABELS.oshi} value={stats.oshi} target={stats.oshiTarget} />
          <Stat label={ZONE_LABELS.main} value={stats.main} target={stats.mainTarget} />
          <Stat label={ZONE_LABELS.yell} value={stats.yell} target={stats.yellTarget} />
          <Stat label="總計" value={stats.total} target={stats.totalTarget} emphasize />
        </View>
      )}

      {(['oshi', 'main', 'yell'] as DeckZone[]).map((zone) => (
        <View key={zone} style={styles.zoneBlock}>
          <Text style={styles.zoneTitle}>{ZONE_LABELS[zone]}</Text>
          {activeDeck[zone].length === 0 && <Text style={styles.muted}>（尚無卡片）</Text>}
          {activeDeck[zone].map((slot) => (
            <View key={slot.card.id} style={styles.slotRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.cardName}>{slot.card.name}</Text>
                <Text style={styles.cardMeta}>
                  {slot.card.cardNumber}{slot.card.rarity ? ` · ${slot.card.rarity}` : ''}
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
                {e.cardNumber}{e.version ? ` · ${e.version}` : ''}
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

  const validationPanel = (
    <View style={[styles.panel, isDesktop && styles.panelCol]}>
      <Text style={styles.h2}>規則校驗</Text>
      {errors.length === 0 && warnings.length === 0 && (
        <Text style={[styles.badgeText, { color: COLORS.success }]}>✓ 目前無違規（合法牌組）</Text>
      )}
      {errors.map((i, idx) => (
        <View key={`e${idx}`} style={[styles.issue, styles.issueError]}>
          <Text style={styles.issueLevel}>🚫 錯誤</Text>
          <Text style={styles.issueMsg}>{i.message}</Text>
        </View>
      ))}
      {warnings.map((i, idx) => (
        <View key={`w${idx}`} style={[styles.issue, styles.issueWarn]}>
          <Text style={styles.issueLevel}>⚠️ 警告</Text>
          <Text style={styles.issueMsg}>{i.message}</Text>
        </View>
      ))}

      <Text style={[styles.h2, { marginTop: 16 }]}>缺卡估價</Text>
      <Text style={styles.muted}>需求 / 擁有 / 缺少 · 價格僅取同卡號＋同版本精確匹配</Text>
      {gap && gap.rows.map((r) => (
        <View key={`${r.cardNumber}|${r.version}`} style={styles.gapRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.cardName}>{r.name}</Text>
            <Text style={styles.cardMeta}>
              {r.cardNumber}{r.version ? ` · ${r.version}` : ''}
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
      ))}
      {gap && (gap.rows.length === 0
        ? <Text style={styles.muted}>牌組為空，無缺卡。</Text>
        : (
          <View style={styles.totalCard}>
            {gap.subtotals.length === 0 ? (
              <Text style={styles.totalText}>缺卡估算總額：—（無精確版本價格）</Text>
            ) : (
              gap.subtotals.map((s) => (
                <View key={s.currency}>
                  <Text style={styles.totalText}>
                    缺卡估算小計（{s.currency}）：{s.total} {s.currency}
                  </Text>
                  <Text style={styles.muted}>
                    來源 yuyu-tei.jp · 幣別 {s.currency}
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
            <Text style={styles.muted}>不採用最高價／跨版本／同名價替代；不同幣別分開計算，不合併加總。</Text>
          </View>
        ))}
    </View>
  );

  return (
    <SafeAreaView style={styles.container}>
      {isDesktop ? (
        <ScrollView horizontal={false} contentContainerStyle={styles.desktopWrap}>
          <View style={styles.desktopCols}>
            {searchPanel}
            {zonesPanel}
            <View style={styles.desktopStackCol}>
              {collectionPanel}
              {validationPanel}
            </View>
          </View>
        </ScrollView>
      ) : (
        <ScrollView contentContainerStyle={styles.pad}>
          {zonesPanel}
          {searchPanel}
          {collectionPanel}
          {validationPanel}
        </ScrollView>
      )}
    </SafeAreaView>
  );
}

function LegalBadge({ deck }: { deck: Deck }) {
  const legal = isDeckLegal(deck);
  return (
    <Text style={[styles.badgeText, { color: legal ? COLORS.success : COLORS.error }]}>
      {legal ? '合法' : '有錯誤'}
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
  gapRow: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: COLORS.border },
  gapNumbers: { alignItems: 'flex-end', gap: 3 },
  gapNeed: { color: COLORS.textSecondary, fontSize: 12 },
  ownedControls: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  gapOwned: { color: COLORS.text, fontSize: 12, minWidth: 40, textAlign: 'center' },
  gapMissing: { color: COLORS.textSecondary, fontSize: 12 },
  gapPrice: { color: COLORS.primaryLight, fontSize: 12 },
  totalCard: { marginTop: 12, backgroundColor: COLORS.surfaceLight, borderRadius: 8, padding: 12 },
  totalText: { color: COLORS.text, fontSize: 15, fontWeight: 'bold' },
});
