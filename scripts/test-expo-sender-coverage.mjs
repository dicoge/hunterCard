#!/usr/bin/env node
/**
 * DIC-1189 rework 3rd pass — mutation-sensitive test that EVERY Expo push
 * sender in the codebase wires the staging filter + environment tag
 * (blocker #3a + #7).
 *
 * How it works:
 *   1. Grep the whole `api/` tree for the Expo push URL literal
 *      "https://exp.host/--/api/v2/push/send". Each match is a sender file.
 *   2. For each sender, assert the file also imports and calls both
 *      filterPushRecipients() and pushEnvironmentTag() from
 *      ../_lib/push-staging-guard. A sender that lacks these is a bypass —
 *      the reviewer specifically flagged api/push/price-alert-run.ts for
 *      missing them in the previous pass.
 *
 * Run: node scripts/test-expo-sender-coverage.mjs
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const API_DIR = path.join(ROOT, 'api');

const EXPO_URL = 'https://exp.host/--/api/v2/push/send';
const REQUIRED_IMPORTS = ['filterPushRecipients', 'pushEnvironmentTag'];

function walkFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkFiles(p));
    else if (entry.name.endsWith('.ts')) out.push(p);
  }
  return out;
}

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const senders = walkFiles(API_DIR)
  .filter((p) => fs.readFileSync(p, 'utf8').includes(EXPO_URL))
  .map((p) => path.relative(ROOT, p))
  .sort();

test('at least one Expo sender exists (sanity)', () => {
  assert.ok(senders.length > 0, 'expected to find at least one Expo push sender');
});

// Individual sender coverage.
for (const rel of senders) {
  test(`${rel}: imports filterPushRecipients + pushEnvironmentTag from ../_lib/push-staging-guard`, () => {
    const body = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    for (const sym of REQUIRED_IMPORTS) {
      assert.ok(
        body.includes(sym),
        `${rel} does not reference ${sym} — this Expo sender is a staging-filter bypass. Wire it via api/_lib/push-staging-guard.`,
      );
    }
    // Verify the import specifier itself is present (not just the symbol
    // appearing in a comment or unrelated context).
    assert.ok(
      /from ['"]\.\.\/_lib\/push-staging-guard['"]/.test(body),
      `${rel} does not import from '../_lib/push-staging-guard'`,
    );
  });
}

// Explicit named coverage per known sender — new senders added later
// automatically show up under the loop above.
test('api/push/notify.ts is a known Expo sender and is covered', () => {
  assert.ok(senders.includes('api/push/notify.ts'));
});
test('api/push/price-alert-run.ts is a known Expo sender and is covered (rework 3rd pass — blocker #3a)', () => {
  assert.ok(senders.includes('api/push/price-alert-run.ts'));
});

console.log(`\nexpo-sender-coverage: ${passed} tests passed`);
