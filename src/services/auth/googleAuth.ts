/**
 * Google 登入（Web 全平台 + iOS/Android）。
 *
 * ⚠️ 尚未接線：Google OAuth 需要額外套件與各平台 client ID 設定，屬於獨立的
 * 後續工作（見 docs/AUTH_SETUP.md 的「Google 登入後續」）。本檔先建立與
 * Apple 相同的 provider 介面，避免之後重構 authStore / AuthScreen。
 *
 * 接線步驟（後續 PR）：
 *   1. npx expo install expo-auth-session expo-web-browser
 *   2. 在 Google Cloud Console 建立 iOS / Web / Android OAuth client ID
 *   3. 以 Google.useIdTokenAuthRequest 換取 id_token，映射成 AuthSession
 */
import type { AuthSession } from '../../types/auth';

export class GoogleAuthNotConfiguredError extends Error {
  code = 'ERR_GOOGLE_NOT_CONFIGURED';
  constructor() {
    super('Google 登入尚未設定，請見 docs/AUTH_SETUP.md');
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

/** Google 目前尚未接線，永遠回傳 false，讓 UI 隱藏或停用按鈕。 */
export function isGoogleAuthConfigured(): boolean {
  return false;
}

export async function signInWithGoogle(): Promise<AuthSession> {
  // 佔位：接線後回傳 { user, identityToken, authorizationCode: null, createdAt }
  throw new GoogleAuthNotConfiguredError();
}
