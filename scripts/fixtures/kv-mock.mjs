/**
 * In-memory stand-in for `@vercel/kv`, used by scripts/test-price-alert-run.mjs
 * so the real serverless handler can be exercised end-to-end without KV
 * credentials or any network access.
 *
 * Only the commands api/_lib/kv-storage.ts actually issues are implemented, plus
 * the Lua scripts it EVALs. Those are dispatched on the `-- @script <name>`
 * marker in the source and interpreted here by shape, not by running Lua.
 */
const hashes = new Map();
const sets = new Map();
const strings = new Map();
let clockSkewMs = 0;
let hook = null;

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

/** Remaining lease in ms, using Redis' PTTL convention: -1 = no expiry. */
function pttl(key) {
  const entry = liveString(key);
  if (!entry) return -2;
  if (entry.expiresAt === null) return -1;
  return entry.expiresAt - nowMs();
}

function writeString(key, value, px) {
  strings.set(key, { value, expiresAt: typeof px === 'number' ? nowMs() + px : null });
}

export function resetKv() {
  hashes.clear();
  sets.clear();
  strings.clear();
  clockSkewMs = 0;
  hook = null;
}

/** Jump the fixture's clock forward so a PX lease expires without a real wait. */
export function advanceKvClock(ms) {
  clockSkewMs += ms;
}

/**
 * Install an async seam the mock awaits BEFORE running a command, so a test can
 * park a real handler at an exact point between two KV round trips. It only
 * delays a command, never splits one: an `eval` still runs atomically once it
 * starts, exactly like a real single-threaded Redis.
 *
 * `hook(command, ...args)` — return a promise to park, anything else to pass
 * straight through.
 */
export function setKvHook(fn) {
  hook = fn;
}

export function kvSnapshot() {
  return {
    hashes: Object.fromEntries([...hashes].map(([k, v]) => [k, Object.fromEntries(v)])),
    sets: Object.fromEntries([...sets].map(([k, v]) => [k, [...v]])),
    strings: Object.fromEntries([...strings].map(([k, v]) => [k, v.value])),
  };
}

/** Retire the claim of the episode being replaced — the SUPERSEDE_EPISODE
 * fragment shared by the upsert and remove scripts. A live lease is only
 * marked, never dropped, so its remaining TTL keeps a second sender out. */
function supersedeEpisode(episodeKey) {
  const claim = liveString(episodeKey)?.value ?? null;
  if (claim === null) return;
  const ttl = pttl(episodeKey);
  if (ttl <= 0) {
    strings.delete(episodeKey);
  } else if (claim.slice(0, 2) === 'o:') {
    writeString(episodeKey, `x:${claim.slice(2)}`, ttl);
  }
}

/** Mirrors the `'${NO_REVISION}'` literal the claim script falls back to. */
const NO_REVISION = '0';

const SCRIPTS = {
  'remove-watchlist-card'([setKey, registryKey], [card, token]) {
    set(setKey).delete(card);
    if (set(setKey).size === 0) set(registryKey).delete(token);
    return set(setKey).size;
  },

  'upsert-price-alert'([hashKey, registryKey, episodeKey, revKey], [field, alertJson, token, rev]) {
    // The real client auto-deserializes JSON on read, so store the parsed
    // object the way hgetall would hand it back.
    hash(hashKey).set(field, JSON.parse(alertJson));
    hash(revKey).set(field, rev);
    set(registryKey).add(token);
    supersedeEpisode(episodeKey);
    return 1;
  },

  'remove-price-alert'([hashKey, registryKey, episodeKey, revKey], [field, token]) {
    hash(hashKey).delete(field);
    hash(revKey).delete(field);
    if (hash(hashKey).size === 0) set(registryKey).delete(token);
    supersedeEpisode(episodeKey);
    return hash(hashKey).size;
  },

  'claim-alert-send'([episodeKey, revKey], [field, rev, owner, leaseMs]) {
    if ((hash(revKey).get(field) ?? NO_REVISION) !== rev) return 2;
    if (liveString(episodeKey)) return 0;
    writeString(episodeKey, `o:${rev}:${owner}`, Number(leaseMs));
    return 1;
  },

  'release-alert-claim'([episodeKey], [rev, owner]) {
    const claim = liveString(episodeKey)?.value ?? null;
    if (claim === `o:${rev}:${owner}` || claim === `x:${rev}:${owner}`) {
      return strings.delete(episodeKey) ? 1 : 0;
    }
    return 0;
  },

  'commit-alert-claim'([episodeKey], [rev, owner, notifiedAt, price]) {
    const claim = liveString(episodeKey)?.value ?? null;
    if (claim === `o:${rev}:${owner}`) {
      writeString(episodeKey, `s:${rev}:${notifiedAt}:${price}`, null);
      return 1;
    }
    if (claim === `x:${rev}:${owner}`) {
      strings.delete(episodeKey);
      return 2;
    }
    return 0;
  },

  'rearm-alert-episode'([episodeKey], [rev]) {
    const claim = liveString(episodeKey)?.value ?? null;
    if (claim !== null && claim.startsWith(`s:${rev}:`)) {
      return strings.delete(episodeKey) ? 1 : 0;
    }
    return 0;
  },
};

const commands = {
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
  async mget(...keys) {
    return keys.map((key) => liveString(key)?.value ?? null);
  },
  async set(key, value, options = {}) {
    if (options.nx && liveString(key)) return null;
    writeString(key, value, options.px);
    return 'OK';
  },
  async get(key) {
    return liveString(key)?.value ?? null;
  },
  async del(key) {
    return strings.delete(key) ? 1 : 0;
  },
  // Dispatch on the `-- @script <name>` marker kv-storage.ts tags every script
  // with. Each body below runs synchronously, so — exactly like a real
  // single-threaded Redis — no two interleaved callers can observe a partial
  // episode transition.
  async eval(script, keys, argv) {
    const name = /--\s*@script\s+([\w-]+)/.exec(script)?.[1];
    const run = name && SCRIPTS[name];
    if (!run) throw new Error(`kv-mock: unknown Lua script${name ? ` "${name}"` : ''}`);
    return run(keys, argv);
  },
};

export const kv = Object.fromEntries(
  Object.entries(commands).map(([name, fn]) => [name, async (...args) => {
    if (hook) await hook(name, ...args);
    return fn(...args);
  }]),
);
