import React, { useState } from 'react';
import { View, TextInput, TouchableOpacity, Text, StyleSheet, ScrollView, Platform } from 'react-native';
import { useBreakpoint } from '../hooks/useBreakpoint';
import { useTranslation } from '../i18n';
import { RouteShell } from '../components/shell';
import { PALETTE, SEMANTIC, FONTS, RADII, SPACING, LAYOUT } from '../theme/tokensV2';

interface SearchScreenProps {
  navigation: any;
}

/**
 * SearchScreen — DIC-1409 CR fix: the Search drawer route (the 搜尋 tab's
 * landing surface) moves onto the shared Pen v2 shell/tokens. The Pen
 * artifact anchors the search idiom on App/01 首頁 (`BxPhh` $app-elev r14
 * field) and App/02 搜尋結果 (chip row); this surface reuses those idioms
 * so the tab no longer lands on legacy COLORS chrome. All real wiring is
 * preserved: query state, submit → SearchResults(query), and the four
 * suggestion taps.
 */
export default function SearchScreen({ navigation }: SearchScreenProps) {
  const [query, setQuery] = useState('');
  const { isDesktop } = useBreakpoint();
  const { t } = useTranslation();

  const handleSearch = () => {
    if (!query.trim()) return;

    navigation.navigate('SearchResults', { query: query.trim() });
  };

  const suggest = (value: string) => {
    setQuery(value);
    navigation.navigate('SearchResults', { query: value });
  };

  return (
    <RouteShell navigation={navigation} routeName="Search" title={t('nav_search')} testID="search-shell">
      <ScrollView style={styles.container} contentContainerStyle={isDesktop ? styles.scrollContentDesktop : undefined}>
        <View style={isDesktop ? styles.innerDesktop : styles.inner}>
          {/* 搜尋欄 — Pen `BxPhh` idiom: $app-elev r14 field + accent action */}
          <View style={styles.searchBar}>
            <View style={styles.inputWrap} testID="search-input-wrap">
              <Text style={styles.inputGlyph}>⌕</Text>
              <TextInput
                style={styles.input}
                placeholder={t('search_landing_placeholder')}
                placeholderTextColor={SEMANTIC.onBgDim}
                value={query}
                onChangeText={setQuery}
                onSubmitEditing={handleSearch}
                returnKeyType="search"
                autoCapitalize="none"
                autoCorrect={false}
                testID="search-input"
              />
            </View>
            <TouchableOpacity
              style={styles.searchButton}
              onPress={handleSearch}
              accessibilityRole="button"
              testID="search-submit"
            >
              <Text style={styles.searchButtonText}>{t('common_search')}</Text>
            </TouchableOpacity>
          </View>

          {/* 說明 */}
          <View style={styles.hintBox} testID="search-hint">
            <Text style={styles.hintTitle}>{t('search_feature_title')}</Text>
            <Text style={styles.hintText}>{t('search_feature_hint')}</Text>
          </View>

          {/* 熱門搜尋建議 */}
          <View style={styles.suggestions} testID="search-suggestions">
            <Text style={styles.suggestionTitle}>{t('search_popular_title')}</Text>
            <View style={styles.suggestionTags}>
              {['hBP01', '星街すいせい', 'hSD01', '湊あくあ'].map((tag) => (
                <TouchableOpacity
                  key={tag}
                  style={styles.suggestionTag}
                  onPress={() => suggest(tag)}
                  accessibilityRole="button"
                  testID={`search-suggestion-${tag}`}
                >
                  <Text style={styles.suggestionTagText}>{tag}</Text>
                </TouchableOpacity>
              ))}
            </View>
          </View>
        </View>
      </ScrollView>
    </RouteShell>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: PALETTE.appBg,
    padding: LAYOUT.safeMobile,
  },
  scrollContentDesktop: { alignItems: 'center' },
  inner: { width: '100%' },
  innerDesktop: { width: '100%', maxWidth: 720 },
  searchBar: {
    flexDirection: 'row',
    marginBottom: SPACING.xl,
    gap: SPACING.md,
  },
  inputWrap: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.md,
    backgroundColor: PALETTE.appElev,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: PALETTE.border,
    paddingHorizontal: SPACING.lg,
    minHeight: 46,
  },
  inputGlyph: {
    color: SEMANTIC.onBgDim,
    fontSize: 16,
    fontWeight: '700',
  },
  input: {
    flex: 1,
    color: SEMANTIC.onBg,
    fontSize: 15,
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
    paddingVertical: 10,
  },
  searchButton: {
    backgroundColor: PALETTE.accent,
    borderRadius: 14,
    paddingHorizontal: SPACING.xl,
    justifyContent: 'center',
    alignItems: 'center',
    minWidth: 72,
    minHeight: LAYOUT.minTouch,
  },
  searchButtonText: {
    color: SEMANTIC.onBrand,
    fontWeight: '700',
    fontSize: 15,
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
  hintBox: {
    backgroundColor: PALETTE.appSurface,
    padding: SPACING.xl,
    borderRadius: RADII.lg,
    marginBottom: SPACING.xl,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: SPACING.sm,
  },
  hintTitle: {
    color: SEMANTIC.onBg,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
  hintText: {
    color: SEMANTIC.onBgMuted,
    fontSize: 13,
    lineHeight: 20,
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
  suggestions: {
    backgroundColor: PALETTE.appSurface,
    padding: SPACING.xl,
    borderRadius: RADII.lg,
    borderWidth: 1,
    borderColor: PALETTE.border,
    gap: SPACING.lg,
  },
  suggestionTitle: {
    color: SEMANTIC.onBg,
    fontSize: 16,
    fontWeight: '700',
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
  suggestionTags: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.md,
  },
  suggestionTag: {
    backgroundColor: PALETTE.appElev,
    borderWidth: 1,
    borderColor: PALETTE.border,
    paddingVertical: SPACING.md,
    paddingHorizontal: SPACING.xl,
    borderRadius: RADII.pill,
    minHeight: 36,
    justifyContent: 'center',
  },
  suggestionTagText: {
    color: PALETTE.accent2,
    fontSize: 14,
    fontWeight: '600',
    fontFamily: Platform.OS === 'web' ? FONTS.body : undefined,
  },
});
