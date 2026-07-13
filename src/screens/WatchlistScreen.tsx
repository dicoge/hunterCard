import React from 'react';
import { View, Text, FlatList, Image, StyleSheet, TouchableOpacity, Alert } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { useWatchlistStore, WatchlistItem } from '../stores/watchlistStore';
import { useSettingsStore } from '../store/settingsStore';

const rarityColors: Record<string, string> = {
  N: '#6b7280', C: '#6b7280', U: '#10b981', R: '#3b82f6', SR: '#8b5cf6',
};

export default function WatchlistScreen({ navigation }: any) {
  const { items, removeCard } = useWatchlistStore();
  const { preferredLanguage } = useSettingsStore();

  const confirmRemove = (item: WatchlistItem) => {
    const label = (preferredLanguage === 'zh' && item.nameZh) ? item.nameZh : item.name;
    Alert.alert(
      '移除入手提醒',
      `確定要從入手提醒移除「${label}」嗎？`,
      [
        { text: '取消', style: 'cancel' },
        { text: '移除', style: 'destructive', onPress: () => removeCard(item.cardNumber) },
      ]
    );
  };

  const openDetail = (item: WatchlistItem) => {
    navigation.navigate('CardDetail', {
      card: {
        cardNumber: item.cardNumber,
        name: item.name,
        nameZh: item.nameZh,
        rarity: item.rarity,
        imageUrl: item.imageUrl,
      },
    });
  };

  if (items.length === 0) {
    return (
      <SafeAreaView style={styles.emptyContainer} edges={['bottom']}>
        <Text style={styles.emptyIcon}>🔔</Text>
        <Text style={styles.emptyTitle}>還沒有入手提醒</Text>
        <Text style={styles.emptyHint}>
          透過「搜尋」或「掃描」找到想入手的卡牌，{'\n'}
          在卡牌詳情頁點「加入入手提醒」即可追蹤。
        </Text>
        <View style={styles.emptyActions}>
          <TouchableOpacity style={styles.emptyBtn} onPress={() => navigation.navigate('MainDrawer', { screen: 'Search' })}>
            <Text style={styles.emptyBtnText}>🔍 前往搜尋</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.emptyBtn, styles.emptyBtnAlt]} onPress={() => navigation.navigate('MainDrawer', { screen: 'Scan' })}>
            <Text style={styles.emptyBtnText}>📷 掃描卡牌</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const renderItem = ({ item }: { item: WatchlistItem }) => {
    const label = (preferredLanguage === 'zh' && item.nameZh) ? item.nameZh : item.name;
    const subLabel = (preferredLanguage === 'zh' && item.nameZh) ? item.name : item.nameZh;
    const rarityColor = rarityColors[item.rarity] || '#6b7280';
    return (
      <TouchableOpacity style={styles.row} activeOpacity={0.8} onPress={() => openDetail(item)}>
        {item.imageUrl ? (
          <Image source={{ uri: item.imageUrl }} style={styles.thumb} resizeMode="contain" />
        ) : (
          <View style={[styles.thumb, styles.thumbFallback]}>
            <Text style={styles.thumbFallbackText}>{item.cardNumber}</Text>
          </View>
        )}
        <View style={styles.info}>
          <Text style={styles.name} numberOfLines={1}>{label}</Text>
          {subLabel ? <Text style={styles.subName} numberOfLines={1}>{subLabel}</Text> : null}
          <View style={styles.metaRow}>
            <View style={[styles.rarityBadge, { backgroundColor: rarityColor }]}>
              <Text style={styles.rarityText}>{item.rarity || '?'}</Text>
            </View>
            <Text style={styles.cardNumber}>{item.cardNumber}</Text>
          </View>
          {item.targetPrice != null ? (
            <Text style={styles.targetPrice}>🎯 目標價 ¥{item.targetPrice.toLocaleString()}</Text>
          ) : null}
        </View>
        <TouchableOpacity style={styles.removeBtn} onPress={() => confirmRemove(item)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.removeBtnText}>✕</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  };

  return (
    <SafeAreaView style={styles.container} edges={['bottom']}>
      <FlatList
        data={items}
        keyExtractor={(item) => item.cardNumber}
        renderItem={renderItem}
        contentContainerStyle={styles.list}
        ListHeaderComponent={
          <Text style={styles.header}>共 {items.length} 張追蹤中的卡牌</Text>
        }
      />
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLORS.background },
  list: { padding: 16 },
  header: { color: COLORS.textSecondary, fontSize: 13, marginBottom: 12 },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surface,
    borderRadius: 12,
    padding: 12,
    marginBottom: 10,
    borderWidth: 1,
    borderColor: COLORS.border + '55',
  },
  thumb: { width: 52, height: 73, borderRadius: 6, backgroundColor: COLORS.surfaceLight },
  thumbFallback: { alignItems: 'center', justifyContent: 'center', padding: 4 },
  thumbFallbackText: { color: COLORS.textSecondary, fontSize: 10, textAlign: 'center' },

  info: { flex: 1, marginLeft: 12 },
  name: { color: COLORS.text, fontSize: 16, fontWeight: '700' },
  subName: { color: COLORS.textSecondary, fontSize: 12, marginTop: 2 },
  metaRow: { flexDirection: 'row', alignItems: 'center', marginTop: 6 },
  rarityBadge: { paddingHorizontal: 8, paddingVertical: 2, borderRadius: 5, marginRight: 8 },
  rarityText: { color: '#fff', fontSize: 11, fontWeight: '800' },
  cardNumber: { color: COLORS.textSecondary, fontSize: 12 },
  targetPrice: { color: COLORS.success, fontSize: 12, marginTop: 4, fontWeight: '600' },

  removeBtn: {
    marginLeft: 8,
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: COLORS.surfaceLight,
    alignItems: 'center',
    justifyContent: 'center',
  },
  removeBtnText: { color: COLORS.textSecondary, fontSize: 15, fontWeight: '700' },

  emptyContainer: { flex: 1, backgroundColor: COLORS.background, justifyContent: 'center', alignItems: 'center', padding: 32 },
  emptyIcon: { fontSize: 56, marginBottom: 16 },
  emptyTitle: { color: COLORS.text, fontSize: 20, fontWeight: 'bold', marginBottom: 10 },
  emptyHint: { color: COLORS.textSecondary, fontSize: 14, lineHeight: 22, textAlign: 'center', marginBottom: 24 },
  emptyActions: { flexDirection: 'row', gap: 12 },
  emptyBtn: { backgroundColor: COLORS.primary, paddingVertical: 12, paddingHorizontal: 20, borderRadius: 10 },
  emptyBtnAlt: { backgroundColor: COLORS.secondary },
  emptyBtnText: { color: '#fff', fontSize: 14, fontWeight: '700' },
});
