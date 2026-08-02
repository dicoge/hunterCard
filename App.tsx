import React, { useEffect } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import AppNavigator from './src/navigation/AppNavigator';
import { initPushNotifications } from './src/services/pushNotificationService';
import { useAuthStore } from './src/store/authStore';

export default function App() {
  const hasHydrated = useAuthStore((s) => s.hasHydrated);
  const verifyAppleCredential = useAuthStore((s) => s.verifyAppleCredential);

  useEffect(() => {
    initPushNotifications();
  }, []);

  // Once the persisted session rehydrates, re-check the Apple credential so a
  // user who revoked access in iOS Settings is signed out and asked to re-auth.
  useEffect(() => {
    if (hasHydrated) verifyAppleCredential();
  }, [hasHydrated, verifyAppleCredential]);

  return (
    <SafeAreaProvider>
      <AppNavigator />
    </SafeAreaProvider>
  );
}
