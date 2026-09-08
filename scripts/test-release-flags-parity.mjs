#!/usr/bin/env node
/**
 * Release flag parity ledger (DIC-1401).
 *
 * Reads release-parity/flags.json (the single source of truth for which
 * release flags must be identical between Web Production and mobile
 * Production) and cross-checks it against the LIVE eas.json AND vercel.json
 * values so the ledger can never silently drift out of date with the actual
 * build config of either side.
 *
 * Invariants:
 * - Every flag's `mobileProductionEasValue` must equal what eas.json's
 *   `build.production.env` (or an inherited `extends` chain) actually sets
 *   today. A mismatch means the ledger is stale — fail loudly rather than
 *   silently reporting a status that no longer reflects the real config.
 * - The repo's vercel.json is branch-aware (EXPECTED_VERCEL_BRANCH bound to
 *   the branch-guard invocation, and EXPO_PUBLIC_STORE_MVP bound to expo
 *   export — see scripts/ci/store-mvp-define-guard.mjs):
 *   - When it self-declares `main` (Web Production lane), the
 *     EXPO_PUBLIC_STORE_MVP it bakes MUST equal the ledger's
 *     `webProductionVercelValue`.
 *   - When it self-declares `staging` (Web Develop lane, allowed to be
 *     AHEAD), the develop file is expected to bake `0`; the ledger's Web
 *     PRODUCTION value cannot be read from that file, so it is validated by
 *     self-consistency instead (web must equal mobile when parity=synced).
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
import { resolveEasProfileEnv } from './ci/eas-profile-env.mjs';
import { evaluateVercelConfig, readVercelBuildEnv } from './ci/store-mvp-define-guard.mjs';

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

const productionEnv = resolveEasProfileEnv(ROOT, 'production');
const vercelJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'vercel.json'), 'utf8'));
const entrypointSource = fs.readFileSync(path.join(ROOT, 'scripts', 'ci', 'vercel-build.sh'), 'utf8');
// Round-4 moved the lane values into vercel.json build.env (injected into the
// install+build step). The Web Production / Web Develop lane and the STORE_MVP
// value it bakes come from there, so we evaluate the full config and read the
// declared lane, and validate the entrypoint is wired correctly.
const vercelEval = evaluateVercelConfig(vercelJson, entrypointSource);
const webDeclaredBranch = readVercelBuildEnv(vercelJson).expectedBranch;

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

  test(`${flagName}: vercel.json self-declares a known lane (main or staging)`, () => {
    assert.ok(
      ['main', 'staging'].includes(webDeclaredBranch),
      `vercel.json build.env must bind EXPECTED_VERCEL_BRANCH=${JSON.stringify(webDeclaredBranch)} (main or staging); this branch's file is neither the Web Production nor the Web Develop lane.`,
    );
  });

  test(`${flagName}: vercel.json config is valid and wired to the controlled entrypoint`, () => {
    assert.equal(vercelEval.ok, true, vercelEval.reason);
  });

  if (webDeclaredBranch === 'main') {
    test(`${flagName}: Web Production lane — vercel.json's actual expo-export define matches the ledger`, () => {
      const bakedValue = vercelEval.value;
      assert.equal(
        bakedValue,
        entry.webProductionVercelValue,
        `vercel.json (declared main) bakes ${flagName}=${JSON.stringify(bakedValue)} on \`expo export\` (via build.env + vercel-build.sh), but the ledger records webProductionVercelValue=${JSON.stringify(entry.webProductionVercelValue)} — the ledger is out of date with the Web Production build config.`,
      );
    });
  } else {
    test(`${flagName}: Web Develop lane (staging) must be AHEAD (bake 0), not silently equal to production`, () => {
      assert.equal(
        vercelEval.value,
        '0',
        `vercel.json declares the staging/develop lane and must bake ${flagName}=0 to preview ahead-of-main features; got ${JSON.stringify(vercelEval.value)}.`,
      );
    });
  }

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