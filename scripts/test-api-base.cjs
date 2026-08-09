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
}

const tests = [
  testNativeUsesAbsoluteProduction,
  testNativeNeverRelative,
  testWebUsesSameOrigin,
  testWebWithoutOriginFallsBackToNative,
  testEnvOverrideWins,
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
