import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, ScrollView, SafeAreaView } from 'react-native';
import { COLORS } from '../constants';
import { useBreakpoint } from '../hooks/useBreakpoint';

interface SearchScreenProps {
  navigation: any;
}

export default function SearchScreen({ navigation }: SearchScreenProps) {
  const [query, setQuery] = useState('');
  const { isDesktop } = useBreakpoint();

  const handleSearch = () => {
    if (!query.trim()) return;
    
    navigation.navigate('SearchResults', { query: query.trim() });
  };

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: COLORS.background }}>
      <ScrollView style={styles.container} contentContainerStyle={isDesktop ? styles.scrollContentDesktop : undefined}>
      <View style={isDesktop ? styles.innerDesktop : styles.inner}>
      {/* 搜尋欄 */}
      <View style={styles.searchBar}>
        <TextInput
          style={styles.input}
          placeholder="輸入卡號（hBP01-001）或成員名稱..."
          placeholderTextColor={COLORS.textSecondary}
          value={query}
          onChangeText={setQuery}
          onSubmitEditing={handleSearch}
          returnKeyType="search"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <TouchableOpacity style={styles.searchButton} onPress={handleSearch}>
          <Text style={styles.searchButtonText}>搜尋</Text>
        </TouchableOpacity>
      </View>

      {/* 說明 */}
      <View style={styles.hintBox}>
        <Text style={styles.hintTitle}>🔍 搜尋功能</Text>
        <Text style={styles.hintText}>輸入卡號（例：hBP01-001）或成員名稱即可搜尋</Text>
      </View>

      {/* 熱門搜尋建議 */}
      <View style={styles.suggestions}>
        <Text style={styles.suggestionTitle}>💡 熱門搜尋</Text>
        <View style={styles.suggestionTags}>
          <TouchableOpacity 
            style={styles.suggestionTag}
            onPress={() => {
              setQuery('hBP01');
              navigation.navigate('SearchResults', { query: 'hBP01' });
            }}
          >
            <Text style={styles.suggestionTagText}>hBP01</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.suggestionTag}
            onPress={() => {
              setQuery('星街すいせい');
              navigation.navigate('SearchResults', { query: '星街すいせい' });
            }}
          >
            <Text style={styles.suggestionTagText}>星街すいせい</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.suggestionTag}
            onPress={() => {
              setQuery('hSD01');
              navigation.navigate('SearchResults', { query: 'hSD01' });
            }}
          >
            <Text style={styles.suggestionTagText}>hSD01</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.suggestionTag}
            onPress={() => {
              setQuery('湊あくあ');
              navigation.navigate('SearchResults', { query: '湊あくあ' });
            }}
          >
            <Text style={styles.suggestionTagText}>湊あくあ</Text>
          </TouchableOpacity>
        </View>
      </View>
      </View>
    </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
    padding: 16,
  },
  scrollContentDesktop: { alignItems: 'center' },
  inner: { width: '100%' },
  innerDesktop: { width: '100%', maxWidth: 720 },
  searchBar: {
    flexDirection: 'row',
    marginBottom: 16,
    gap: 8,
  },
  input: {
    flex: 1,
    backgroundColor: COLORS.surface,
    borderRadius: 8,
    padding: 12,
    color: COLORS.text,
    fontSize: 16,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  searchButton: {
    backgroundColor: COLORS.primary,
    borderRadius: 8,
    padding: 12,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 80,
  },
  searchButtonText: {
    color: COLORS.text,
    fontWeight: 'bold',
    fontSize: 16,
  },
  hintBox: {
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
    marginBottom: 16,
    borderLeftWidth: 4,
    borderLeftColor: COLORS.primary,
  },
  hintTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 8,
  },
  hintText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 4,
  },
  suggestions: {
    backgroundColor: COLORS.surface,
    padding: 16,
    borderRadius: 12,
  },
  suggestionTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  suggestionTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 8,
  },
  suggestionTag: {
    backgroundColor: COLORS.surfaceLight,
    paddingVertical: 8,
    paddingHorizontal: 16,
    borderRadius: 20,
  },
  suggestionTagText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
  },
});
