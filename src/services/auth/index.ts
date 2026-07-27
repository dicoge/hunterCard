/**
 * 統一的 auth service 進入點。
 *
 * 提供各 provider 的登入函式，以及帳號刪除時通知後端撤銷 provider token
 * 的 requestAccountDeletion()（App Store 審查規範 5.1.1(v) 要求 App 內可刪除帳號）。
 */
import { Platform } from 'react-native';

import type { AuthSession } from '../../types/auth';

export {
  isAppleAuthAvailable,
  isAppleCredentialAuthorized,
  signInWithApple,
  APPLE_CANCEL_CODE,
} from './appleAuth';

export {
  isGoogleAuthConfigured,
  signInWithGoogle,
  GoogleAuthNotConfiguredError,
} from './googleAuth';

const PRODUCTION_API_BASE = 'https://holocard-hunter.vercel.app';

function getApiBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return PRODUCTION_API_BASE;
}

/**
 * 通知後端刪除帳號並撤銷 provider token。
 *
 * 後端撤銷失敗時回傳 false，讓呼叫端可提示使用者稍後再試；但本機 session 仍應
 * 由呼叫端清除（見 authStore.deleteAccount）。網路錯誤同樣回傳 false，不 throw。
 */
export async function requestAccountDeletion(session: AuthSession): Promise<boolean> {
  try {
    const res = await fetch(`${getApiBase()}/api/auth/delete-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: session.user.provider,
        userId: session.user.id,
        authorizationCode: session.authorizationCode,
      }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
