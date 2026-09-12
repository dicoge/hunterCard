import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { FEATURES } from './src/config/releaseFlags';
import { installAccountSyncBinding } from './src/services/accountSyncBinding';

export default function App() {
  useEffect(() => {
    // 價格預判通知 / watchlist trend alerts — Store MVP 隱藏（DIC-908）。
    // 一併停用 OS 通知權限請求，避免為已隱藏功能索取權限。
    if (FEATURES.pushAlerts) {
      initPushNotifications();
    }
    // Account remote-sync (DIC-1380 W4): subscribe the auth store to hydrate
    // deck / collection / priceAlerts / settings from the server on session
    // adoption, and the local stores to push changes back through the
    // orchestrator. The binding no-ops under Store MVP so hidden surfaces do
    // not fire any account-sync request.
    if (FEATURES.favorites || FEATURES.watchlist || FEATURES.premium) {
      installAccountSyncBinding();
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
    </SafeAreaProvider>
  );
}
