// DIC-1189: low-key TEST banner shown ONLY when APP_ENV=staging.
//
// The banner exists so a human hitting test.holohunter.dicoge.com immediately
// knows they are on staging: the URL, the environment label, and the deployed
// git SHA are visible at all times. It renders nothing in production
// (IS_STAGING resolves false when APP_ENV is unset, unknown, mistyped, or
// literally 'production'), so production builds are byte-identical to what
// shipped before.

import React from 'react';
import { Platform, StyleSheet, Text, View } from 'react-native';
import { IS_STAGING, STAGING_SHA, resolveStagingSha } from '../config/appEnv';

// The env value is baked at build time; if the web build post-processor
// (scripts/fix-html.js) injected the SHA into a meta tag, prefer that when the
// env-baked value is empty (defensive — the meta tag is what actually renders
// in the HTML head so a divergence should surface as the SHA the user sees).
function readShaFromMetaTag(): string {
  if (Platform.OS !== 'web') return '';
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="staging-sha"]');
  const content = meta?.getAttribute('content');
  return typeof content === 'string' ? content.trim().slice(0, 12) : '';
}

function displaySha(): string {
  return STAGING_SHA || resolveStagingSha() || readShaFromMetaTag() || 'unknown';
}

export function StagingBanner(): React.ReactElement | null {
  if (!IS_STAGING) return null;
  return (
    <View
      style={styles.container}
      accessibilityRole="banner"
      accessibilityLabel="測試環境 staging test environment"
    >
      <Text style={styles.label}>TEST · 測試環境</Text>
      <Text style={styles.sha}>staging · {displaySha()}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    // Deliberately outside SafeAreaView so it pins to the very top of the
    // viewport and covers the notch region on notched devices; sits above the
    // real app content via elevation/zIndex.
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: 12,
    paddingVertical: 4,
    backgroundColor: '#FFF3CD',
    borderBottomWidth: 1,
    borderBottomColor: '#F0AD4E',
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    zIndex: 9999,
    elevation: 9999,
  },
  label: {
    color: '#7A4E00',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 0.5,
  },
  sha: {
    color: '#7A4E00',
    fontSize: 10,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
});

export default StagingBanner;
