/**
 * 登入 nonce 挑戰 / 消費（server-bound one-time challenge，DIC-665 CR）。
 *
 * 為什麼要 nonce：native Google Sign-In 拿到的 `id_token` 若無綁定，攔截 / 重放者可拿
 * 一枚合法 token 重複登入。做法是「後端先發一枚一次性 nonce → client 把它帶進 Google
 * 登入使其寫入 id_token 的 `nonce` claim → 後端登入時**原子性消費**該 nonce 並要求
 * token 的 nonce 完全相等」。任一環節缺失 / 重放 / 不符都 fail-closed。
 *
 * 儲存於 Vercel KV，`auth:nonce:{nonce}`，附 TTL。消費以 GETDEL 原子完成：存在→刪除→
 * 回 true（一次性放行）；不存在（已消費 / 過期 / 偽造）→ 回 false。
 *
 * 以介面注入，單元測試可用純記憶體假 KV 離線驗證挑戰 / 消費 / 重放 / 過期。
 */
import crypto from 'crypto';

export const NONCE_TTL_SEC = 300;

/** KV 子集：發放需 SET（NX + TTL），消費需原子 GETDEL。 */
export interface NonceKVLike {
  set(
    key: string,
    value: unknown,
    opts?: { nx?: boolean; ex?: number }
  ): Promise<unknown>;
  getdel<T>(key: string): Promise<T | null>;
}

export interface NonceStoreDeps {
  kv: NonceKVLike;
  now?: () => number;
  /** 產生高熵 nonce；預設 32 bytes base64url。測試可注入決定性值。 */
  randomNonce?: () => string;
  ttlSec?: number;
}

function nonceKey(nonce: string): string {
  return `auth:nonce:${nonce}`;
}

function defaultRandomNonce(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 發放一枚一次性 nonce（server-bound）並回傳其原文，供 client 帶進 Google 登入。 */
export async function issueNonce(deps: NonceStoreDeps): Promise<string> {
  const nonce = (deps.randomNonce ?? defaultRandomNonce)();
  const issuedAt = (deps.now ?? (() => Date.now()))();
  await deps.kv.set(nonceKey(nonce), { issuedAt }, {
    nx: true,
    ex: deps.ttlSec ?? NONCE_TTL_SEC,
  });
  return nonce;
}

/**
 * 原子消費一枚 nonce。只有「存在且此刻被本次呼叫刪除」才回 true（一次性放行）；
 * 空字串 / 不存在 / 已被消費 / 過期一律回 false（呼叫端據此 fail-closed）。
 */
export async function consumeNonce(
  deps: NonceStoreDeps,
  nonce: string | null | undefined
): Promise<boolean> {
  if (typeof nonce !== 'string' || nonce.length === 0) return false;
  const record = await deps.kv.getdel<{ issuedAt: number }>(nonceKey(nonce));
  return record != null;
}
