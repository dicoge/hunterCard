/**
 * Google 登入（Android 第一優先）— DIC-665。
 *
 * 用 `@react-native-google-signin/google-signin` 的**legacy（classic）Google Sign-In**
 * 原生流程（免費版；**不是** Android Credential Manager，Credential Manager 屬付費
 * Universal Sign In），以**伺服器 Web client ID** 作 `webClientId`，取回 Google 簽發的
 * `id_token`。Android 用哪個 OAuth client 由 package name + SHA-1 憑證指紋在 Google
 * Cloud Console 的註冊決定，**而非** 由程式挑選 client id；`configure()` 只帶 Web
 * client ID 作為後端驗證的 audience（見 docs/AUTH_SETUP.md）。
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
 * 反重放：目前安裝的 classic `@react-native-google-signin/google-signin`（free tier）的
 * `GoogleSignin.signIn()` **不接受也不透傳 nonce**（nonce 屬付費 Universal Sign In）。因此
 * client 只取回 Google 簽發的原始 id_token 交給後端，反重放由**後端**負責：嚴格 iat 新鮮度
 * 檢查 + 對已驗證的 id_token 做一次性消費（見 api/_lib/replay-guard.ts）。client 不再向
 * /api/auth/nonce 取 nonce，也不對 signIn 傳入 nonce——那在此 SDK 下不會生效。
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
    // classic free-tier signIn()：不接受 nonce（Universal Sign In 才有），回傳含 id_token。
    signIn(): Promise<unknown>;
    // 清除快取的 Google 帳號 session（登出）；下次 signIn() 會重新彈出帳號選擇器並簽發新 id_token。
    signOut(): Promise<void>;
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

async function exchangeWithBackend(
  idToken: string
): Promise<GoogleBackendSession> {
  const res = await fetch(`${getApiBase()}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider: 'google', id_token: idToken }),
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
 * 原生 Google 登出：清除 SDK 快取的 Google 帳號 session。
 *
 * 這才是正確的「Google 端登出」——把 app 自己的 session JWT 送去 Google 的 revoke
 * 端點是錯的（那不是 Google 簽的 token）。登出後再次登入會重新走 signIn() 拿到一枚
 * **全新** id_token（新指紋），故後端的一次性重放防護不會擋住合法的「登出後立即再登入」。
 * web 無原生模組 → no-op（web Google 屬 DIC-663）。
 */
export async function signOutGoogle(): Promise<void> {
  if (Platform.OS === 'web') return;
  await loadNative().GoogleSignin.signOut();
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

  let result: unknown;
  try {
    await GoogleSignin.hasPlayServices({ showPlayServicesUpdateDialog: true });
    result = await GoogleSignin.signIn();
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

  return exchangeWithBackend(idToken);
}
