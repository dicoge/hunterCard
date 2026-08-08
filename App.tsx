import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { FEATURES } from './src/config/releaseFlags';

export default function App() {
  useEffect(() => {
    // 價格預判通知 / watchlist trend alerts — Store MVP 隱藏（DIC-908）。
    // 一併停用 OS 通知權限請求，避免為已隱藏功能索取權限。
    if (FEATURES.pushAlerts) {
      initPushNotifications();
    }
  }, []);

  return (
    <SafeAreaProvider>
      <AppNavigator />
    </SafeAreaProvider>
  );
}
