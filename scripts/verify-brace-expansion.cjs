#!/usr/bin/env node
// Guards against brace-expansion overrides that break legacy minimatch@3 consumers.
// minimatch@3 does `const expand = require('brace-expansion')` and calls expand(pattern);
// brace-expansion >=4 ships an ESM-interop object export (not a bare function), so forcing
// a 5.x override onto a minimatch@3 subtree throws `TypeError: expand is not a function`
// the moment a pattern contains braces. Every override applied to those paths MUST stay on a
// major line (1.x/2.x) whose CommonJS build exports the function directly.
const assert = require('assert');
const path = require('path');
const Module = require('module');

// Packages that pull minimatch@3 (directly or via glob@7) and expand brace patterns at runtime.
const legacyConsumers = ['@ts-morph/common', 'test-exclude', '@react-native/codegen', 'rimraf'];

let checked = 0;
for (const name of legacyConsumers) {
  let pkgJson;
  try {
    pkgJson = require.resolve(`${name}/package.json`);
  } catch {
    continue; // optional/platform dep not installed here — skip
  }
  const from = Module.createRequire(pkgJson);
  const bePath = from.resolve('brace-expansion');
  const be = require(bePath);
  const ver = require(from.resolve('brace-expansion/package.json')).version;
  assert.strictEqual(
    typeof be,
    'function',
    `${name} resolves brace-expansion@${ver} whose CJS export is ${typeof be}, not a callable — ` +
      `minimatch@3 would throw "expand is not a function". Keep this path on 1.x/2.x.`
  );
  const expanded = be('src/{a,b}.ts');
  assert.deepStrictEqual(expanded, ['src/a.ts', 'src/b.ts'], `${name}: brace expansion output wrong`);
  console.log(`  ✓ ${name} -> brace-expansion@${ver} callable, expands braces`);
  checked++;
}

// End-to-end through minimatch@3 itself (the API the codegen/glob toolchain actually calls).
const tsMorphMm = Module.createRequire(require.resolve('@ts-morph/common/package.json')).resolve('minimatch');
const minimatch = require(tsMorphMm);
const match = (minimatch && minimatch.minimatch) || minimatch;
const mmVer = require(path.join(path.dirname(tsMorphMm), 'package.json')).version;
assert.ok(mmVer.startsWith('3.'), `expected @ts-morph minimatch@3, got ${mmVer}`);
assert.strictEqual(match('src/a.ts', 'src/{a,b}.ts'), true, 'minimatch@3 brace pattern must match');
console.log(`  ✓ minimatch@${mmVer} brace pattern matches (no "expand is not a function")`);

console.log(`\nbrace-expansion compat verification passed (${checked} legacy consumers + minimatch@3).`);
