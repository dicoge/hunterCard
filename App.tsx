import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { FEATURES } from './src/config/releaseFlags';
// DIC-1189: renders only when APP_ENV=staging; a no-op in production.
import { StagingBanner } from './src/components/StagingBanner';

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
      <StagingBanner />
    </SafeAreaProvider>
  );
}
