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

function hash(key) {
  if (!hashes.has(key)) hashes.set(key, new Map());
  return hashes.get(key);
}

function set(key) {
  if (!sets.has(key)) sets.set(key, new Set());
  return sets.get(key);
}

export function resetKv() {
  hashes.clear();
  sets.clear();
}

export function kvSnapshot() {
  return {
    hashes: Object.fromEntries([...hashes].map(([k, v]) => [k, Object.fromEntries(v)])),
    sets: Object.fromEntries([...sets].map(([k, v]) => [k, [...v]])),
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
  // REMOVE_PRICE_ALERT: HDEL the alert, drop the token from the registry when
  // the hash is now empty, return the remaining length.
  async eval(_script, [hashKey, registryKey], [field, token]) {
    hash(hashKey).delete(field);
    if (hash(hashKey).size === 0) set(registryKey).delete(token);
    return hash(hashKey).size;
  },
};
