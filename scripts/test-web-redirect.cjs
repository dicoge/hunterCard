#!/usr/bin/env node
/**
 * Web OAuth redirect URI determinism tests (DIC-922).
 *
 * PM hit a production `400 redirect_uri_mismatch`: the app sent exactly
 * `https://holohunter.dicoge.com` but Google Console had no matching Authorized
 * redirect URI. These lock the CLIENT side of the contract — the value the app
 * sends is the bare page ORIGIN (no path/query/hash/trailing slash), stable per
 * origin, so it can be registered byte-for-byte in Console.
 *
 * NOTE (per PM): this unit test only proves the generated value is deterministic
 * and equals the origin. It does NOT and CANNOT prove the E2E passes — that
 * additionally requires the identical URI to be registered in Google Console.
 * Compiles the pure src/services/authStrategy.ts.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-redirect-tests-'));

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

// authStrategy imports PRODUCTION_ORIGIN from src/config/apiOrigin.ts (DIC-1245),
// so we have to transpile that module too — otherwise the require fails at the
// import line with MODULE_NOT_FOUND.
compileTs('src/config/apiOrigin.ts');
const { resolveWebRedirectUri } = require(compileTs('src/services/authStrategy.ts'));

function testProductionExactValue() {
  // The exact value PM observed the app send in production.
  assert.equal(
    resolveWebRedirectUri({ origin: 'https://holohunter.dicoge.com' }),
    'https://holohunter.dicoge.com',
  );
}

function testNoTrailingSlash() {
  // Google is byte-exact — a trailing slash would be a different URI and 400.
  assert.equal(
    resolveWebRedirectUri({ origin: 'https://holohunter.dicoge.com/' }),
    'https://holohunter.dicoge.com',
  );
}

function testStableRegardlessOfLaunchPath() {
  // makeRedirectUri() drifts with window.location; the pinned value must be the
  // ORIGIN only, identical no matter which page launched the login. Callers pass
  // window.location.origin, which already excludes path/query/hash — assert we
  // never re-introduce them and that any origin maps to itself verbatim.
  const origins = [
    'https://holohunter.dicoge.com',
    'http://localhost:8081',
    'https://holohunter-git-abc.vercel.app',
  ];
  for (const o of origins) {
    const r = resolveWebRedirectUri({ origin: o });
    assert.equal(r, o);
    assert.ok(!/[?#]/.test(r), `redirect must have no query/hash: ${r}`);
    assert.ok(!r.endsWith('/'), `redirect must have no trailing slash: ${r}`);
  }
}

function testOverrideWins() {
  assert.equal(
    resolveWebRedirectUri({
      origin: 'https://holohunter.dicoge.com',
      override: 'https://custom.example.com/oauth',
    }),
    'https://custom.example.com/oauth',
  );
  assert.equal(
    resolveWebRedirectUri({ origin: 'https://holohunter.dicoge.com', override: '   ' }),
    'https://holohunter.dicoge.com',
  );
}

function testMissingOriginReturnsEmptyForFallback() {
  // Empty => caller falls back to makeRedirectUri(); never a bogus partial URI.
  assert.equal(resolveWebRedirectUri({ origin: null }), '');
  assert.equal(resolveWebRedirectUri({ origin: '' }), '');
  assert.equal(resolveWebRedirectUri({}), '');
}

const tests = [
  testProductionExactValue,
  testNoTrailingSlash,
  testStableRegardlessOfLaunchPath,
  testOverrideWins,
  testMissingOriginReturnsEmptyForFallback,
];
try {
  for (const test of tests) {
    test();
    console.log(`✓ ${test.name}`);
  }
  console.log(`\n${tests.length} web-redirect tests passed`);
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
