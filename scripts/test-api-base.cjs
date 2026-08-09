#!/usr/bin/env node
/**
 * API base resolution tests (DIC-922 blocker 5).
 *
 * The whole point: native iOS/Android must NEVER hit a relative '/api' —
 * React Native's fetch can't resolve it and every auth call dies on-device.
 * These lock: native → absolute production URL; web → same-origin; env override
 * wins; and native is never a relative path regardless of inputs. Compiles the
 * pure src/services/authStrategy.ts (no react-native/expo imports).
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'api-base-tests-'));

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

const { resolveApiBase } = require(compileTs('src/services/authStrategy.ts'));

const PROD = 'https://holohunter.dicoge.com/api';

function testNativeUsesAbsoluteProduction() {
  assert.equal(resolveApiBase({ platformOS: 'ios' }), PROD);
  assert.equal(resolveApiBase({ platformOS: 'android' }), PROD);
  // Even if a web origin is (wrongly) passed for a native OS, native must not
  // adopt it — the origin only applies on web.
  assert.equal(
    resolveApiBase({ platformOS: 'ios', webOrigin: 'https://example.com' }),
    PROD,
  );
}

function testNativeNeverRelative() {
  for (const os of ['ios', 'android']) {
    const base = resolveApiBase({ platformOS: os });
    assert.ok(/^https?:\/\//.test(base), `${os} base must be absolute, got ${base}`);
    assert.ok(!base.startsWith('/'), `${os} base must not be relative, got ${base}`);
  }
}

function testWebUsesSameOrigin() {
  assert.equal(
    resolveApiBase({ platformOS: 'web', webOrigin: 'https://holohunter.dicoge.com' }),
    'https://holohunter.dicoge.com/api',
  );
  // Vercel preview / any deploy origin works the same way.
  assert.equal(
    resolveApiBase({ platformOS: 'web', webOrigin: 'https://holohunter-git-x.vercel.app' }),
    'https://holohunter-git-x.vercel.app/api',
  );
  // Trailing slash on the origin must not double up.
  assert.equal(
    resolveApiBase({ platformOS: 'web', webOrigin: 'https://holohunter.dicoge.com/' }),
    'https://holohunter.dicoge.com/api',
  );
}

function testWebWithoutOriginFallsBackToNative() {
  // SSR / no window: fall back to the absolute base rather than a broken relative.
  assert.equal(resolveApiBase({ platformOS: 'web', webOrigin: null }), PROD);
}

function testEnvOverrideWins() {
  assert.equal(
    resolveApiBase({
      platformOS: 'ios',
      envOverride: 'https://staging.holohunter.dicoge.com/api',
    }),
    'https://staging.holohunter.dicoge.com/api',
  );
  // Override trailing slash trimmed; still wins over web same-origin.
  assert.equal(
    resolveApiBase({
      platformOS: 'web',
      webOrigin: 'https://holohunter.dicoge.com',
      envOverride: 'https://staging.example.com/api/',
    }),
    'https://staging.example.com/api',
  );
  // Empty / whitespace override is ignored (not treated as a value).
  assert.equal(resolveApiBase({ platformOS: 'ios', envOverride: '   ' }), PROD);
  // A plain http (not https) absolute override is still accepted (e.g. LAN dev).
  assert.equal(
    resolveApiBase({ platformOS: 'ios', envOverride: 'http://192.168.1.10:3000/api' }),
    'http://192.168.1.10:3000/api',
  );
}

// DIC-928 blocker 4 + DIC-934 CR fix: an override that is not a well-formed
// ABSOLUTE http(s) URL must be rejected and resolution must FAIL CLOSED to the
// safe platform default — never adopt a relative/malformed value that would
// break native fetch or point auth at the wrong place.
function testMalformedNativeOverrideFailsClosed() {
  const bad = [
    '/api', // relative — the exact on-device bug we fixed
    'api', // bare relative segment
    './api',
    'holohunter.dicoge.com/api', // absolute-looking but no scheme (bare host)
    'ftp://holohunter.dicoge.com/api', // wrong scheme
    'https://', // scheme with no host
    'http:///api', // empty host
    'not a url',
    'javascript:alert(1)',
    // DIC-934 CR: scheme-looking values that regex alone accepts
    'https://?', // query-only, no host
    'https://#frag', // fragment-only, no host
    'https://%', // bare percent-encoding, no host
    'https://:bad/api', // colon-separator with no host
    'https://[GGGG::1]/api', // non-hex inside IPv6 brackets
    'https://example.com:99999/api', // invalid port (>65535)
  ];
  for (const envOverride of bad) {
    assert.equal(
      resolveApiBase({ platformOS: 'ios', envOverride }),
      PROD,
      `native must fail closed to production for malformed override ${JSON.stringify(envOverride)}`,
    );
    const androidBase = resolveApiBase({ platformOS: 'android', envOverride });
    assert.ok(
      /^https?:\/\//.test(androidBase) && !androidBase.startsWith('/'),
      `android must stay absolute for malformed override ${JSON.stringify(envOverride)}, got ${androidBase}`,
    );
  }
}

function testMalformedWebOverrideFallsBackToSameOrigin() {
  // A bad override on web is ignored too; web falls back to its own same-origin
  // /api rather than the broken value.
  assert.equal(
    resolveApiBase({
      platformOS: 'web',
      webOrigin: 'https://holohunter.dicoge.com',
      envOverride: '/api',
    }),
    'https://holohunter.dicoge.com/api',
  );
}

const tests = [
  testNativeUsesAbsoluteProduction,
  testNativeNeverRelative,
  testWebUsesSameOrigin,
  testWebWithoutOriginFallsBackToNative,
  testEnvOverrideWins,
  testMalformedNativeOverrideFailsClosed,
  testMalformedWebOverrideFallsBackToSameOrigin,
];
try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} api-base tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
