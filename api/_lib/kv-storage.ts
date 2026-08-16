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
// Revisions live in their own hash rather than inside the alert record: the
// claim script must compare one against the stored config atomically, and a
// bare string field is something Lua can compare without parsing JSON. It also
// keeps the revision out of the alert body the config API echoes back. Payload
// and revision are only ever written together, and only ever read together
// (LOAD_PRICE_ALERTS), so the pair a runner holds is always self-consistent.
const PRICE_ALERT_REV_PREFIX = 'push:price-alert-revs:';

/** How long one runner may hold a send claim before another may take it over.
 * Bounds crash recovery: a runner that dies mid-send suppresses its alert for at
 * most this long, instead of forever. Far longer than an Expo batch call. */
export const ALERT_CLAIM_LEASE_MS = 5 * 60_000;

function priceAlertsKey(token: string): string {
  return `${PRICE_ALERT_PREFIX}${token}`;
}

function alertRevsKey(token: string): string {
  return `${PRICE_ALERT_REV_PREFIX}${token}`;
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
//   absent                armed, nobody sending
//   o:<rev>:<owner>       armed, <owner> is mid-send for configuration <rev>;
//                         PX lease bounds a crash
//   x:<rev>:<owner>       armed, that send was superseded by an episode
//                         transition — it may release, never commit. Keeps the
//                         remaining lease so no second sender starts while the
//                         superseded one is still in flight.
//   s:<rev>:<ms>:<price>  <rev> was delivered, so this alert is disarmed until
//                         it re-arms. Persistent: no lease expiry can resurrect
//                         it into a second notification.
//
// `<owner>` is a per-attempt UUID and `<rev>` the configuration revision the
// runner evaluated. Every script compares BOTH, so neither a runner whose lease
// was taken over nor one holding a snapshot the user has since edited can clean
// up, disarm or re-arm on the current episode's behalf.
//
// Absence deliberately carries no revision — it means "armed at whatever the
// stored configuration is now". That is why the claim is the fence: it proves
// the alert still exists and still carries the evaluator's revision, in the
// same atomic script that takes the lease, so a snapshot read before a
// completed edit or delete can never be turned into a send (DIC-1025).

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

// Publishing the alert, stamping its new revision and retiring the episode it
// belongs to happen in ONE script: an evaluator can never observe the edited
// alert while the previous episode's claim is still standing, and can never
// observe a configuration whose revision has not caught up with it.
// KEYS[1] = the token's alert hash, KEYS[2] = registry, KEYS[3] = episode key,
// KEYS[4] = revision hash; ARGV[1] = alert key, ARGV[2] = alert JSON,
// ARGV[3] = token, ARGV[4] = the new revision.
const UPSERT_PRICE_ALERT = `
-- @script upsert-price-alert
redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
redis.call('HSET', KEYS[4], ARGV[1], ARGV[4])
redis.call('SADD', KEYS[2], ARGV[3])
${SUPERSEDE_EPISODE}
return 1
`;

/** Upsert one alert and retire its episode: an explicit user edit re-arms the
 * alert, so a price already sitting inside the new interval notifies once. The
 * fresh revision is what stops a runner still holding the previous snapshot
 * from claiming afterwards. */
export async function upsertPriceAlert(token: string, key: string, alert: PriceAlert): Promise<void> {
  await kv.eval(
    UPSERT_PRICE_ALERT,
    [
      priceAlertsKey(token), PRICE_ALERT_TOKENS_KEY,
      alertEpisodeKey(`${token}|${key}`), alertRevsKey(token),
    ],
    [key, JSON.stringify(alert), token, randomUUID()],
  );
}

// Same TOCTOU-safe shape as REMOVE_WATCHLIST_CARD: the emptiness check and the
// registry SREM happen inside one atomic script, so a concurrent upsert can
// never leave a token with alerts missing from the registry. The episode is
// retired in the same script for the same reason as the upsert above.
// KEYS[1] = the token's alert hash, KEYS[2] = registry, KEYS[3] = episode key,
// KEYS[4] = revision hash; ARGV[1] = alert key, ARGV[2] = token. Dropping the
// revision with the alert is what makes a delete fence a runner mid-send: its
// expected revision can no longer match anything.
const REMOVE_PRICE_ALERT = `
-- @script remove-price-alert
redis.call('HDEL', KEYS[1], ARGV[1])
redis.call('HDEL', KEYS[4], ARGV[1])
if redis.call('HLEN', KEYS[1]) == 0 then
  redis.call('SREM', KEYS[2], ARGV[2])
end
${SUPERSEDE_EPISODE}
return redis.call('HLEN', KEYS[1])
`;

export async function removePriceAlert(token: string, key: string): Promise<void> {
  await kv.eval(
    REMOVE_PRICE_ALERT,
    [
      priceAlertsKey(token), PRICE_ALERT_TOKENS_KEY,
      alertEpisodeKey(`${token}|${key}`), alertRevsKey(token),
    ],
    [key, token],
  );
}

/** One alert as the evaluator read it, tagged with the configuration revision
 * that snapshot came from. Every later write for this alert is fenced with it. */
export type StoredPriceAlert = PriceAlert & { rev: string };

// Read every alert of one token together with its revision in ONE script, as a
// flat `key, json, rev, ...` array. Reading the two hashes with two commands
// used to leave a window in which an edit landed between them: the runner then
// held the OLD payload beside the NEW revision, and its claim — which only
// compares the revision — waved that stale interval through (DIC-1025).
//
// An alert written before revisions existed is stamped here, inside the same
// atomic read, so every snapshot a runner can hold carries a real revision.
// Without it such an alert would have no revision any claim could match and
// would go silent forever. First reader wins; concurrent readers see its value.
// KEYS[1] = the token's alert hash, KEYS[2] = revision hash; ARGV[1] = seed for
// the revisions stamped by this call.
const LOAD_PRICE_ALERTS = `
-- @script load-price-alerts
local out = {}
local alerts = redis.call('HGETALL', KEYS[1])
for i = 1, #alerts, 2 do
  local field = alerts[i]
  local rev = redis.call('HGET', KEYS[2], field)
  if not rev then
    rev = ARGV[1] .. ':' .. field
    redis.call('HSET', KEYS[2], field, rev)
  end
  out[#out + 1] = field
  out[#out + 1] = alerts[i + 1]
  out[#out + 1] = rev
end
return out
`;

/** EVAL hands back the stored payload as the KV client's deserializer left it:
 * an object where it recognised JSON, the raw string otherwise. */
function parseStoredAlert(value: unknown): PriceAlert | null {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as PriceAlert;
    } catch {
      return null;
    }
  }
  return value !== null && typeof value === 'object' ? (value as PriceAlert) : null;
}

/** Every subscriber's alerts, each carrying the revision it was read at. The
 * payload/revision pair per alert comes from one atomic script, so it is always
 * self-consistent; it may be a moment out of date by the time it is used, and
 * that is exactly what the claim rejects. Registry cleanup lives only in
 * removePriceAlert, so enumerating tokens cannot race a concurrent upsert. */
export async function getAllPriceAlerts(): Promise<Record<string, StoredPriceAlert[]>> {
  const tokens = ((await kv.smembers(PRICE_ALERT_TOKENS_KEY)) as string[] | null) ?? [];
  const out: Record<string, StoredPriceAlert[]> = {};
  for (const token of tokens) {
    const flat = (await kv.eval(
      LOAD_PRICE_ALERTS,
      [priceAlertsKey(token), alertRevsKey(token)],
      [randomUUID()],
    )) as unknown[] | null;
    const alerts: StoredPriceAlert[] = [];
    for (let i = 0; i + 2 < (flat?.length ?? 0); i += 3) {
      const alert = parseStoredAlert(flat![i + 1]);
      if (alert) alerts.push({ ...alert, rev: String(flat![i + 2]) });
    }
    alerts.sort((a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing));
    if (alerts.length > 0) out[token] = alerts;
  }
  return out;
}

/** One alert's episode, identified by state key and the revision the caller
 * evaluated it at. */
export type AlertEpisodeRef = { stateKey: string; rev: string };

/** Arm state for each alert, derived from its episode key. Only an episode
 * delivered for THIS revision counts as disarmed — a delivery recorded against
 * a configuration the user has since replaced reads as armed, so an edit always
 * gets its own chance to fire. Anything else (including a lease held by another
 * runner) is armed too, and the claim below is what stops a second send. */
export async function getAlertArmStates(
  refs: readonly AlertEpisodeRef[],
): Promise<Record<string, AlertArmState>> {
  if (refs.length === 0) return {};
  const values = await kv.mget<(string | null)[]>(...refs.map((r) => alertEpisodeKey(r.stateKey)));
  const out: Record<string, AlertArmState> = {};
  refs.forEach(({ stateKey, rev }, i) => {
    const value = values?.[i];
    if (typeof value !== 'string' || !value.startsWith(`s:${rev}:`)) return;
    const [, , notifiedAt, price] = value.split(':');
    out[stateKey] = { armed: false, lastNotifiedAt: Number(notifiedAt), lastPrice: Number(price) };
  });
  return out;
}

// ── Send claims ─────────────────────────────────────────────────────────────

// Become the one runner allowed to notify this alert, for the exact
// configuration this runner evaluated. Proving the alert STILL EXISTS and its
// revision is unchanged, then taking the lease, all in ONE script, is the whole
// point: a runner that read its snapshot before an edit or a delete and only
// got here afterwards is turned away, so it can neither send under the
// configuration it holds nor disarm the one that replaced it.
//
// Existence is checked on its own rather than inferred from the revision: a
// missing revision must never read as "matches", which is how a deleted alert
// used to slip through. NX is what makes the claim exclusive; the lease is what
// stops a crashed runner from silencing the alert forever.
// KEYS[1] = episode key, KEYS[2] = the token's revision hash, KEYS[3] = the
// token's alert hash; ARGV[1] = alert key, ARGV[2] = expected revision,
// ARGV[3] = owner, ARGV[4] = lease ms.
const CLAIM_ALERT_SEND = `
-- @script claim-alert-send
if redis.call('HEXISTS', KEYS[3], ARGV[1]) == 0 then
  return 2
end
if redis.call('HGET', KEYS[2], ARGV[1]) ~= ARGV[2] then
  return 2
end
if redis.call('SET', KEYS[1], 'o:' .. ARGV[2] .. ':' .. ARGV[3], 'PX', ARGV[4], 'NX') then
  return 1
end
return 0
`;

// Compare-and-delete on revision AND owner. A superseded owner may still clean
// up its own attempt, but neither form can touch a claim belonging to anyone
// else or to a configuration that has moved on.
const RELEASE_ALERT_CLAIM = `
-- @script release-alert-claim
local claim = redis.call('GET', KEYS[1])
if claim == 'o:' .. ARGV[1] .. ':' .. ARGV[2] or claim == 'x:' .. ARGV[1] .. ':' .. ARGV[2] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

// Compare-and-set on revision AND owner. Only the runner that still owns this
// revision's episode may disarm it; one whose episode was replaced mid-send
// delivered a notification for a configuration that no longer exists, so it
// drops its claim and leaves the new episode armed.
const COMMIT_ALERT_CLAIM = `
-- @script commit-alert-claim
local claim = redis.call('GET', KEYS[1])
if claim == 'o:' .. ARGV[1] .. ':' .. ARGV[2] then
  redis.call('SET', KEYS[1], 's:' .. ARGV[1] .. ':' .. ARGV[3] .. ':' .. ARGV[4])
  return 1
end
if claim == 'x:' .. ARGV[1] .. ':' .. ARGV[2] then
  redis.call('DEL', KEYS[1])
  return 2
end
return 0
`;

// Re-arm on leaving the interval clears ONLY an episode delivered for the
// revision the caller evaluated. It must not disturb a lease (whose alert is
// armed already), nor a delivery belonging to a configuration this runner never
// saw. KEYS[1] = episode key; ARGV[1] = expected revision.
const REARM_ALERT_EPISODE = `
-- @script rearm-alert-episode
local prefix = 's:' .. ARGV[1] .. ':'
local claim = redis.call('GET', KEYS[1])
if claim and string.sub(claim, 1, string.len(prefix)) == prefix then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export type ClaimOutcome =
  /** this runner owns the episode and must fence every later write with `owner` */
  | { status: 'claimed'; owner: string }
  /** another runner is already sending this episode */
  | { status: 'contended' }
  /** the configuration was edited or deleted after this runner read it — the
   * snapshot in hand is stale, so it must not send */
  | { status: 'stale' };

/** Try to become the one runner allowed to notify this alert, for the exact
 * configuration this runner evaluated. */
export async function claimAlertSend(
  token: string, key: string, rev: string,
): Promise<ClaimOutcome> {
  const owner = randomUUID();
  const result = await kv.eval(
    CLAIM_ALERT_SEND,
    [alertEpisodeKey(`${token}|${key}`), alertRevsKey(token), priceAlertsKey(token)],
    [key, rev, owner, String(ALERT_CLAIM_LEASE_MS)],
  );
  if (result === 1) return { status: 'claimed', owner };
  return result === 2 ? { status: 'stale' } : { status: 'contended' };
}

/** Give the claim back so the very next run can retry — used when Expo did not
 * confirm the delivery, and as best-effort cleanup when a run fails outright. */
export async function releaseAlertClaim(
  stateKey: string, rev: string, owner: string,
): Promise<void> {
  await kv.eval(RELEASE_ALERT_CLAIM, [alertEpisodeKey(stateKey)], [rev, owner]);
}

export type ClaimCommit =
  /** this runner still owned the episode: the alert is now disarmed */
  | 'committed'
  /** delivered, but the episode was replaced, edited or taken over meanwhile,
   * so the alert stays armed for whatever configuration is current now */
  | 'superseded';

/** Close the episode after a confirmed Expo `ok` ticket. Disarming and closing
 * the claim are the same write, so no interruption can leave an alert armed
 * behind a claim that nothing will ever clear. */
export async function commitAlertClaim(
  stateKey: string, rev: string, owner: string, notifiedAt: number, price: number,
): Promise<ClaimCommit> {
  const result = await kv.eval(
    COMMIT_ALERT_CLAIM,
    [alertEpisodeKey(stateKey)],
    [rev, owner, String(notifiedAt), String(price)],
  );
  return result === 1 ? 'committed' : 'superseded';
}

/** Leaving the interval re-arms the alert for its next entry. */
export async function rearmAlertEpisode(stateKey: string, rev: string): Promise<void> {
  await kv.eval(REARM_ALERT_EPISODE, [alertEpisodeKey(stateKey)], [rev]);
}
