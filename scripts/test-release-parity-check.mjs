#!/usr/bin/env node
/**
 * Release-parity SHA contract (DIC-1401): unit tests for
 * scripts/ci/release-parity.mjs.
 *
 * Invariants:
 * - Exact SHA match (any length 7-40 hex, case-insensitive) -> 'synced'.
 * - Any mismatch -> 'not-synced', never silently swallowed.
 * - Missing/blank/malformed input on EITHER side -> 'unknown' — never
 *   'synced' and never 'not-synced' (an unknown value is not evidence of a
 *   deliberate difference).
 * - fetchWebSha never throws on a bad host/network/parse error; it resolves
 *   null so the caller reports 'unknown' instead of crashing the workflow.
 */
import assert from 'node:assert/strict';
import { evaluateShaParity, fetchWebSha } from './ci/release-parity.mjs';

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

async function testAsync(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const SHA_A = '9e96afd3b9c1df6f4204eb02dd195c51c70def05';
const SHA_B = 'c547a4b05e44a40b51fa1af1f81083a527aa9971';

test('identical full 40-char SHAs -> synced', () => {
  const r = evaluateShaParity(SHA_A, SHA_A);
  assert.equal(r.status, 'synced');
});

test('identical SHAs differing only by case -> synced (case-insensitive)', () => {
  const r = evaluateShaParity(SHA_A.toUpperCase(), SHA_A);
  assert.equal(r.status, 'synced');
});

test('identical short (7-char) abbreviations -> synced', () => {
  const r = evaluateShaParity(SHA_A.slice(0, 7), SHA_A.slice(0, 7));
  assert.equal(r.status, 'synced');
});

test('different SHAs -> not-synced, exact values preserved', () => {
  const r = evaluateShaParity(SHA_A, SHA_B);
  assert.equal(r.status, 'not-synced');
  assert.equal(r.webSha, SHA_A);
  assert.equal(r.mobileSha, SHA_B);
});

test('missing web SHA -> unknown, never synced/not-synced', () => {
  const r = evaluateShaParity(null, SHA_A);
  assert.equal(r.status, 'unknown');
});

test('missing mobile SHA -> unknown', () => {
  const r = evaluateShaParity(SHA_A, undefined);
  assert.equal(r.status, 'unknown');
});

test('both missing -> unknown', () => {
  const r = evaluateShaParity('', '');
  assert.equal(r.status, 'unknown');
});

test('malformed / placeholder values ("unknown", "null", short garbage) -> unknown, not a false synced', () => {
  assert.equal(evaluateShaParity('unknown', 'unknown').status, 'unknown');
  assert.equal(evaluateShaParity('null', SHA_A).status, 'unknown');
  assert.equal(evaluateShaParity('abc', 'abc').status, 'unknown'); // too short (<7 hex chars)
});

test('whitespace-padded matching SHAs are trimmed and still synced', () => {
  const r = evaluateShaParity(`  ${SHA_A}  `, SHA_A);
  assert.equal(r.status, 'synced');
});

await testAsync('fetchWebSha resolves null (not throw) on an unreachable host', async () => {
  const sha = await fetchWebSha('https://this-host-does-not-exist.invalid.example');
  assert.equal(sha, null);
});

console.log(`\nrelease-parity-check: ${passed} tests passed`);
