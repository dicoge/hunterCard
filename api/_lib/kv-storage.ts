import { randomUUID } from 'node:crypto';
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
-- @script remove-watchlist-card
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
const PRICE_ALERT_EPISODE_PREFIX = 'push:price-alert-episode:';

/** How long one runner may hold a send claim before another may take it over.
 * Bounds crash recovery: a runner that dies mid-send suppresses its alert for at
 * most this long, instead of forever. Far longer than an Expo batch call. */
export const ALERT_CLAIM_LEASE_MS = 5 * 60_000;

function priceAlertsKey(token: string): string {
  return `${PRICE_ALERT_PREFIX}${token}`;
}

// ── Alert episode state ─────────────────────────────────────────────────────
//
// One key per exact alert (`<token>|<cardNumber>|<PRINTING>`) holds the WHOLE
// dedupe state: whether the alert is armed, who is currently allowed to notify,
// and whether this visit was already delivered. Keeping it in a single key is
// what makes the transitions atomic — an earlier split between an arm-state
// hash and a claim key meant an edit could expose a re-armed alert before its
// claim was reset, letting a second evaluator send again (DIC-1025).
//
// Values, all written and compared only by the Lua scripts below:
//   absent          armed, nobody sending
//   o:<owner>       armed, <owner> is mid-send; PX lease bounds a crash
//   x:<owner>       armed, <owner>'s send was superseded by an episode
//                   transition — it may release, never commit. Keeps the
//                   remaining lease so no second sender starts while the
//                   superseded one is still in flight.
//   s:<ms>:<price>  delivered, so this alert is disarmed until it re-arms.
//                   Persistent: no lease expiry can resurrect it into a
//                   second notification.
//
// `<owner>` is a per-attempt UUID. Release and commit compare against it, so a
// runner whose lease was taken over or superseded can never clean up or
// disarm on the current owner's behalf.

function alertEpisodeKey(stateKey: string): string {
  return `${PRICE_ALERT_EPISODE_PREFIX}${stateKey}`;
}

/** Retire the claim of the episode being replaced. A delivered episode is
 * cleared outright so the new one can fire; a live lease is only marked
 * superseded, because dropping it would let a second runner notify while the
 * first is still inside its Expo call. */
const SUPERSEDE_EPISODE = `
local claim = redis.call('GET', KEYS[3])
if claim then
  local ttl = redis.call('PTTL', KEYS[3])
  if ttl <= 0 then
    redis.call('DEL', KEYS[3])
  elseif string.sub(claim, 1, 2) == 'o:' then
    redis.call('SET', KEYS[3], 'x:' .. string.sub(claim, 3), 'PX', ttl)
  end
end
`;

export async function getPriceAlertsForToken(token: string): Promise<PriceAlert[]> {
  const entries = await kv.hgetall<Record<string, PriceAlert>>(priceAlertsKey(token));
  return Object.values(entries ?? {}).sort(
    (a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing),
  );
}

export async function countPriceAlertsForToken(token: string): Promise<number> {
  return (await kv.hlen(priceAlertsKey(token))) ?? 0;
}

// Publishing the alert and retiring the episode it belongs to happen in ONE
// script: an evaluator can never observe the edited alert while the previous
// episode's claim is still standing, so an explicit edit cannot hand two
// runners a send for the same entry. KEYS[1] = the token's alert hash,
// KEYS[2] = registry, KEYS[3] = episode key; ARGV[1] = alert key,
// ARGV[2] = alert JSON, ARGV[3] = token.
const UPSERT_PRICE_ALERT = `
-- @script upsert-price-alert
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('SADD', KEYS[2], ARGV[3])
${SUPERSEDE_EPISODE}
return 1
`;

/** Upsert one alert and retire its episode: an explicit user edit re-arms the
 * alert, so a price already sitting inside the new interval notifies once. */
export async function upsertPriceAlert(token: string, key: string, alert: PriceAlert): Promise<void> {
  await kv.eval(
    UPSERT_PRICE_ALERT,
    [priceAlertsKey(token), PRICE_ALERT_TOKENS_KEY, alertEpisodeKey(`${token}|${key}`)],
    [key, JSON.stringify(alert), token],
  );
}

// Same TOCTOU-safe shape as REMOVE_WATCHLIST_CARD: the emptiness check and the
// registry SREM happen inside one atomic script, so a concurrent upsert can
// never leave a token with alerts missing from the registry. The episode is
// retired in the same script for the same reason as the upsert above.
// KEYS[1] = the token's alert hash, KEYS[2] = registry, KEYS[3] = episode key;
// ARGV[1] = alert key, ARGV[2] = token.
const REMOVE_PRICE_ALERT = `
-- @script remove-price-alert
redis.call('HDEL', KEYS[1], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
end
${SUPERSEDE_EPISODE}
return redis.call('HLEN', KEYS[1])
`;

export async function removePriceAlert(token: string, key: string): Promise<void> {
  await kv.eval(
    REMOVE_PRICE_ALERT,
    [priceAlertsKey(token), PRICE_ALERT_TOKENS_KEY, alertEpisodeKey(`${token}|${key}`)],
    [key, token],
  );
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

/** Arm state for each alert, derived from its episode key. Only a delivered
 * episode is disarmed; anything else (including a lease held by another runner)
 * is still armed, and the claim below is what stops a second send. */
export async function getAlertArmStates(keys: string[]): Promise<Record<string, AlertArmState>> {
  if (keys.length === 0) return {};
  const values = await kv.mget<(string | null)[]>(...keys.map(alertEpisodeKey));
  const out: Record<string, AlertArmState> = {};
  keys.forEach((key, i) => {
    const value = values?.[i];
    if (typeof value !== 'string' || !value.startsWith('s:')) return;
    const [, notifiedAt, price] = value.split(':');
    out[key] = { armed: false, lastNotifiedAt: Number(notifiedAt), lastPrice: Number(price) };
  });
  return out;
}

// ── Send claims ─────────────────────────────────────────────────────────────

// Become the one runner allowed to notify this alert. NX is what makes it
// exclusive; the lease is what stops a crashed runner from silencing the alert
// forever. KEYS[1] = episode key; ARGV[1] = owner, ARGV[2] = lease ms.
const CLAIM_ALERT_SEND = `
-- @script claim-alert-send
if redis.call('SET', KEYS[1], 'o:' .. ARGV[1], 'PX', ARGV[2], 'NX') then
  return 1
end
return 0
`;

// Compare-and-delete. A superseded owner may still clean up its own attempt,
// but neither form can touch a claim belonging to anyone else.
const RELEASE_ALERT_CLAIM = `
-- @script release-alert-claim
local claim = redis.call('GET', KEYS[1])
if claim == 'o:' .. ARGV[1] or claim == 'x:' .. ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// Compare-and-set. Only the current owner may disarm; an owner whose episode
// was replaced mid-send delivered a notification for a visit that no longer
// exists, so it drops its claim and leaves the new episode armed.
const COMMIT_ALERT_CLAIM = `
-- @script commit-alert-claim
local claim = redis.call('GET', KEYS[1])
if claim == 'o:' .. ARGV[1] then
  redis.call('SET', KEYS[1], 's:' .. ARGV[2] .. ':' .. ARGV[3])
  return 1
end
if claim == 'x:' .. ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 2
end
return 0
`;

// Re-arm on leaving the interval clears ONLY a delivered episode — it must not
// disturb a lease, whose alert is armed already.
const REARM_ALERT_EPISODE = `
-- @script rearm-alert-episode
local claim = redis.call('GET', KEYS[1])
if claim and string.sub(claim, 1, 2) == 's:' then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/** Try to become the one runner allowed to notify this alert. Returns the owner
 * token to fence every later mutation with, or null if someone else owns the
 * attempt or the alert was already delivered this visit. */
export async function claimAlertSend(stateKey: string): Promise<string | null> {
  const owner = randomUUID();
  const won = await kv.eval(
    CLAIM_ALERT_SEND,
    [alertEpisodeKey(stateKey)],
    [owner, String(ALERT_CLAIM_LEASE_MS)],
  );
  return won === 1 ? owner : null;
}

/** Give the claim back so the very next run can retry — used when Expo did not
 * confirm the delivery, and as best-effort cleanup when a run fails outright. */
export async function releaseAlertClaim(stateKey: string, owner: string): Promise<void> {
  await kv.eval(RELEASE_ALERT_CLAIM, [alertEpisodeKey(stateKey)], [owner]);
}

export type ClaimCommit =
  /** this runner still owned the episode: the alert is now disarmed */
  | 'committed'
  /** delivered, but the episode was replaced or taken over meanwhile, so the
   * alert stays armed for whoever owns it now */
  | 'superseded';

/** Close the episode after a confirmed Expo `ok` ticket. Disarming and closing
 * the claim are the same write, so no interruption can leave an alert armed
 * behind a claim that nothing will ever clear. */
export async function commitAlertClaim(
  stateKey: string, owner: string, notifiedAt: number, price: number,
): Promise<ClaimCommit> {
  const result = await kv.eval(
    COMMIT_ALERT_CLAIM,
    [alertEpisodeKey(stateKey)],
    [owner, String(notifiedAt), String(price)],
  );
  return result === 1 ? 'committed' : 'superseded';
}

/** Leaving the interval re-arms the alert for its next entry. */
export async function rearmAlertEpisode(stateKey: string): Promise<void> {
  await kv.eval(REARM_ALERT_EPISODE, [alertEpisodeKey(stateKey)], []);
}
