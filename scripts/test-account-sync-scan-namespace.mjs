#!/usr/bin/env node
/**
 * DIC-1189 rework 3rd pass — mutation-sensitive test for the account-sync
 * KV SCAN pattern (blocker #2b + #7).
 *
 * Exercises the specific line in account-sync-store.ts:
 *   for await (const key of kv.scanIterator({ match: nsKey(`account-sync:idempotency:${userId}:*`), count: 100 }))
 *
 * Invariants:
 *   - On APP_ENV=production the SCAN pattern is `account-sync:idempotency:...`
 *     (bare — production wire format byte-identical to pre-DIC-1189).
 *   - On APP_ENV=staging the SCAN pattern is `staging:account-sync:idempotency:...`
 *     — staging cleanup cannot enumerate/delete production keys.
 *   - On missing APP_ENV the SCAN throws AppEnvUnresolved — a scan can never
 *     be performed in an unattributed environment.
 *
 * The test drives deleteAccountSyncData() with a fake KV whose scanIterator
 * records the match pattern it was given, then asserts the recorded pattern.
 *
 * Run: APP_ENV=production node --experimental-strip-types \
 *   --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
 *   --import ./scripts/register-ts.mjs scripts/test-account-sync-scan-namespace.mjs
 */

if (!process.env.APP_ENV) process.env.APP_ENV = 'production';

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Module from 'node:module';
import ts from 'typescript';
import { AppEnvUnresolved } from '../src/config/appEnv.ts';

const ROOT = path.resolve(new URL('.', import.meta.url).pathname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'account-sync-scan-tests-'));

// KV mock that records every scanIterator match pattern.
const scanCalls = [];
const kvMock = {
  async get() { return null; },
  async set() { return 'OK'; },
  async del() { return 1; },
  async smembers() { return []; },
  async sadd() { return 1; },
  async srem() { return 1; },
  async eval() { return ['OK', '0', ''] ; },
  async hget() { return null; },
  async hset() { return 1; },
  async hgetall() { return {}; },
  scanIterator(opts) {
    scanCalls.push(opts && opts.match);
    return (async function* () {})();
  },
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request) {
  if (request === '@vercel/kv') return { kv: kvMock };
  return originalLoad.apply(this, arguments);
};

function compileTs(relPath) {
  const input = path.join(ROOT, relPath);
  const output = path.join(outDir, relPath).replace(/\.ts$/, '.js');
  fs.mkdirSync(path.dirname(output), { recursive: true });
  const compiled = ts.transpileModule(fs.readFileSync(input, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022,
      esModuleInterop: true,
    },
    fileName: input,
  });
  fs.writeFileSync(output, compiled.outputText);
}
for (const rel of [
  'src/config/appEnv.ts',
  'api/_lib/env-guard.ts',
  'api/_lib/kv-namespace.ts',
  'api/_lib/account-sync-store.ts',
]) compileTs(rel);

const store = await import(path.join(outDir, 'api/_lib/account-sync-store.js'));

let passed = 0;
function test(name, fn) {
  return Promise.resolve(fn()).then(() => {
    passed += 1;
    console.log(`  ✓ ${name}`);
  });
}

async function withEnv(overrides, fn) {
  const before = { ...process.env };
  try {
    for (const k of ['APP_ENV', 'EXPO_PUBLIC_APP_ENV']) delete process.env[k];
    for (const [k, v] of Object.entries(overrides)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    // Must AWAIT so the finally does not restore env before fn's async
    // operations run (otherwise nsKey inside the compiled module reads
    // the restored env, not the test env).
    return await fn();
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key];
    for (const [k, v] of Object.entries(before)) process.env[k] = v;
  }
}

try {
  await test('production: scan pattern is bare (no staging: prefix)', async () => {
    await withEnv({ APP_ENV: 'production' }, async () => {
      scanCalls.length = 0;
      await store.deleteAccountSyncData('user-42');
      const scanPattern = scanCalls.find((p) => typeof p === 'string' && p.startsWith('account-sync:idempotency:'));
      assert.ok(scanPattern, `expected a scan call for account-sync:idempotency:*; got: ${JSON.stringify(scanCalls)}`);
      assert.equal(scanPattern, 'account-sync:idempotency:user-42:*');
    });
  });

  await test('staging: scan pattern carries the staging: prefix (blocker #2b)', async () => {
    await withEnv({ APP_ENV: 'staging' }, async () => {
      scanCalls.length = 0;
      await store.deleteAccountSyncData('user-99');
      const scanPattern = scanCalls.find((p) => typeof p === 'string' && p.includes('account-sync:idempotency:'));
      assert.ok(scanPattern, `expected a scan call; got: ${JSON.stringify(scanCalls)}`);
      assert.equal(scanPattern, 'staging:account-sync:idempotency:user-99:*');
      assert.ok(scanPattern.startsWith('staging:'), 'staging scan must carry the staging: prefix');
    });
  });

  await test('unattributed env: scan throws AppEnvUnresolved (never scans production keys)', async () => {
    await withEnv({}, async () => {
      scanCalls.length = 0;
      let threw = false;
      try {
        await store.deleteAccountSyncData('user-1');
      } catch (err) {
        threw = true;
        // The compiled JS surfaces the error via a plain Error whose name
        // property equals 'AppEnvUnresolved' (class identity is a different
        // instance across the transpiled boundary).
        assert.equal(err.name, 'AppEnvUnresolved', `expected AppEnvUnresolved, got: ${err}`);
      }
      assert.ok(threw, 'expected scan to throw on missing APP_ENV');
    });
  });
} finally {
  Module._load = originalLoad;
  fs.rmSync(outDir, { recursive: true, force: true });
}

console.log(`\naccount-sync-scan-namespace: ${passed} tests passed`);
