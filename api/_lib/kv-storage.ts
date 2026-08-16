import { kv } from '@vercel/kv';
import type { PriceAlert, AlertArmState } from '../../src/utils/priceAlerts';

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

// ── Exact-version desired-price alerts (DIC-1023) ───────────────────────────
//
// Stored separately from the card-number trend watchlist above: identity here is
// `cardNumber|PRINTING` and the record carries a desired interval, so the two
// semantics can never be confused for one another. One hash per token
// (`push:price-alerts:<token>`, field = alert key) so add/remove of one alert
// never rewrites the device's other alerts, plus a registry set so the
// evaluator can enumerate subscribers.

const PRICE_ALERT_PREFIX = 'push:price-alerts:';
const PRICE_ALERT_TOKENS_KEY = 'push:price-alert-tokens';
const PRICE_ALERT_STATE_KEY = 'push:price-alert-state';
const PRICE_ALERT_CLAIM_PREFIX = 'push:price-alert-claim:';

/** How long one runner may hold a send claim before another may take it over.
 * Bounds crash recovery: a runner that dies mid-send suppresses its alert for at
 * most this long, instead of forever. Far longer than an Expo batch call. */
export const ALERT_CLAIM_LEASE_MS = 5 * 60_000;

function priceAlertsKey(token: string): string {
  return `${PRICE_ALERT_PREFIX}${token}`;
}

function alertClaimKey(stateKey: string): string {
  return `${PRICE_ALERT_CLAIM_PREFIX}${stateKey}`;
}

export async function getPriceAlertsForToken(token: string): Promise<PriceAlert[]> {
  const entries = await kv.hgetall<Record<string, PriceAlert>>(priceAlertsKey(token));
  return Object.values(entries ?? {}).sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
}

export async function countPriceAlertsForToken(token: string): Promise<number> {
  return (await kv.hlen(priceAlertsKey(token))) ?? 0;
}

/** Upsert one alert and DROP its arm state: an explicit user edit re-arms the
 * alert, so a price already sitting inside the new interval notifies once. */
export async function upsertPriceAlert(token: string, key: string, alert: PriceAlert): Promise<void> {
  await kv.hset(priceAlertsKey(token), { [key]: alert });
  await kv.sadd(PRICE_ALERT_TOKENS_KEY, token);
  await releaseAlertClaim(`${token}|${key}`);
  await kv.hdel(PRICE_ALERT_STATE_KEY, `${token}|${key}`);
}

// Same TOCTOU-safe shape as REMOVE_WATCHLIST_CARD: the emptiness check and the
// registry SREM happen inside one atomic script, so a concurrent upsert can
// never leave a token with alerts missing from the registry.
// KEYS[1] = the token's alert hash, KEYS[2] = registry; ARGV[1] = alert key,
// ARGV[2] = token.
const REMOVE_PRICE_ALERT = `
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
end
return redis.call('HLEN', KEYS[1])
`;

export async function removePriceAlert(token: string, key: string): Promise<void> {
  await kv.eval(REMOVE_PRICE_ALERT, [priceAlertsKey(token), PRICE_ALERT_TOKENS_KEY], [key, token]);
  await releaseAlertClaim(`${token}|${key}`);
  await kv.hdel(PRICE_ALERT_STATE_KEY, `${token}|${key}`);
}

/** Every subscriber's alerts. Pure read — registry cleanup lives only in
 * removePriceAlert, so this can never race a concurrent upsert. */
export async function getAllPriceAlerts(): Promise<Record<string, PriceAlert[]>> {
  const tokens = ((await kv.smembers(PRICE_ALERT_TOKENS_KEY)) as string[] | null) ?? [];
  const out: Record<string, PriceAlert[]> = {};
  for (const token of tokens) {
    const alerts = await getPriceAlertsForToken(token);
    if (alerts.length > 0) out[token] = alerts;
  }
  return out;
}

export async function getAlertArmStates(keys: string[]): Promise<Record<string, AlertArmState>> {
  if (keys.length === 0) return {};
  const values = await kv.hmget<Record<string, AlertArmState>>(PRICE_ALERT_STATE_KEY, ...keys);
  const out: Record<string, AlertArmState> = {};
  for (const [key, value] of Object.entries(values ?? {})) {
    if (value && typeof value === 'object') out[key] = value;
  }
  return out;
}

export async function setAlertArmStates(patch: Record<string, AlertArmState>): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  await kv.hset(PRICE_ALERT_STATE_KEY, patch);
}

// ── Send claims ─────────────────────────────────────────────────────────────
//
// The arm state above is read-modify-write, so two overlapping evaluator runs
// can both observe the same alert as armed and both notify before either
// disarm lands (DIC-1025). The claim below is the atomic gate that decides who
// may actually call Expo for one alert: a single `SET NX PX` per
// `<token>|<cardNumber>|<PRINTING>`, so exactly one runner can win regardless of
// how the two runs interleave.
//
// Claim lifetime mirrors one arming episode:
//   absent   → nobody is sending and nobody has sent since the last re-arm
//   <lease>  → a runner is mid-send; auto-expires so a crash cannot suppress
//              the alert for more than ALERT_CLAIM_LEASE_MS
//   'sent'   → a confirmed Expo ticket ended this episode; persistent (no TTL)
//              so an expired lease can never grant a second send. Cleared only
//              by a re-arm, an explicit user edit, or removal.

/** Try to become the one runner allowed to notify this alert. */
export async function claimAlertSend(stateKey: string): Promise<boolean> {
  const claimed = await kv.set(alertClaimKey(stateKey), Date.now(), {
    nx: true,
    px: ALERT_CLAIM_LEASE_MS,
  });
  return claimed === 'OK';
}

/** Give the claim back so the very next run can retry — used when Expo did not
 * confirm the delivery, and as best-effort cleanup when a run fails outright. */
export async function releaseAlertClaim(stateKey: string): Promise<void> {
  await kv.del(alertClaimKey(stateKey));
}

/** Close the episode after a confirmed Expo `ok` ticket. Call this only AFTER
 * the matching `armed: false` has been persisted: the reverse order could leave
 * an alert armed but permanently claimed if the run died in between. */
export async function commitAlertClaim(stateKey: string): Promise<void> {
  await kv.set(alertClaimKey(stateKey), 'sent');
}
