#!/usr/bin/env node
/**
 * Release flag parity ledger (DIC-1401).
 *
 * Reads release-parity/flags.json (the single source of truth for which
 * release flags must be identical between Web Production and mobile
 * Production) and cross-checks it against the LIVE eas.json values so the
 * ledger can never silently drift out of date with the actual mobile build
 * config.
 *
 * Invariants:
 * - Every flag's `mobileProductionEasValue` must equal what eas.json's
 *   `build.production.env` (or an inherited `extends` chain) actually sets
 *   today. A mismatch means the ledger is stale — fail loudly rather than
 *   silently reporting a status that no longer reflects the real config.
 * - `parity: "synced"` requires webProductionVercelValue to literally equal
 *   mobileProductionEasValue — anything else is a lie about being synced.
 * - `parity: "documented-exception"` requires non-empty reason/
 *   trackingIssue/followUp — an exception with no paper trail is
 *   indistinguishable from an unnoticed regression.
 * - No other `parity` value is accepted (fail-closed on typos/new states).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0;
function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const flagsManifest = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'release-parity/flags.json'), 'utf8'),
);
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

// Resolve eas.json's `production` build profile env, following `extends`
// chains (as EAS itself does) so an inherited value is still seen.
function resolveEasProfileEnv(profileName, seen = new Set()) {
  if (seen.has(profileName)) return {};
  seen.add(profileName);
  const profile = easJson.build?.[profileName];
  if (!profile) return {};
  const inherited = profile.extends ? resolveEasProfileEnv(profile.extends, seen) : {};
  return { ...inherited, ...(profile.env || {}) };
}

const productionEnv = resolveEasProfileEnv('production');

const flags = flagsManifest.flags || {};
assert.ok(Object.keys(flags).length > 0, 'release-parity/flags.json must list at least one flag');

for (const [flagName, entry] of Object.entries(flags)) {
  test(`${flagName}: ledger's mobileProductionEasValue matches live eas.json`, () => {
    const liveValue = productionEnv[flagName] ?? null;
    assert.equal(
      entry.mobileProductionEasValue,
      liveValue,
      `flags.json says mobileProductionEasValue=${JSON.stringify(entry.mobileProductionEasValue)} but eas.json build.production.env resolves ${flagName}=${JSON.stringify(liveValue)} — update the ledger to match reality.`,
    );
  });

  test(`${flagName}: parity field is a recognised state`, () => {
    assert.ok(
      ['synced', 'documented-exception'].includes(entry.parity),
      `unrecognised parity value ${JSON.stringify(entry.parity)} for ${flagName}`,
    );
  });

  if (entry.parity === 'synced') {
    test(`${flagName}: parity=synced requires web and mobile values to literally match`, () => {
      assert.equal(
        entry.webProductionVercelValue,
        entry.mobileProductionEasValue,
        `${flagName} is marked parity=synced but webProductionVercelValue !== mobileProductionEasValue — this is a false parity claim.`,
      );
    });
  } else {
    test(`${flagName}: parity=documented-exception carries a full paper trail`, () => {
      assert.ok(typeof entry.reason === 'string' && entry.reason.trim().length > 0, `${flagName} missing reason`);
      assert.ok(
        typeof entry.trackingIssue === 'string' && entry.trackingIssue.trim().length > 0,
        `${flagName} missing trackingIssue`,
      );
      assert.ok(
        typeof entry.followUp === 'string' && entry.followUp.trim().length > 0,
        `${flagName} missing followUp`,
      );
    });
  }
}

console.log(`\nrelease-flags-parity: ${passed} tests passed`);
