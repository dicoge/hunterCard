/**
 * Google 登入（Android 第一優先）— DIC-665。
 *
 * 用 `@react-native-google-signin/google-signin` 原生流程（Android Credential Manager /
 * iOS 原生），以**伺服器 Web client ID** 作 `webClientId`，取回 Google 簽發的 `id_token`。
 * 該 `id_token` 一律送後端 `POST /api/auth/login` 驗證（簽章 / iss / aud / exp），由
 * **後端**以 (google, sub) 找/建 internal user 並簽發 app session——client 不自行決定
 * 身份、不 mint 使用者 id、也不信任本地解碼的 payload。
 *
 * 為何不用 expo-auth-session 的反轉 client id 自訂 scheme：Android 上該 installed-app
 * 瀏覽器流程實測不穩且非官方推薦，故改用原生 SDK（見 docs/AUTH_SETUP.md）。
 *
 * Web 不走此模組（Web Google 屬 DIC-663）；native 缺 webClientId 時 isGoogleAuthConfigured
 * 回 false，UI 應停用按鈕。
 *
 * ⚠️ nonce 相依限制：後端 /api/auth/login 要求 id_token 帶有與 server-issued nonce 相等的
 * `nonce` claim（強制、fail-closed）。要讓 Google 把 nonce 寫入 id_token，原生登入須支援
 * 傳入 nonce——即 Android Credential Manager 的 `setNonce`（由 `@react-native-google-signin`
 * 的 **Universal Sign In**／One Tap `signIn({ nonce })` 提供）。目前安裝的 free tier
 * (`GoogleSignin.signIn`) 尚未暴露 nonce 參數，故實機要通過登入需採用支援 nonce 的原生路徑
 * （見 docs/AUTH_SETUP.md 的「nonce 強制與原生相依」）。此處已把 nonce 傳入 signIn 並送後端，
 * 一旦採用支援 nonce 的原生層即可端到端運作；在此之前後端會正確地 fail-closed 拒絕無 nonce 的 token。
 */
import { Platform } from 'react-native';

// 原生模組僅存在於 native runtime；以 lazy require 避免 web 打包 / 測試環境載入原生碼。
declare const require: (id: string) => any;

type GoogleSigninNative = {
  GoogleSignin: {
    configure(opts: {
      webClientId: string;
      iosClientId?: string;
      offlineAccess?: boolean;
    }): void;
    hasPlayServices(opts?: {
      showPlayServicesUpdateDialog?: boolean;
    }): Promise<boolean>;
    // nonce 透傳給底層 Credential Manager / GIDSignIn，使其寫入 id_token 的 nonce claim。
    signIn(params?: { nonce?: string }): Promise<unknown>;
  };
  statusCodes: {
    SIGN_IN_CANCELLED: string;
    IN_PROGRESS: string;
    PLAY_SERVICES_NOT_AVAILABLE: string;
  };
};

/** 使用者主動取消登入時丟出的錯誤碼——呼叫端據此靜默處理，不顯示錯誤。 */
export const GOOGLE_CANCEL_CODE = 'ERR_GOOGLE_CANCELED';

const PRODUCTION_API_BASE = 'https://holocard-hunter.vercel.app';

const WEB_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_WEB_CLIENT_ID ?? '';
const IOS_CLIENT_ID = process.env.EXPO_PUBLIC_GOOGLE_IOS_CLIENT_ID ?? '';

export class GoogleAuthNotConfiguredError extends Error {
  code = 'ERR_GOOGLE_NOT_CONFIGURED';
  constructor() {
    super('Google 登入尚未設定，請見 docs/AUTH_SETUP.md');
    this.name = 'GoogleAuthNotConfiguredError';
  }
}

export interface GoogleBackendUser {
  internalId: string;
  displayName: string | null;
  primaryEmail: string | null;
  photoUrl: string | null;
  linkedProviders: Array<{
    provider: string;
    providerId: string;
    email: string | null;
    displayName: string | null;
    photoUrl: string | null;
    linkedAt: string;
  }>;
  createdAt: string;
}

export interface GoogleBackendSession {
  user: GoogleBackendUser;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  isNewUser: boolean;
}

let cachedNative: GoogleSigninNative | null = null;
function loadNative(): GoogleSigninNative {
  if (!cachedNative) {
    cachedNative = require('@react-native-google-signin/google-signin') as GoogleSigninNative;
  }
  return cachedNative;
}

function getApiBase(): string {
  if (Platform.OS === 'web' && typeof window !== 'undefined') {
    return window.location.origin;
  }
  return PRODUCTION_API_BASE;
}

/**
 * native 是否已備妥 Google 登入：需伺服器 Web client ID 作 webClientId / audience。
 * Web 一律回 false（Web Google 屬 DIC-663，不在此模組）。
 */
export function isGoogleAuthConfigured(): boolean {
  if (Platform.OS === 'web') return false;
  return WEB_CLIENT_ID.length > 0;
}

/** 從新 / 舊版 SDK 的 signIn() 回傳形狀中安全取出 idToken；取消則回哨兵 'CANCELLED'。 */
function extractIdToken(result: unknown): string | 'CANCELLED' | null {
  const r = result as {
    type?: string;
    idToken?: string | null;
    data?: { idToken?: string | null } | null;
  };
  if (r?.type === 'cancelled') return 'CANCELLED';
  return r?.data?.idToken ?? r?.idToken ?? null;
}

function cancelError(): Error & { code: string } {
  const err = new Error('User cancelled Google sign-in') as Error & { code: string };
  err.code = GOOGLE_CANCEL_CODE;
  return err;
}

/**
 * 向後端取一枚 server-bound 一次性 nonce（/api/auth/nonce）。此 nonce 會被帶進 Google
 * 登入寫入 id_token 的 nonce claim，並於 /api/auth/login 被原子消費 + 比對，防止 token
 * 重放。取不到 nonce 即 fail-closed（不進行登入）。
 */
async function fetchLoginNonce(): Promise<string> {
  const res = await fetch(`${getApiBase()}/api/auth/nonce`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!res.ok) {
    throw new Error(`Failed to obtain login nonce: ${res.status}`);
  }
  const data = (await res.json()) as { nonce?: string };
  if (!data.nonce) {
    throw new Error('Login nonce missing in response');
  }
  return data.nonce;
}

async function exchangeWithBackend(
  idToken: string,
  nonce: string
): Promise<GoogleBackendSession> {
  const res = await fetch(`${getApiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', id_token: idToken, nonce }),
  });
  if (!res.ok) {
    throw new Error(`Google backend login failed: ${res.status}`);
  }
  const data = (await res.json()) as {
    user: {
      id: string;
      displayName: string | null;
      primaryEmail: string | null;
      photoUrl: string | null;
      linkedProviders: GoogleBackendUser['linkedProviders'];
      createdAt: string;
    };
    session: { access_token: string; refresh_token: string; expires_in: number };
    is_new_user: boolean;
  };

  return {
    user: {
      internalId: data.user.id,
      displayName: data.user.displayName,
      primaryEmail: data.user.primaryEmail,
      photoUrl: data.user.photoUrl,
      linkedProviders: data.user.linkedProviders,
      createdAt: data.user.createdAt,
    },
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token ?? null,
    expiresAt: Date.now() + data.session.expires_in * 1000,
    isNewUser: data.is_new_user,
  };
}

/**
 * 觸發原生 Google 登入 → 取 id_token → 後端驗證換 app session。
 * 使用者取消時丟出帶 GOOGLE_CANCEL_CODE 的錯誤（呼叫端靜默）。
 */
export async function signInWithGoogle(): Promise<GoogleBackendSession> {
  if (!isGoogleAuthConfigured()) {
    throw new GoogleAuthNotConfiguredError();
  }

  const { GoogleSignin, statusCodes } = loadNative();
  GoogleSignin.configure({
    webClientId: WEB_CLIENT_ID,
    iosClientId: IOS_CLIENT_ID || undefined,
    offlineAccess: false,
  });

  // 先取 server-bound 一次性 nonce，帶進原生登入使其寫入 id_token 的 nonce claim，
  // 後端登入時會原子消費並要求相等（防重放）。
  const nonce = await fetchLoginNonce();

  let result: unknown;
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    result = await GoogleSignin.signIn({ nonce });
  } catch (err) {
    if ((err as { code?: string })?.code === statusCodes.SIGN_IN_CANCELLED) {
      throw cancelError();
    }
    throw err;
  }

  const idToken = extractIdToken(result);
  if (idToken === 'CANCELLED') {
    throw cancelError();
  }
  if (!idToken) {
    throw new Error('No id_token returned from Google sign-in');
  }

  return exchangeWithBackend(idToken, nonce);
}
