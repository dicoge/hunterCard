/**
 * In-memory stand-in for `@vercel/kv`, used by scripts/test-price-alert-run.mjs
 * so the real serverless handler can be exercised end-to-end without KV
 * credentials or any network access.
 *
 * Only the commands api/_lib/kv-storage.ts actually issues are implemented, plus
 * the one Lua script it EVALs (interpreted here by shape, not by running Lua).
 */
const hashes = new Map();
const sets = new Map();
const strings = new Map();
let clockSkewMs = 0;

function hash(key) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  return hashes.get(key);
}

function set(key) {
  if (!sets.has(key)) sets.set(key, new Set());
  return sets.get(key);
}

function nowMs() {
  return Date.now() + clockSkewMs;
}

/** The live entry for a string key, dropping it first if its TTL has passed. */
function liveString(key) {
  const entry = strings.get(key);
  if (!entry) return null;
  if (entry.expiresAt !== null && entry.expiresAt <= nowMs()) {
    strings.delete(key);
    return null;
  }
  return entry;
}

export function resetKv() {
  hashes.clear();
  sets.clear();
  strings.clear();
  clockSkewMs = 0;
}

/** Jump the fixture's clock forward so a PX lease expires without a real wait. */
export function advanceKvClock(ms) {
  clockSkewMs += ms;
}

export function kvSnapshot() {
  return {
    hashes: Object.fromEntries([...hashes].map(([k, v]) => [k, Object.fromEntries(v)])),
    sets: Object.fromEntries([...sets].map(([k, v]) => [k, [...v]])),
    strings: Object.fromEntries([...strings].map(([k, v]) => [k, v.value])),
  };
}

export const kv = {
  async hset(key, patch) {
    for (const [field, value] of Object.entries(patch)) hash(key).set(field, value);
  },
  async hget(key, field) {
    return hash(key).get(field) ?? null;
  },
  async hgetall(key) {
    const map = hash(key);
    return map.size === 0 ? null : Object.fromEntries(map);
  },
  async hmget(key, ...fields) {
    const map = hash(key);
    return Object.fromEntries(fields.map((f) => [f, map.get(f) ?? null]));
  },
  async hdel(key, field) {
    return hash(key).delete(field) ? 1 : 0;
  },
  async hlen(key) {
    return hash(key).size;
  },
  async sadd(key, member) {
    set(key).add(member);
  },
  async srem(key, member) {
    set(key).delete(member);
  },
  async smembers(key) {
    return [...set(key)];
  },
  // SET with the NX / PX options the alert send claim relies on. The whole body
  // runs synchronously, so — exactly like a real single-threaded Redis — two
  // interleaved callers can never both observe the key as absent.
  async set(key, value, options = {}) {
    if (options.nx && liveString(key)) return null;
    const expiresAt = typeof options.px === 'number' ? nowMs() + options.px : null;
    strings.set(key, { value, expiresAt });
    return 'OK';
  },
  async get(key) {
    return liveString(key)?.value ?? null;
  },
  async del(key) {
    return strings.delete(key) ? 1 : 0;
  },
  // REMOVE_PRICE_ALERT: HDEL the alert, drop the token from the registry when
  // the hash is now empty, return the remaining length.
  async eval(_script, [hashKey, registryKey], [field, token]) {
    hash(hashKey).delete(field);
    if (hash(hashKey).size === 0) set(registryKey).delete(token);
    return hash(hashKey).size;
  },
};
