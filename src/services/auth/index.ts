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
 * 登入當下把 fresh authorizationCode 送到後端換取並保存 refresh_token，
 * 供日後帳號刪除撤銷使用（見 api/auth/apple/register.ts）。
 *
 * **best-effort**：失敗（未設定 / 未實作 / 網路錯誤）都不 throw、不阻擋登入。
 * 只有 Apple 且帶 authorizationCode 時才呼叫。
 */
export async function registerAppleSession(session: AuthSession): Promise<void> {
  if (session.user.provider !== 'apple' || !session.authorizationCode) return;
  try {
    await fetch(`${getApiBase()}/api/auth/apple/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: session.user.provider,
        userId: session.user.id,
        authorizationCode: session.authorizationCode,
      }),
    });
  } catch {
    // best-effort：登入不因此失敗。
  }
}

/**
 * 通知後端刪除帳號並撤銷 provider token。
 *
 * fail-closed：只有後端回 2xx（`ok: true`）才代表撤銷 / 刪除成功。呼叫端**只有**在
 * `ok` 為 true 時才可清除本機 session（見 authStore.deleteAccount）。失敗時回
 * `{ ok: false, reason }`，讓呼叫端提示使用者「尚未完成」並維持登入狀態。
 *
 * 不再傳 authorizationCode——刪除撤銷改用後端登入時保存的 refresh_token。
 */
export async function requestAccountDeletion(
  session: AuthSession
): Promise<{ ok: boolean; reason?: string }> {
  try {
    const res = await fetch(`${getApiBase()}/api/auth/delete-account`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        provider: session.user.provider,
        userId: session.user.id,
      }),
    });
    if (res.ok) return { ok: true };
    let reason: string | undefined;
    try {
      const data = (await res.json()) as { reason?: string };
      reason = data.reason;
    } catch {
      // 忽略非 JSON 回應
    }
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: 'network_error' };
  }
}
