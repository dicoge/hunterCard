import { kv } from '@vercel/kv';

export type Platform = 'ios' | 'android';

export type PushToken = {
  token: string;
  platform: Platform;
  createdAt: string;
  updatedAt: string;
};

export type PushWatchlist = Record<string, string[]>;

const TOKENS_KEY = 'push:tokens';
// Each token's watchlist is its own Redis set (`push:watchlist:<token>`) so
// add/remove use atomic SADD/SREM instead of read-modify-write on a shared
// hash field. `WATCHLIST_TOKENS_KEY` is a registry set of every token that has
// a watchlist, so notify.ts can still enumerate all subscribers (DIC-390 CR).
const WATCHLIST_PREFIX = 'push:watchlist:';
const WATCHLIST_TOKENS_KEY = 'push:watchlist-tokens';
const LAST_ALERT_KEY = 'push:last-alert';

function watchlistKey(token: string): string {
  return `${WATCHLIST_PREFIX}${token}`;
}

// Each token is stored as its own hash field, so concurrent registrations for
// different devices never clobber one another (the old whole-file GitHub write
// had a read-modify-write race, MUL-DIC-390).
export async function upsertToken(token: string, platform: Platform): Promise<void> {
  const now = new Date().toISOString();
  const existing = await kv.hget<PushToken>(TOKENS_KEY, token);
  const entry: PushToken = existing
    ? { ...existing, platform, updatedAt: now }
    : { token, platform, createdAt: now, updatedAt: now };
  await kv.hset(TOKENS_KEY, { [token]: entry });
}

export async function getWatchlistForToken(token: string): Promise<string[]> {
  const cards = (await kv.smembers(watchlistKey(token))) as string[] | null;
  return (cards ?? []).sort();
}

// Atomically add a card to the token's watchlist. Concurrent adds/removes for
// different cards on the same token no longer clobber each other.
export async function addWatchlistCard(token: string, cardNumber: string): Promise<string[]> {
  await kv.sadd(watchlistKey(token), cardNumber);
  await kv.sadd(WATCHLIST_TOKENS_KEY, token);
  return getWatchlistForToken(token);
}

// Atomically remove a card. Redis drops the set key once it is empty; the stale
// registry entry is cleaned up lazily on the next getWatchlist() read.
export async function removeWatchlistCard(token: string, cardNumber: string): Promise<string[]> {
  await kv.srem(watchlistKey(token), cardNumber);
  return getWatchlistForToken(token);
}

// Atomically re-checks each candidate token's set is still empty (SCARD == 0)
// before dropping it from the registry. Because Redis runs the whole script
// single-threaded, there is no window between the emptiness check and the SREM,
// so a token that a concurrent addWatchlistCard() just populated can never be
// clobbered out of the registry (DIC-420 TOCTOU fix). KEYS[1] is the registry,
// KEYS[i+1] is the set key for ARGV[i]. Returns the count actually removed.
const CLEANUP_STALE_TOKENS = `
local removed = 0
for i = 1, #ARGV do
  if redis.call('SCARD', KEYS[i + 1]) == 0 then
    redis.call('SREM', KEYS[1], ARGV[i])
    removed = removed + 1
  end
end
return removed
`;

export async function getWatchlist(): Promise<PushWatchlist> {
  const tokens = ((await kv.smembers(WATCHLIST_TOKENS_KEY)) as string[] | null) ?? [];
  const result: PushWatchlist = {};
  const stale: string[] = [];
  for (const token of tokens) {
    const cards = ((await kv.smembers(watchlistKey(token))) as string[] | null) ?? [];
    if (cards.length > 0) result[token] = cards;
    else stale.push(token);
  }
  // The smembers reads above are a non-atomic snapshot; re-verify emptiness
  // inside a Lua script so a card added between the read and the cleanup keeps
  // its token in the registry (DIC-420). A token left here is picked up on the
  // next notify enumeration — the only invariant that matters is never dropping
  // a token that currently has cards.
  if (stale.length > 0) {
    const keys = [WATCHLIST_TOKENS_KEY, ...stale.map(watchlistKey)];
    await kv.eval(CLEANUP_STALE_TOKENS, keys, stale);
  }
  return result;
}

// Cooldown is tracked per recipient+card (see notify.ts), so `keys` are opaque
// composite `<token>|<cardNumber>` strings, not bare card numbers.
export async function getLastAlertTimes(keys: string[]): Promise<Record<string, number>> {
  if (keys.length === 0) return {};
  const values = await kv.hmget<Record<string, number>>(LAST_ALERT_KEY, ...keys);
  return values ?? {};
}

export async function setLastAlertTimes(keys: string[], timestamp: number): Promise<void> {
  if (keys.length === 0) return;
  const patch: Record<string, number> = {};
  for (const key of keys) patch[key] = timestamp;
  await kv.hset(LAST_ALERT_KEY, patch);
}
