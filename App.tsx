import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { FEATURES } from './src/config/releaseFlags';

// DIC-1189 rework 3rd pass — blocker #4: use a BUILD-TIME-INLINED env check
// so Metro / babel constant-folds `IS_STAGING_BUILD` to `false` on a
// production build (EXPO_PUBLIC_APP_ENV != 'staging' or unset) and dead-code-
// eliminates BOTH the guarded require() AND the StagingBanner module out of
// the production JS bundle entirely. The staging bundle constant-folds it to
// `true` and keeps the require so the banner mounts on staging.
//
// This is why the require is `require(...)` rather than the earlier
// `import { StagingBanner } from '...'` — an ES import is always bundled
// regardless of runtime branches, so the banner's text ("TEST · 測試環境")
// would end up in the production bundle even though it never rendered. The
// require, inside an `if (build-constant)` block, is elided at bundle time
// on production.
const IS_STAGING_BUILD = process.env.EXPO_PUBLIC_APP_ENV === 'staging';
const StagingBanner: React.ComponentType | null = IS_STAGING_BUILD
  // eslint-disable-next-line @typescript-eslint/no-require-imports, global-require
  ? (require('./src/components/StagingBanner').StagingBanner as React.ComponentType)
  : null;

export default function App() {
  useEffect(() => {
    // 價格預判通知 / watchlist trend alerts — Store MVP 隱藏（DIC-908）。
    // 一併停用 OS 通知權限請求，避免為已隱藏功能索取權限。
    if (FEATURES.pushAlerts) {
      initPushNotifications();
    }
    // NOTE (DIC-976 CR blocker 2): the web-Google redirect RETURN leg is no
    // longer kicked off here. Boot is now owned exclusively by the auth store's
    // onRehydrateStorage, which serializes the redirect-completion and
    // persisted-session-validation flows so a stale /auth/me can't race/overwrite
    // the callback result. Kicking it off from here too would double-run and
    // reintroduce the race.
  }, []);

  return (
    <SafeAreaProvider>
      <AppNavigator />
      {StagingBanner ? <StagingBanner /> : null}
    </SafeAreaProvider>
  );
}
