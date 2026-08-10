// Friendly-but-safe auth error mapping (DIC-922 blocker 4).
//
// Before this, SettingsScreen/AuthScreen collapsed EVERY login failure into a
// single "無法完成 Google 登入", so a real device gave zero diagnostic signal
// (config-missing vs. cancel vs. network vs. backend all looked identical).
// This maps a login/link error to a message that is still SECURITY-SAFE but
// distinguishes the cause the user (or support) needs.
//
// SECURITY: we only ever branch on a small allow-list of `code`/`status`
// values. We NEVER echo a raw provider/SDK/backend `message` verbatim — those
// can carry ID tokens, emails, or internal detail and must not reach the UI.
//
// Pure (no react-native/expo imports) so it is unit-testable in plain Node.

export type AuthErrorProvider = 'google' | 'apple';

export interface MappableAuthError {
  code?: string | null;
  status?: number | null;
  message?: string | null;
}

const PROVIDER_LABEL: Record<AuthErrorProvider, string> = {
  google: 'Google',
  apple: 'Apple',
};

// True cancellations are a user choice, not an error — callers should suppress
// any alert for these rather than nagging the user with a failure dialog.
export function isCancelAuthError(err: MappableAuthError | null | undefined): boolean {
  return err?.code === 'cancel';
}

export function friendlyAuthErrorMessage(
  err: MappableAuthError | null | undefined,
  provider: AuthErrorProvider = 'google',
): string {
  const label = PROVIDER_LABEL[provider];
  const code = err?.code ?? undefined;
  const status = typeof err?.status === 'number' ? err.status : undefined;

  switch (code) {
    case 'cancel':
      return '已取消登入。';
    case 'client_id_missing':
      return `${label} 登入尚未設定完成（缺少登入服務設定），請稍後再試或聯絡我們。`;
    case 'redirect_uri_mismatch':
      return `${label} 登入設定不符（redirect 網址未授權），請稍後再試或聯絡我們。`;
    case 'access_denied':
      return `${label} 未授權此次登入，請再試一次。`;
    case 'play_services_unavailable':
      return '此裝置的 Google Play 服務不可用或需更新，無法使用 Google 登入。';
    case 'apple_unavailable':
      return '此裝置不支援 Apple 登入（需 iOS 13 以上）。';
    case 'no_code':
    case 'no_verifier':
    case 'no_id_token':
      return `${label} 登入未完成（未取得授權憑證），請再試一次。`;
    case 'network_error':
      return '網路連線異常，請檢查網路後再試。';
    default:
      break;
  }

  // Status-based fallback for backend / unmapped errors — still no raw echo.
  if (status === 0) return '網路連線異常，請檢查網路後再試。';
  if (status !== undefined && status >= 500) {
    return `${label} 登入服務暫時無法使用（伺服器錯誤），請稍後再試。`;
  }
  if (status !== undefined && status >= 400) {
    return `${label} 登入失敗，請確認後再試一次。`;
  }
  return `無法完成 ${label} 登入，請稍後再試。`;
}
