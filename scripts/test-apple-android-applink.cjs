#!/usr/bin/env node
/**
 * Android Apple App Link + exchange-code tests (DIC-960 / CR DIC-961).
 *
 * The CR blocker was that Android returned the bearer session over a custom
 * scheme, which is not app-exclusive. A routing-string assertion is insufficient,
 * so these tests build/inspect the RESOLVED artifacts and validate the actual
 * fail-closed contract:
 *
 *   1. app.config.js — the resolved Android manifest config carries an
 *      `autoVerify` HTTPS App Link intent filter for the exact production
 *      host/path when (and only when) EXPO_PUBLIC_APPLE_ANDROID_ENABLED=true;
 *      with the gate off, NO App Link intent filter ships (fail-closed).
 *   2. generate-assetlinks.mjs — emits a valid delegation ONLY from a real
 *      env-supplied signing-cert fingerprint; with none (or malformed) it emits
 *      an empty array so App Link verification fails closed. No invented values.
 *   3. apple-exchange-store — the one-time exchange code is single-use and only
 *      redeemable with the matching PKCE verifier (replay + ownership).
 *
 * The compile output dir lives UNDER the project root so the compiled
 * apple-exchange-store.js can resolve '@vercel/kv' from the project node_modules.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(ROOT, '.applink-tests-'));

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
  return output;
}

const APP_LINK_ENV_KEYS = [
  'EXPO_PUBLIC_APPLE_ANDROID_ENABLED',
  'EXPO_PUBLIC_APPLE_ANDROID_APP_LINK_HOST',
  'EAS_BUILD_PLATFORM',
  'ASSERT_GOOGLE_WEB_CLIENT',
  'ASSERT_GOOGLE_IOS_CLIENT',
];

// Evaluate the dynamic Expo config with a controlled env and return the resolved
// config object (fresh require each time so env changes take effect).
function loadAppConfig(env) {
  const saved = {};
  for (const k of APP_LINK_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  Object.assign(process.env, env);
  delete require.cache[require.resolve(path.join(ROOT, 'app.config.js'))];
  delete require.cache[require.resolve(path.join(ROOT, 'app.base.json'))];
  try {
    return require(path.join(ROOT, 'app.config.js'))();
  } finally {
    for (const k of APP_LINK_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function appLinkFilters(config, host) {
  const filters = config?.expo?.android?.intentFilters;
  if (!Array.isArray(filters)) return [];
  return filters.filter(
    (f) =>
      f?.autoVerify === true &&
      Array.isArray(f?.data) &&
      f.data.some(
        (d) =>
          d?.scheme === 'https' &&
          d?.host === host &&
          d?.pathPrefix === '/auth/apple/return',
      ),
  );
}

function testAppLinkPresentWhenEnabled() {
  const config = loadAppConfig({ EXPO_PUBLIC_APPLE_ANDROID_ENABLED: 'true' });
  const filters = appLinkFilters(config, 'holohunter.dicoge.com');
  assert.equal(filters.length, 1, 'exactly one App Link intent filter for the prod host/path');
  const f = filters[0];
  assert.equal(f.action, 'VIEW');
  assert.equal(f.autoVerify, true);
  assert.ok(f.category.includes('BROWSABLE'));
  assert.ok(f.category.includes('DEFAULT'));
}

function testAppLinkAbsentWhenDisabled() {
  // Fail-closed: gate off (and unset) → no App Link intent filter ships, so
  // Android can never verify a return channel and the button stays hidden.
  const off = loadAppConfig({ EXPO_PUBLIC_APPLE_ANDROID_ENABLED: 'false' });
  assert.equal(appLinkFilters(off, 'holohunter.dicoge.com').length, 0);
  const unset = loadAppConfig({});
  assert.equal(appLinkFilters(unset, 'holohunter.dicoge.com').length, 0);
}

function testAppLinkHostOverride() {
  const config = loadAppConfig({
    EXPO_PUBLIC_APPLE_ANDROID_ENABLED: 'true',
    EXPO_PUBLIC_APPLE_ANDROID_APP_LINK_HOST: 'staging.example.com',
  });
  assert.equal(appLinkFilters(config, 'staging.example.com').length, 1);
  // The default prod host must NOT be present when overridden.
  assert.equal(appLinkFilters(config, 'holohunter.dicoge.com').length, 0);
}

const VALID_FP = Array(32).fill('AB').join(':'); // 32 hex byte-pairs
const VALID_FP2 = Array(32).fill('CD').join(':');

async function testAssetLinksFailClosed() {
  const mod = await import(
    require('node:url').pathToFileURL(path.join(ROOT, 'scripts/generate-assetlinks.mjs')).href
  );
  const { buildAssetLinks } = mod;
  // No fingerprint → empty (fail-closed): a valid file that delegates to no app.
  assert.deepEqual(buildAssetLinks({}), []);
  assert.deepEqual(buildAssetLinks({ ANDROID_APP_LINK_SHA256: '' }), []);
  assert.deepEqual(buildAssetLinks({ ANDROID_APP_LINK_SHA256: '  ,  ' }), []);
  // Malformed fingerprints are dropped, never emitted.
  assert.deepEqual(buildAssetLinks({ ANDROID_APP_LINK_SHA256: 'AB:CD' }), []);
  assert.deepEqual(buildAssetLinks({ ANDROID_APP_LINK_SHA256: 'not-a-fingerprint' }), []);
}

async function testAssetLinksValid() {
  const mod = await import(
    require('node:url').pathToFileURL(path.join(ROOT, 'scripts/generate-assetlinks.mjs')).href
  );
  const { buildAssetLinks } = mod;
  const one = buildAssetLinks({ ANDROID_APP_LINK_SHA256: VALID_FP });
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].relation, ['delegate_permission/common.handle_all_urls']);
  assert.equal(one[0].target.namespace, 'android_app');
  assert.equal(one[0].target.package_name, 'com.dicoge.holohunter');
  assert.deepEqual(one[0].target.sha256_cert_fingerprints, [VALID_FP]);
  // Lowercase is normalised to uppercase.
  const lower = buildAssetLinks({ ANDROID_APP_LINK_SHA256: VALID_FP.toLowerCase() });
  assert.deepEqual(lower[0].target.sha256_cert_fingerprints, [VALID_FP]);
  // Two fingerprints (upload + Play signing keys), deduplicated.
  const two = buildAssetLinks({
    ANDROID_APP_LINK_SHA256: `${VALID_FP}, ${VALID_FP2}, ${VALID_FP}`,
  });
  assert.equal(two[0].target.package_name, 'com.dicoge.holohunter');
  assert.deepEqual(two[0].target.sha256_cert_fingerprints, [VALID_FP, VALID_FP2]);
  // Package is NOT operator-configurable: an ANDROID_APP_LINK_PACKAGE override
  // must NOT delegate the HoloHunter host to another package (CR DIC-961).
  const spoofed = buildAssetLinks({
    ANDROID_APP_LINK_SHA256: VALID_FP,
    ANDROID_APP_LINK_PACKAGE: 'com.attacker.app',
  });
  assert.equal(spoofed[0].target.package_name, 'com.dicoge.holohunter');
}

// A minimal in-memory KV mirroring the two ops the store uses. `getdel` is atomic
// get-and-delete, which is what enforces single-use.
function fakeKv() {
  const map = new Map();
  return {
    async set(key, value, opts) {
      if (opts?.nx && map.has(key)) return null;
      map.set(key, value);
      return 'OK';
    },
    async getdel(key) {
      if (!map.has(key)) return null;
      const v = map.get(key);
      map.delete(key);
      return v;
    },
  };
}

async function testExchangeReplayAndOwnership() {
  compileTs('api/_lib/apple-web-oauth.ts');
  // DIC-1189 boot deps: apple-exchange-store now imports kv-namespace.
  compileTs('src/config/appEnv.ts');
  compileTs('api/_lib/env-guard.ts');
  compileTs('api/_lib/kv-namespace.ts');
  const store = require(compileTs('api/_lib/apple-exchange-store.ts'));
  const oauth = require(path.join(outDir, 'api/_lib/apple-web-oauth.js'));

  const verifier = 'verifier-abc-1234567890';
  const challenge = oauth.codeChallengeOf(verifier);

  // Happy path: store, then redeem once with the matching verifier.
  const kv1 = fakeKv();
  await store.storeAppleExchange('code-1', { session: 'sess-1', isNew: true, challenge }, kv1);
  const first = await store.redeemAppleExchange('code-1', verifier, kv1);
  assert.deepEqual(first, { session: 'sess-1', isNew: true });
  // Replay: the code was consumed on first redeem → second attempt fails closed.
  assert.equal(await store.redeemAppleExchange('code-1', verifier, kv1), null);

  // Ownership: a wrong verifier never yields the session (and consumes the code).
  const kv2 = fakeKv();
  await store.storeAppleExchange('code-2', { session: 'sess-2', isNew: false, challenge }, kv2);
  assert.equal(await store.redeemAppleExchange('code-2', 'wrong-verifier', kv2), null);

  // Unknown code and empty inputs fail closed.
  const kv3 = fakeKv();
  assert.equal(await store.redeemAppleExchange('nope', verifier, kv3), null);
  assert.equal(await store.redeemAppleExchange('', verifier, kv3), null);
  assert.equal(await store.redeemAppleExchange('code-x', '', kv3), null);

  // A duplicate code cannot overwrite an existing one (nx guard).
  const kv4 = fakeKv();
  await store.storeAppleExchange('dup', { session: 's', isNew: false, challenge }, kv4);
  await assert.rejects(() =>
    store.storeAppleExchange('dup', { session: 'other', isNew: false, challenge }, kv4),
  );
}

const tests = [
  testAppLinkPresentWhenEnabled,
  testAppLinkAbsentWhenDisabled,
  testAppLinkHostOverride,
  testAssetLinksFailClosed,
  testAssetLinksValid,
  testExchangeReplayAndOwnership,
];

(async () => {
  try {
    for (const test of tests) {
      await test();
      console.log(`✓ ${test.name}`);
    }
    console.log(`\n${tests.length} apple-android-applink tests passed`);
  } finally {
    fs.rmSync(outDir, { recursive: true, force: true });
  }
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
