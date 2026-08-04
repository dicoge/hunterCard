/**
 * POST /api/auth/nonce  → 200 { nonce }
 *
 * 發放一枚 server-bound 一次性登入挑戰 nonce（DIC-665 CR）。client 取得後必須把它帶進
 * native Google 登入（使其寫入 id_token 的 `nonce` claim），再連同 id_token 送
 * /api/auth/login；後端登入時原子消費並要求相等。見 api/_lib/nonce-store.ts。
 *
 * fail-closed：KV 未設定時不發 nonce（回 501），登入端點也就無從通過 nonce 檢查。
 */
import { kv } from '@vercel/kv';

import { issueNonce, type NonceKVLike } from '../_lib/nonce-store';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') {
    return json({ error: 'method_not_allowed' }, 405);
  }

  if (!process.env.KV_REST_API_URL) {
    return json({ error: 'NONCE_STORE_NOT_CONFIGURED' }, 501);
  }

  try {
    const nonce = await issueNonce({ kv: kv as unknown as NonceKVLike });
    return json({ nonce }, 200);
  } catch {
    return json({ error: 'NONCE_ISSUE_FAILED' }, 500);
  }
}
