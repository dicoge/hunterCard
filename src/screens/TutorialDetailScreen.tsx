import React from 'react';
import { View, Text, StyleSheet, ScrollView, TouchableOpacity, Linking, useWindowDimensions } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { COLORS } from '../constants';
import { getTutorialData } from '../data/tutorialData';
import { useTranslation } from '../i18n';
import TutorialCard from '../components/tutorial/TutorialCard';
import TutorialPhaseCard from '../components/tutorial/TutorialPhaseCard';
import TutorialImageView from '../components/tutorial/TutorialImageView';

const MOBILE_BREAKPOINT = 480;

interface TutorialDetailScreenProps {
  route: { params: { sectionId: string } };
  navigation: any;
}

export default function TutorialDetailScreen({ route, navigation }: TutorialDetailScreenProps) {
  const { t, language } = useTranslation();
  const section = getTutorialData(language).find((item) => item.id === route.params.sectionId)
    ?? getTutorialData(language)[0];
  const { width: screenWidth } = useWindowDimensions();
  const isMobile = screenWidth < MOBILE_BREAKPOINT;

  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView 
        style={styles.container}
        contentContainerStyle={[styles.contentContainer, isMobile && styles.contentContainerMobile]}
        showsVerticalScrollIndicator={false}
      >
        {/* Header */}
        <View style={[styles.header, isMobile && styles.headerMobile]}>
          <Text style={[styles.headerIcon, isMobile && styles.headerIconMobile]}>{section.icon}</Text>
          <Text style={[styles.headerTitle, isMobile && styles.headerTitleMobile]}>{section.title}</Text>
        </View>

        {/* Description */}
        {section.description && (
          <TutorialCard>
            <Text style={[styles.description, isMobile && styles.descriptionMobile]}>
              {section.description}
            </Text>
          </TutorialCard>
        )}

        {/* Main images */}
        {section.images && section.images.length > 0 && (
          <TutorialCard>
            {section.images.map((img, index) => (
              <TutorialImageView 
                key={`img-${index}`} 
                uri={img.url} 
                alt={img.alt}
                screenWidth={screenWidth}
              />
            ))}
          </TutorialCard>
        )}

        {/* Content items (for lists like field regions) */}
        {section.items && section.items.length > 0 && (
          <TutorialCard>
            {section.items.map((item, index) => (
              <View key={`item-${index}`} style={styles.itemRow}>
                <Text style={[styles.itemLabel, isMobile && styles.itemLabelMobile]}>
                  {item.label}
                </Text>
                <Text style={[styles.itemDesc, isMobile && styles.itemDescMobile]}>
                  {item.description}
                </Text>
              </View>
            ))}
          </TutorialCard>
        )}

        {/* Content (simple text list) */}
        {section.content && section.content.length > 0 && (
          <TutorialCard>
            {section.content.map((text, index) => (
              <View key={`content-${index}`} style={styles.contentRow}>
                <Text style={[styles.contentText, isMobile && styles.contentTextMobile]}>
                  {text}
                </Text>
              </View>
            ))}
          </TutorialCard>
        )}

        {/* Phases / Sub-sections */}
        {section.phases && section.phases.length > 0 && (
          <View>
            {section.phases.map((phase, index) => (
              <TutorialCard key={`phase-${index}`}>
                {/* Phase images */}
                {phase.images && phase.images.length > 0 && (
                  <View style={styles.phaseImages}>
                    {phase.images.map((img, idx) => (
                      <TutorialImageView 
                        key={`phase-img-${idx}`} 
                        uri={img.url} 
                        alt={img.alt}
                        screenWidth={screenWidth}
                      />
                    ))}
                  </View>
                )}
                <TutorialPhaseCard 
                  phase={phase} 
                  defaultExpanded={true}
                />
              </TutorialCard>
            ))}
          </View>
        )}

        {/* Links */}
        {section.links && section.links.length > 0 && (
          <TutorialCard>
            <Text style={[styles.linksTitle, isMobile && styles.linksTitleMobile]}>
              {t('tutorial_detail_links')}
            </Text>
            {section.links.map((link, index) => (
              <TouchableOpacity
                key={`link-${index}`}
                style={styles.linkButton}
                onPress={() => Linking.openURL(link.url)}
                activeOpacity={0.7}
              >
                <Text style={styles.linkIcon}>🌐</Text>
                <Text style={[styles.linkText, isMobile && styles.linkTextMobile]}>
                  {link.label}
                </Text>
              </TouchableOpacity>
            ))}
          </TutorialCard>
        )}

        {/* Footer */}
        <View style={styles.footer}>
          <Text style={[styles.footerText, isMobile && styles.footerTextMobile]}>
            {t('tutorial_detail_source')}
          </Text>
          <Text style={[styles.footerDate, isMobile && styles.footerDateMobile]}>
            {t('tutorial_detail_updated')}
          </Text>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  container: {
    flex: 1,
  },
  contentContainer: {
    padding: 16,
    paddingBottom: 40,
  },
  contentContainerMobile: {
    padding: 10,
    paddingBottom: 32,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 20,
    marginTop: 8,
  },
  headerMobile: {
    marginBottom: 14,
    marginTop: 4,
  },
  headerIcon: {
    fontSize: 32,
    marginRight: 12,
  },
  headerIconMobile: {
    fontSize: 26,
    marginRight: 8,
  },
  headerTitle: {
    color: COLORS.text,
    fontSize: 24,
    fontWeight: 'bold',
  },
  headerTitleMobile: {
    fontSize: 19,
  },
  description: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 24,
  },
  descriptionMobile: {
    fontSize: 13,
    lineHeight: 21,
  },
  itemRow: {
    flexDirection: 'row',
    marginBottom: 14,
    paddingBottom: 14,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.border,
  },
  itemLabel: {
    color: COLORS.primary,
    fontSize: 15,
    fontWeight: '700',
    width: 80,
    marginRight: 8,
  },
  itemLabelMobile: {
    fontSize: 13,
    width: 65,
  },
  itemDesc: {
    color: COLORS.textSecondary,
    fontSize: 14,
    lineHeight: 21,
    flex: 1,
  },
  itemDescMobile: {
    fontSize: 12,
    lineHeight: 18,
  },
  contentRow: {
    marginBottom: 10,
    paddingVertical: 4,
  },
  contentText: {
    color: COLORS.textSecondary,
    fontSize: 15,
    lineHeight: 24,
  },
  contentTextMobile: {
    fontSize: 13,
    lineHeight: 21,
  },
  phaseImages: {
    marginBottom: 8,
  },
  linksTitle: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '700',
    marginBottom: 16,
  },
  linksTitleMobile: {
    fontSize: 14,
    marginBottom: 12,
  },
  linkButton: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.surfaceLight,
    borderRadius: 10,
    padding: 14,
    marginBottom: 8,
  },
  linkIcon: {
    fontSize: 18,
    marginRight: 12,
  },
  linkText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '500',
    flex: 1,
    textDecorationLine: 'underline',
  },
  linkTextMobile: {
    fontSize: 12,
  },
  footer: {
    marginTop: 24,
    paddingTop: 16,
    borderTopWidth: 1,
    borderTopColor: COLORS.border,
    alignItems: 'center',
  },
  footerText: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginBottom: 4,
  },
  footerTextMobile: {
    fontSize: 11,
  },
  footerDate: {
    color: COLORS.textSecondary,
    fontSize: 11,
    opacity: 0.7,
  },
  footerDateMobile: {
    fontSize: 10,
  },
});
