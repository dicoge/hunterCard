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
const WATCHLIST_KEY = 'push:watchlist';
const LAST_ALERT_KEY = 'push:last-alert';

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
  return (await kv.hget<string[]>(WATCHLIST_KEY, token)) ?? [];
}

export async function setWatchlistForToken(token: string, cards: string[]): Promise<void> {
  await kv.hset(WATCHLIST_KEY, { [token]: cards });
}

export async function removeWatchlistToken(token: string): Promise<void> {
  await kv.hdel(WATCHLIST_KEY, token);
}

export async function getWatchlist(): Promise<PushWatchlist> {
  return (await kv.hgetall<PushWatchlist>(WATCHLIST_KEY)) ?? {};
}

export async function getLastAlertTimes(cardNumbers: string[]): Promise<Record<string, number>> {
  if (cardNumbers.length === 0) return {};
  const values = await kv.hmget<Record<string, number>>(LAST_ALERT_KEY, ...cardNumbers);
  return values ?? {};
}

export async function setLastAlertTimes(cardNumbers: string[], timestamp: number): Promise<void> {
  if (cardNumbers.length === 0) return;
  const patch: Record<string, number> = {};
  for (const cardNumber of cardNumbers) patch[cardNumber] = timestamp;
  await kv.hset(LAST_ALERT_KEY, patch);
}
