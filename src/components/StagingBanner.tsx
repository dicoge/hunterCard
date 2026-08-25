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

// The env value is baked at build time. On web the same SHA is also injected
// into a <meta name="staging-sha"> by scripts/fix-html.js; when both are
// present they should match, and we deliberately prefer the meta tag as the
// tie-break because it is what the workflow's smoke test asserts against.
function readShaFromMetaTag(): string {
  if (Platform.OS !== 'web') return '';
  if (typeof document === 'undefined') return '';
  const meta = document.querySelector('meta[name="staging-sha"]');
  const content = meta?.getAttribute('content');
  return typeof content === 'string' ? content.trim().slice(0, 12) : '';
}

// Rework-blocker #5: the display path must NEVER fall through to a literal
// 'unknown'. If the SHA is genuinely missing on a staging deployment that is a
// bug (buildCommand didn't propagate VERCEL_GIT_COMMIT_SHA and fix-html.js
// didn't inject the meta) — we surface it as a visible red MISSING marker so
// a reviewer immediately spots the platform boundary instead of silently
// showing 'unknown' as if it were data.
function displaySha(): { text: string; missing: boolean } {
  const sha = readShaFromMetaTag() || STAGING_SHA || resolveStagingSha();
  if (!sha) return { text: 'MISSING', missing: true };
  return { text: sha, missing: false };
}

export function StagingBanner(): React.ReactElement | null {
  if (!IS_STAGING) return null;
  const { text, missing } = displaySha();
  return (
    <View
      style={[styles.container, missing && styles.containerMissing]}
      accessibilityLabel={
        missing
          ? '測試環境 staging (SHA missing — deployment misconfigured)'
          : '測試環境 staging test environment'
      }
    >
      <Text style={[styles.label, missing && styles.labelMissing]}>TEST · 測試環境</Text>
      <Text style={[styles.sha, missing && styles.labelMissing]}>staging · {text}</Text>
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
  // Rework-blocker #5: visibly surface a missing SHA. The red background
  // makes it impossible to miss on the deployment; if a reviewer sees this
  // in production (they never should — IS_STAGING is false there) or on
  // staging, it is a configuration-fail signal, not a design detail.
  containerMissing: {
    backgroundColor: '#F8D7DA',
    borderBottomColor: '#DC3545',
  },
  labelMissing: {
    color: '#721C24',
  },
});

export default StagingBanner;
