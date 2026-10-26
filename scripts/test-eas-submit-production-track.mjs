#!/usr/bin/env node
/**
 * EAS production submit-profile invariants (play-production-20260919).
 *
 * The failure this guards against: `eas submit --profile production` silently
 * publishing the store AAB to the Google Play INTERNAL track. Two things make
 * that failure silent rather than loud:
 *
 *   1. eas.json's `submit.production.android.track` was literally "internal"
 *      (copied from the preview profile when the file was scaffolded), so the
 *      submit succeeded — to the wrong track — with a green exit status.
 *   2. The schema cannot catch it: @expo/eas-json's AndroidSubmitProfileSchema
 *      types `track` as a free string and DEFAULTS it to 'internal'
 *      (build/submit/schema.js: `track: joi.string().default('internal')`),
 *      because Play consoles can define custom track names. So both a wrong
 *      value and a deleted line validate cleanly and land on internal.
 *
 * Google Play's built-in track names are production, beta, alpha and internal;
 * the production rollout track is exactly "production". Since no tool in the
 * chain will ever flag this, the repo pins it here instead.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const easJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

const production = easJson.submit?.production?.android;
const preview = easJson.submit?.preview?.android;

check('submit.production.android exists — the production submit path must be declared, not improvised', () => {
  assert.ok(production, 'eas.json must define submit.production.android');
});

check('production track is explicitly "production", never inherited from the internal default', () => {
  assert.ok(
    Object.prototype.hasOwnProperty.call(production, 'track'),
    'submit.production.android.track must be written out: @expo/eas-json defaults a missing track to "internal", so deleting the line re-routes the store AAB to the internal track with a green exit status',
  );
  assert.equal(
    production.track,
    'production',
    `submit.production.android.track is "${production.track}" — the production profile must target the Play production track; "internal" here means a store rollout silently lands on the internal testing track`,
  );
});

check('production submit publishes a completed release under review', () => {
  assert.equal(
    production.releaseStatus,
    'completed',
    'production releaseStatus must be "completed" — a draft on the production track is not a rollout',
  );
  assert.equal(
    production.changesNotSentForReview,
    false,
    'production submissions must go to Play review; changesNotSentForReview=true leaves the release parked',
  );
});

check('preview profile still targets the internal track — the two profiles must not converge', () => {
  assert.ok(preview, 'eas.json must define submit.preview.android');
  assert.equal(
    preview.track,
    'internal',
    'submit.preview.android.track must stay "internal": preview builds are tester artifacts and must never reach the production track',
  );
});

check('release version bookkeeping stays EAS-managed', () => {
  assert.equal(
    easJson.cli?.appVersionSource,
    'remote',
    'cli.appVersionSource must remain "remote" — versionCode is EAS-managed, not local',
  );
  assert.equal(
    easJson.build?.production?.autoIncrement,
    true,
    'build.production.autoIncrement must remain true so store builds cannot collide on versionCode',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
