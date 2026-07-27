/**
 * Sign in with Apple（僅 iOS）。
 *
 * 使用 expo-apple-authentication 原生流程。Apple 只在「首次」授權時回傳
 * fullName / email，後續登入這兩個欄位為 null——所以呼叫端必須在首次登入時
 * 保存這些資訊（見 authStore）。
 */
import { Platform } from 'react-native';
import * as AppleAuthentication from 'expo-apple-authentication';

import type { AuthSession, AuthUser } from '../../types/auth';

/** 使用者主動取消授權彈窗時 Apple 丟出的錯誤碼。 */
export const APPLE_CANCEL_CODE = 'ERR_REQUEST_CANCELED';

/** 裝置 / 平台是否支援 Sign in with Apple（僅 iOS 13+）。 */
export async function isAppleAuthAvailable(): Promise<boolean> {
  if (Platform.OS !== 'ios') return false;
  try {
    return await AppleAuthentication.isAvailableAsync();
  } catch {
    return false;
  }
}

function composeName(fullName: AppleAuthentication.AppleAuthenticationCredential['fullName']): string | null {
  if (!fullName) return null;
  const parts = [fullName.givenName, fullName.familyName].filter(Boolean);
  return parts.length ? parts.join(' ') : null;
}

/**
 * 觸發原生 Sign in with Apple 流程並回傳一個 AuthSession。
 * 使用者取消時 re-throw 原始錯誤（呼叫端以 APPLE_CANCEL_CODE 判斷）。
 */
export async function signInWithApple(): Promise<AuthSession> {
  const credential = await AppleAuthentication.signInAsync({
    requestedScopes: [
      AppleAuthentication.AppleAuthenticationScope.FULL_NAME,
      AppleAuthentication.AppleAuthenticationScope.EMAIL,
    ],
  });

  const user: AuthUser = {
    id: credential.user,
    provider: 'apple',
    email: credential.email ?? null,
    name: composeName(credential.fullName),
  };

  return {
    user,
    identityToken: credential.identityToken ?? null,
    authorizationCode: credential.authorizationCode ?? null,
    createdAt: new Date().toISOString(),
  };
}

/**
 * 查詢憑證是否仍有效（可用於啟動時檢查使用者是否已在設定中撤銷授權）。
 * 非 iOS 一律回傳 true（該平台不使用 Apple 憑證）。
 */
export async function isAppleCredentialAuthorized(userId: string): Promise<boolean> {
  if (Platform.OS !== 'ios') return true;
  try {
    const state = await AppleAuthentication.getCredentialStateAsync(userId);
    return state === AppleAuthentication.AppleAuthenticationCredentialState.AUTHORIZED;
  } catch {
    return true;
  }
}
