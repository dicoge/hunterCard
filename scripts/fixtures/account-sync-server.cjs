/**
 * Local account-sync server for the two-device regression (v41,
 * scripts/test-account-sync-two-device.mjs). Runs the REAL api/auth/[action] handler
 * and api/_lib/account-sync-store (transpiled to CommonJS) over HTTP on 127.0.0.1,
 * with the same in-memory @vercel/kv emulation scripts/test-account-sync-backend.cjs
 * uses (incl. the ACCOUNT_SYNC_SAVE CAS / idempotency script). No network beyond
 * localhost, no real KV, no real Google identity: sessions are issued by the real
 * session signer for synthetic subjects.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const Module = require('node:module');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..', '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-sync-2dev-'));

const kvState = { values: new Map(), sets: new Map(), dels: [], beforeSyncSaveEval: null };

function resetKv() {
  kvState.values.clear();
  kvState.sets.clear();
  kvState.dels = [];
  kvState.beforeSyncSaveEval = null;
}

const kv = {
  async get(key) {
    const raw = kvState.values.get(key);
    if (typeof raw !== 'string') return raw ?? null;
    try { return JSON.parse(raw); } catch { return raw; }
  },
  async set(key, value, opts) {
    if (opts && opts.nx && kvState.values.has(key)) return null;
    kvState.values.set(key, value);
    return 'OK';
  },
  async del(...keys) {
    let deleted = 0;
    for (const key of keys) {
      kvState.dels.push(key);
      const had = kvState.values.delete(key) || kvState.sets.delete(key);
      if (had) deleted += 1;
    }
    return deleted;
  },
  async sadd(key, ...members) {
    const set = kvState.sets.get(key) ?? new Set();
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) added += 1;
      set.add(m);
    }
    kvState.sets.set(key, set);
    return added;
  },
  async smembers(key) {
    const set = kvState.sets.get(key);
    return set ? [...set] : [];
  },
  async expire() {
    return 1;
  },
  async *scanIterator(options = {}) {
    const prefix = String(options.match || '').replace(/\*$/, '');
    for (const key of kvState.values.keys()) {
      if (!options.match || key.startsWith(prefix)) {
        yield key;
      }
    }
  },
  async eval(script, keys, args) {
    if (script.includes("return 'LOCK_LOST'")) {
      if (kvState.values.get(keys[0]) !== args[0]) return 'LOCK_LOST';
      if (script.includes('-- PUBLISH')) {
        if (kvState.values.has(keys[1])) return 'EXISTS';
        kvState.values.set(keys[1], args[1]);
        return 'OK';
      }
      if (script.includes('-- SET')) {
        kvState.values.set(keys[1], JSON.parse(args[1]));
        return 'OK';
      }
      if (script.includes('-- DELUSER')) {
        const n = Number(args[2]);
        for (let i = 0; i < n; i++) {
          const idxKey = keys[1 + i * 2];
          const detailKey = keys[2 + i * 2];
          const owner = args[3 + i];
          if (kvState.values.get(idxKey) === owner) kvState.values.delete(idxKey);
          kvState.values.delete(detailKey);
        }
        const identitiesKey = keys[1 + n * 2];
        const userKey = keys[2 + n * 2];
        kvState.values.delete(identitiesKey);
        kvState.sets.delete(identitiesKey);
        kvState.values.delete(userKey);
        return 'OK';
      }
      if (script.includes('-- STAGE')) {
        // KEYS = [lock, detail, identities]; ARGV = [token, ttl, detailJson, member]
        // stage a link: SET detail + SADD member
        kvState.values.set(keys[1], JSON.parse(args[2]));
        const set = kvState.sets.get(keys[2]) ?? new Set();
        set.add(args[3]);
        kvState.sets.set(keys[2], set);
        return 'OK';
      }
      if (script.includes('-- ROLLBACK')) {
        // KEYS = [lock, idx, detail, identities]; ARGV = [token, ttl, idxOwner, member]
        if (kvState.values.get(keys[1]) === args[2]) kvState.values.delete(keys[1]);
        kvState.values.delete(keys[2]);
        const setR = kvState.sets.get(keys[3]);
        if (setR) setR.delete(args[3]);
        return 'OK';
      }
      if (script.includes('-- UNLINK')) {
        // KEYS = [lock, idx, detail, identities, user]
        // ARGV = [token, ttl, idxOwner, member, userJson]
        if (kvState.values.get(keys[1]) === args[2]) kvState.values.delete(keys[1]);
        kvState.values.delete(keys[2]);
        const setU = kvState.sets.get(keys[3]);
        if (setU) setU.delete(args[3]);
        kvState.values.set(keys[4], args[4]);
        return 'OK';
      }
      throw new Error(`unexpected fenced eval: ${script}`);
    }
    if (script.includes("redis.call('DEL', KEYS[1])")) {
      if (kvState.values.get(keys[0]) === args[0]) {
        kvState.values.delete(keys[0]);
        return 1;
      }
      return 0;
    }
    if (script.includes('-- ACCOUNT_SYNC_DELETE_BEGIN')) {
      kvState.values.set(keys[0], args[0]);
      return 'OK';
    }
    if (!script.includes('-- ACCOUNT_SYNC_SAVE')) throw new Error(`unexpected eval: ${script}`);
    if (kvState.beforeSyncSaveEval) await kvState.beforeSyncSaveEval();
    const [syncKey, idemKey, idemIndexKey] = keys;
    const [baseRevisionRaw, nextRaw] = args;
    if (kvState.values.has(keys[3])) return ['DELETED', '0', ''];
    const currentRaw = kvState.values.get(syncKey);
    const currentRevision = currentRaw ? JSON.parse(currentRaw).revision : 0;
    const idemRaw = kvState.values.get(idemKey);
    if (idemRaw) return ['IDEMPOTENT', String(currentRevision), idemRaw];
    if (currentRevision !== Number(baseRevisionRaw)) {
      return ['CONFLICT', String(currentRevision), currentRaw || ''];
    }
    kvState.values.set(syncKey, nextRaw);
    kvState.values.set(idemKey, nextRaw);
    await kv.sadd(idemIndexKey, idemKey);
    return ['OK', String(currentRevision + 1), nextRaw];
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const source = fs.readFileSync(input, 'utf8');
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}

// Full runtime import graph of the handlers below. DIC-1189 made session,
// identity-store, token-replay, apple-exchange-store and account-sync-store
// import the lane guards (appEnv -> env-guard -> kv-namespace), so those
// are compiled too; type-only imports are elided by transpileModule.
for (const rel of [
  'src/config/appEnv.ts',
  'api/_lib/env-guard.ts',
  'api/_lib/kv-namespace.ts',
  'api/_lib/session.ts',
  'api/_lib/identity-store.ts',
  'api/_lib/token-replay.ts',
  'api/_lib/verify-token.ts',
  'api/_lib/apple-web-oauth.ts',
  'api/_lib/apple-exchange-store.ts',
  'api/_lib/auth-endpoint.ts',
  'api/_lib/node-adapter.ts',
  'api/_lib/account-sync-store.ts',
  'api/_lib/apple-auth.ts',
  'api/_lib/apple-token-store.ts',
  'api/auth/[action].ts',
  'api/auth/delete-account.ts',
  'src/utils/scanSessionSync.ts',
]) compileTs(rel);



// The production lane, explicitly: the real lane guards (strict APP_ENV,
// payment boot guard, nsKey identity) run unmodified. Same pattern as the other
// DIC-1189 suites; `npm run test:account-sync-two-device` also sets it.
if (!process.env.APP_ENV) process.env.APP_ENV = 'production';
process.env.KV_REST_API_URL = 'https://kv.example';
process.env.KV_REST_API_TOKEN = 'kv-token';
process.env.AUTH_SESSION_SECRET = 'two-device-test-secret';

const { issueSession } = require(path.join(outDir, 'api/_lib/session.js'));
const nodeHandler = require(path.join(outDir, 'api/auth/[action].js')).default;
// Vercel serves the static sibling route before the dynamic [action] one.
const deleteHandler = require(path.join(outDir, 'api/auth/delete-account.js')).default;
const identityStore = require(path.join(outDir, 'api/_lib/identity-store.js'));

async function createSession(subject) {
  const { user } = await identityStore.loginOrCreate({ provider: 'google', subject, email: `${subject}@example.test` });
  return { user, session: issueSession(user.internalId) };
}

function start() {
  const log = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const nodeRes = {
        _status: 200, _headers: {}, _body: '',
        status(code) { this._status = code; return this; },
        setHeader(k, v) { this._headers[k.toLowerCase()] = v; return this; },
        send(b) { this._body = b == null ? '' : String(b); return this; },
        end(b) { if (b != null) this._body = String(b); return this; },
      };
      try {
        const handler = req.url.split('?')[0] === '/api/auth/delete-account' ? deleteHandler : nodeHandler;
        await handler({ method: req.method, url: req.url, headers: { ...req.headers, host: 'example.test' }, body }, nodeRes);
      } catch (e) {
        nodeRes._status = 500; nodeRes._body = JSON.stringify({ error: 'handler_threw' });
      }
      log.push({ method: req.method, url: req.url, status: nodeRes._status, auth: !!req.headers.authorization });
      res.writeHead(nodeRes._status, { 'content-type': 'application/json' });
      res.end(nodeRes._body);
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({
      port: server.address().port,
      log,
      kvState,
      createSession,
      close: () => new Promise((r) => server.close(r)),
    });
  }));
}

module.exports = { start };
