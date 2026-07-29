/**
 * Apple refresh_token 儲存介面（seam）。
 *
 * 正確的刪除流程需要：登入當下用 fresh authorizationCode 換 refresh_token，
 * 以 userId 為 key 保存於「後端伺服器端持久化儲存」，帳號刪除時再取出撤銷。
 *
 * ⚠️ 目前為 non-shipping foundation：尚未接後端持久化儲存。
 * 這些函式刻意留成介面樁（seam），未實作前 fail-closed：
 *   - persistAppleRefreshToken → 丟 TokenStoreNotImplementedError（呼叫端回 501）
 *   - getStoredAppleRefreshToken → 回 null（刪除端無憑證可撤銷 → 回 501）
 *   - deleteStoredAppleRefreshToken → no-op
 *
 * ⚠️ refresh_token 是機密，絕不可存入 repo / git-backed storage。
 * 實作時請接真正的伺服器端 KV / DB（例如 Vercel KV、Postgres），並加密靜態儲存。
 */

export class TokenStoreNotImplementedError extends Error {
  constructor() {
    super('apple refresh_token store not implemented');
    this.name = 'TokenStoreNotImplementedError';
  }
}

/** 保存某 user 的 Apple refresh_token（登入時）。未實作前丟例外，呼叫端 fail-closed。 */
export async function persistAppleRefreshToken(
  _userId: string,
  _refreshToken: string
): Promise<void> {
  throw new TokenStoreNotImplementedError();
}

/** 取出某 user 的 Apple refresh_token（刪除時）。未實作前回 null。 */
export async function getStoredAppleRefreshToken(
  _userId: string
): Promise<string | null> {
  return null;
}

/** 刪除某 user 的 Apple refresh_token（撤銷後清理）。未實作前 no-op。 */
export async function deleteStoredAppleRefreshToken(_userId: string): Promise<void> {
  // no-op（foundation）
}
