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
// any alert for these rather than nagging the user with a failure dialog. The
// web-Google redirect transport (DIC-976) also throws a `redirecting` sentinel
// as it full-page-navigates away; that is NOT a failure either (the login
// resolves on the next app load), so it is suppressed exactly like a cancel.
export function isCancelAuthError(err: MappableAuthError | null | undefined): boolean {
  return err?.code === 'cancel' || err?.code === 'redirecting';
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
    case 'redirecting':
      // `redirecting` should be suppressed by isCancelAuthError before reaching
      // here; map it defensively to the same benign string just in case.
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
    // Web-Google same-window redirect transport diagnostics (DIC-976). Each maps
    // to a DISTINCT safe message so a real device no longer collapses every
    // failure into the generic "無法完成 Google 登入" the owner saw.
    case 'popup_blocked':
      return `瀏覽器封鎖了 ${label} 登入視窗，請允許彈出視窗或改用系統瀏覽器後再試。`;
    case 'crypto_unavailable':
      return '此瀏覽器不支援安全登入所需的加密功能，請改用其他瀏覽器。';
    case 'storage_unavailable':
    case 'storage_unavailable_standalone':
      return '此瀏覽器不允許儲存登入狀態（可能為無痕模式），請關閉無痕模式後再試。';
    case 'state_mismatch':
      return `${label} 登入驗證失敗（狀態不符），請重新登入。`;
    case 'no_window':
      return `無法在此環境啟動 ${label} 登入，請改用瀏覽器開啟。`;
    case 'prompt_failed':
      return `${label} 登入未完成，請再試一次。`;
    // Account-linking / session server codes (DIC-976 CR). SettingsScreen's link
    // CTA now routes real link errors through THIS safe mapper (never echoing a
    // raw err.message). These mirror the server-provided friendly strings so the
    // specific link-collision guidance is preserved rather than degraded to the
    // generic 4xx fallback.
    case 'IDENTITY_ALREADY_LINKED':
      return `此 ${label} 帳號已綁定到另一個 HoloHunter 帳號，請先從該帳號解除綁定後再試。`;
    case 'SAME_PROVIDER_ALREADY_LINKED':
      return `你已綁定一個 ${label} 帳號。若要更換，請先解除舊的再綁定新的。`;
    case 'CANNOT_UNLINK_LAST_METHOD':
      return '無法解除唯一的登入方式，請先綁定其他登入方式。';
    case 'ACCOUNT_DISABLED':
      return '此帳號已停用，請聯絡客服。';
    case 'INVALID_TOKEN':
      return '登入驗證失敗，請重新登入。';
    case 'TOKEN_EXPIRED':
      return '登入已逾時，請重新登入。';
    case 'TOKEN_REPLAYED':
      return '此登入憑證已使用過，請重新登入。';
    case 'STORE_NOT_CONFIGURED':
      return '登入服務尚未設定完成（後端未就緒），請稍後再試。';
    case 'no_session':
      return `無法綁定 ${label}：找不到目前的登入狀態，請重新登入後再試。`;
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
