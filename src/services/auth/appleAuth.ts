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
 * Apple 憑證狀態（啟動時用來判斷使用者是否已在「設定 → Apple ID」撤銷授權）。
 * - `authorized`：仍有效。
 * - `revoked`：已撤銷 / 已轉移 / 找不到——應強制登出要求重新驗證。
 * - `unknown`：查詢失敗（原生模組拋錯 / 暫時性錯誤）——**不**視為已授權，但也不強制
 *   登出，避免因網路 / 系統暫時性錯誤誤踢正常使用者。
 * - `not_applicable`：非 iOS，不使用 Apple 憑證。
 */
export type AppleCredentialStatus = 'authorized' | 'revoked' | 'unknown' | 'not_applicable';

/**
 * 查詢 Apple 憑證狀態。
 *
 * fail-safe（CR DIC-855 #5）：查詢失敗一律回 `unknown`，**絕不**回 `authorized`——
 * 過去的實作在 catch 時回 true（等同宣稱已授權），會掩蓋撤銷狀態。呼叫端只在
 * `revoked` 時才登出（見 authStore.verifyAppleCredential）。
 */
export async function getAppleCredentialStatus(userId: string): Promise<AppleCredentialStatus> {
  if (Platform.OS !== 'ios') return 'not_applicable';
  try {
    const state = await AppleAuthentication.getCredentialStateAsync(userId);
    return state === AppleAuthentication.AppleAuthenticationCredentialState.AUTHORIZED
      ? 'authorized'
      : 'revoked';
  } catch {
    return 'unknown';
  }
}
