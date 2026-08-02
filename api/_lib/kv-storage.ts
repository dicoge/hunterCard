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

// Atomically removes a card and, in the same single-threaded script, drops the
// token from the registry iff its set is now empty. Doing the emptiness check
// and the registry SREM inside one script closes the TOCTOU window: a concurrent
// addWatchlistCard() adds the card (SADD set) before it re-adds the registry
// entry (SADD registry), so at the atomic moment this script runs the set is
// either non-empty (SCARD > 0, registry kept) or the add hasn't populated it yet
// (registry dropped here, then re-added by the add's own registry SADD). Either
// way a token that currently has cards can never be clobbered out of the
// registry. KEYS[1] = set key, KEYS[2] = registry; ARGV[1] = card, ARGV[2] =
// token. Returns the set's remaining cardinality.
const REMOVE_WATCHLIST_CARD = `
redis.call('SREM', KEYS[1], ARGV[1])
if redis.call('SCARD', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
end
return redis.call('SCARD', KEYS[1])
`;

export async function removeWatchlistCard(token: string, cardNumber: string): Promise<string[]> {
  await kv.eval(REMOVE_WATCHLIST_CARD, [watchlistKey(token), WATCHLIST_TOKENS_KEY], [cardNumber, token]);
  return getWatchlistForToken(token);
}

// Pure read: enumerate the registry and return every token that currently has
// cards. Registry cleanup lives entirely in removeWatchlistCard (the only path
// that can empty a set), so this function never mutates KV and therefore cannot
// race with a concurrent addWatchlistCard() — a token whose set is transiently
// empty (mid add/remove) simply contributes nothing this cycle and is picked up
// on the next enumeration (DIC-428 read-path race fix).
export async function getWatchlist(): Promise<PushWatchlist> {
  const tokens = ((await kv.smembers(WATCHLIST_TOKENS_KEY)) as string[] | null) ?? [];
  const result: PushWatchlist = {};
  for (const token of tokens) {
    const cards = ((await kv.smembers(watchlistKey(token))) as string[] | null) ?? [];
    if (cards.length > 0) result[token] = cards;
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
