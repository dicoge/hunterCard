#!/usr/bin/env node
/**
 * Pure, no-network check of the QA harness outbound boundary
 * (scripts/qa/loopback-url.mjs, used by scripts/qa/local-candidate.mjs).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { isLoopbackUrl } from './qa/loopback-url.mjs';

let passed = 0;
const check = (label, fn) => { fn(); passed += 1; console.log(`  ✓ ${label}`); };

check('local addresses are allowed', () => {
  for (const u of ['http://127.0.0.1:8081/', 'http://localhost:8081/index.bundle', 'https://localhost/', 'http://127.0.0.1/api/auth/sync?x=1']) {
    assert.equal(isLoopbackUrl(u), true, u);
  }
});
check('look-alike, credentialed, external and malformed URLs are refused', () => {
  for (const u of [
    'http://localhost.example/', 'https://localhost.example.com/x', 'http://127.0.0.1.example/',
    'http://localhost@external.example/', 'http://user:pw@localhost/', 'http://user@127.0.0.1:8081/',
    'http://evil.example/?u=http://localhost/', 'https://generativelanguage.googleapis.com/v1/models',
    'ftp://localhost/', 'file:///etc/hosts', 'javascript:alert(1)', 'localhost:8081', '//localhost/', '', 'not a url',
    'http://127.0.0.2/', 'http://0.0.0.0/', 'http://[::ffff:127.0.0.1]/',
  ]) {
    assert.equal(isLoopbackUrl(u), false, u);
  }
});
check('the harness uses the parsed check, not a prefix regex', () => {
  const src = fs.readFileSync(new URL('./qa/local-candidate.mjs', import.meta.url), 'utf8');
  assert.ok(src.includes('isLoopbackUrl(href)'), 'harness fetch must call isLoopbackUrl');
  assert.ok(!/\^https\?:\\\/\\\/\(127/.test(src), 'old prefix regex is gone');
});
console.log(`\n✅ qa-harness-loopback: ${passed} checks passed`);
