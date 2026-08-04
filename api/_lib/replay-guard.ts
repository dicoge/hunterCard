/**
 * 登入重放防護（one-time id_token 消費，DIC-665 CR round 3）。
 *
 * 為什麼不是「token 內嵌 nonce」：真正的 challenge–response nonce 需要把 server 發的
 * nonce 寫進 Google id_token 的 `nonce` claim，這要求原生登入層支援傳入 nonce
 * （屬付費 Universal Sign In / Credential Manager `setNonce`）。目前安裝的是
 * **legacy（classic）Google Sign-In**（`@react-native-google-signin/google-signin`
 * 免費版，**不是** Credential Manager），其 `GoogleSignin.signIn()` **不接受也不透傳
 * nonce**——先前用 TS 型別假裝支援是錯的：
 * 後端要求 token 帶 nonce 會讓每一次真實裝置登入都被 fail-closed 拒絕。
 *
 * 因此改用**與所選 SDK 實際可執行**的 fail-closed 反重放合約：
 *   1. 後端嚴格檢查 id_token 的 `iat` 新鮮度（google-auth.ts，超過 MAX_ID_TOKEN_AGE_SEC 即拒）。
 *   2. 後端對「驗證通過的 id_token」做**一次性消費**：以 token 指紋（SHA-256）為鍵，
 *      SET NX 佔用於 KV，TTL 覆蓋 token 剩餘壽命。第一次成功佔用才放行；同一 token 再次
 *      交換（重放）佔用失敗 → 拒絕。
 *
 * 保留了原本「KV 一次性（atomic reserve）」語意，只是鍵改綁在 token 本身而非 server nonce，
 * 使其在 free SDK 下可端到端執行。限制（誠實揭露）：這防的是**同一 token 被重放使用**，
 * 不等同 nonce 的 channel-binding（無法防禦即時 MITM 搶先第一次使用）；新鮮度視窗把可被
 * 重放的時間壓到很短。要達到完整 nonce 綁定需換成支援 nonce 的原生層（後續工作）。
 *
 * 以介面注入，單元測試用純記憶體假 KV 離線驗證 reserve / 重放。
 */
import crypto from 'crypto';

/** 佔用鍵的最大存活秒數上限（避免 token exp 異常大時無限佔用 KV）。 */
export const REPLAY_TTL_CAP_SEC = 60 * 60; // 1h（≥ Google id_token 壽命）

/** KV 子集：一次性佔用需 SET NX + TTL。 */
export interface ReplayKVLike {
  set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number }
  ): Promise<unknown>;
}

export interface ReplayGuardDeps {
  kv: ReplayKVLike;
  now?: () => number;
}

/** id_token 指紋：SHA-256(base64url)。整個簽名 token 對每次簽發是唯一的。 */
export function fingerprintIdToken(idToken: string): string {
  return crypto.createHash('sha256').update(idToken).digest('base64url');
}

function usedKey(fingerprint: string): string {
  return `auth:used_idtoken:${fingerprint}`;
}

/**
 * 一次性消費一枚已驗證的 id_token。回 true 表示「此刻首次被本次呼叫佔用」（放行）；
 * 回 false 表示已被消費過（重放）→ 呼叫端 fail-closed 拒絕。
 *
 * @param remainingTtlSec token 剩餘壽命（exp - now，秒）；佔用鍵存活到 token 失效即可，
 *        之後 token 本身也會被 exp 檢查擋下。會夾在 [1, REPLAY_TTL_CAP_SEC]。
 */
export async function reserveIdTokenOnce(
  deps: ReplayGuardDeps,
  idToken: string,
  remainingTtlSec: number
): Promise<boolean> {
  if (typeof idToken !== 'string' || idToken.length === 0) return false;
  const ttl = Math.min(
    REPLAY_TTL_CAP_SEC,
    Math.max(1, Math.floor(remainingTtlSec))
  );
  const reserved = await deps.kv.set(
    usedKey(fingerprintIdToken(idToken)),
    { at: (deps.now ?? (() => Date.now()))() },
    { nx: true, ex: ttl }
  );
  // SET NX：首次成功回 'OK'（truthy）；已存在回 null / false → 重放。
  return reserved !== null && reserved !== undefined && reserved !== false;
}
