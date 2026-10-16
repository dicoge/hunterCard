import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { FEATURES } from './src/config/releaseFlags';
import { installAccountSyncBinding } from './src/services/accountSyncBinding';
// Registers the local diagnostic log as the recorder for sign-in failures (diagnosticsSink).
import './src/store/scanDiagnosticsStore';

export default function App() {
  useEffect(() => {
    // 價格預判通知 / watchlist trend alerts — Store MVP 隱藏（DIC-908）。
    // 一併停用 OS 通知權限請求，避免為已隱藏功能索取權限。
    if (FEATURES.pushAlerts) {
      initPushNotifications();
    }
    // Account remote-sync (DIC-1380 W4; v41 2026-10-17): the same signed-in Google
    // account sees the same collection, decks, settings and 估值清單 on every phone.
    // Installed in every profile — Store MVP shows Collection, decks, settings and the
    // scan list too. Hidden surfaces (bookmarks, price alerts) never push there:
    // accountSyncOrchestrator.activeDomainsOnly + the binding's FEATURES gates.
    installAccountSyncBinding();
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
