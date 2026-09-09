/**
 * Push Notification Service
 *
 * 到價提醒的 device token 管理：
 *   1. registerForPushNotifications() — 取得權限 + Expo push token
 *   2. uploadDeviceToken(token)       — 上傳 token 到後端 (POST /api/push/register)
 *
 * 上傳失敗為 non-fatal（僅 console.warn），App 啟動時呼叫一次即可。
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';

import { PRODUCTION_ORIGIN } from '../config/apiOrigin';

// 後端 base URL：web 用當前 origin，native 用 canonical production origin
// (DIC-1245)。舊 holocard-hunter.vercel.app 未部署當前的 push register / notify
// 端點，native fallback 一定要走 canonical domain，否則到價提醒的 device token
// 會靜默丟失。
export function getApiBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return PRODUCTION_ORIGIN;
}

function getProjectId(): string | undefined {
  return Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
}

// 最近一次成功取得的 Expo push token。到價提醒（DIC-1023）需要知道這台裝置
// 能不能收背景推播：null 代表 web / 未授權 / 未註冊，此時提醒僅在本機運作。
let cachedPushToken: string | null = null;

export function getCachedPushToken(): string | null {
  return cachedPushToken;
}

/**
 * 請求通知權限並取得 Expo push token。
 * 失敗（未授權 / web 不支援 / 例外）時回傳 null。
 */
export async function registerForPushNotifications(): Promise<string | null> {
  try {
    // Expo push token 走 Expo push service，不支援 web
    if (Platform.OS === 'web') return null;

    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') {
      const req = await Notifications.requestPermissionsAsync();
      status = req.status;
    }
    if (status !== 'granted') {
      console.warn('[push] notification permission not granted');
      return null;
    }

    const projectId = getProjectId();
    const tokenResponse = await Notifications.getExpoPushTokenAsync(
      projectId ? { projectId } : undefined
    );
    cachedPushToken = tokenResponse.data;
    return cachedPushToken;
  } catch (err) {
    console.warn('[push] failed to register for notifications:', err);
    return null;
  }
}

/**
 * 上傳 device token 到後端。失敗為 non-fatal。
 */
export async function uploadDeviceToken(token: string): Promise<void> {
  try {
    const res = await fetch(`${getApiBase()}/api/push/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token, platform: Platform.OS }),
    });
    if (!res.ok) {
      console.warn(`[push] uploadDeviceToken returned ${res.status}`);
    }
  } catch (err) {
    console.warn('[push] uploadDeviceToken failed:', err);
  }
}

/**
 * App 啟動時呼叫一次：註冊 + 上傳。
 */
export async function initPushNotifications(): Promise<void> {
  const token = await registerForPushNotifications();
  if (token) {
    await uploadDeviceToken(token);
  }
}
