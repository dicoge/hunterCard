#!/usr/bin/env node
/**
 * Play release manifest permission invariants (DIC-1248).
 *
 * The failure this guards against: shipping an AAB to Google Play whose merged
 * manifest requests a permission nobody can justify. versionCode 6 did exactly
 * that — `aapt2 dump permissions` on the build 6 APK
 * (d842d312-79f5-41aa-bacf-bda080baf518) listed SYSTEM_ALERT_WINDOW,
 * READ_EXTERNAL_STORAGE and WRITE_EXTERNAL_STORAGE, none of which any app code
 * path requests at runtime. SYSTEM_ALERT_WINDOW is declared only by React
 * Native's DEBUG-only manifest (the dev overlay), and no component in the build
 * 6 manifest used it. Play surfaces every merged permission to the user and
 * cross-checks it against the Data safety form, so a vestigial permission is
 * both a review risk and a lie in the questionnaire.
 *
 * A permission cannot be "removed" by deleting a line — it is contributed by a
 * dependency's own AndroidManifest.xml and merged in by Gradle. The only
 * removal mechanism is `expo.android.blockedPermissions`, which emits
 * `tools:node="remove"`. So the invariant asserted here is a contract between
 * three things that drift apart independently:
 *
 *   1. Configuration — app.base.json declares the allowlist and the blocklist.
 *   2. Attribution — every permission any installed dependency can contribute
 *      is CLASSIFIED below with the reason it is kept or blocked. A new
 *      dependency that drags in an unclassified permission fails the gate
 *      rather than silently widening the manifest.
 *   3. Behaviour — Expo's own Permissions plugin is executed against a
 *      synthetic manifest seeded with every dependency-declared permission, and
 *      the emitted document is asserted. Text assertions on app.base.json
 *      cannot see a change in Expo's removal semantics; this layer can.
 *
 * What this gate CANNOT do: prove the final merged manifest. That is produced
 * by Gradle during the EAS build from Maven AARs (firebase-messaging,
 * ShortcutBadger, androidx) which are not present in node_modules. The merged
 * result is verified against the checked-in baseline by
 * scripts/ci/play-artifact-permissions-verify.sh, run on the built artifact.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(ROOT, 'package.json'));

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ------------------------------------------------------------------ contract

const ALLOWED = ['android.permission.CAMERA'];

const BLOCKED = [
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
];

/**
 * Every permission an installed dependency declares in its own
 * AndroidManifest.xml, and the decision made about it. `keep` entries must
 * name the user-visible feature that stops working without them — "a library
 * asked for it" is not a reason Play accepts.
 */
const CLASSIFICATION = {
  'android.permission.CAMERA': {
    decision: 'keep',
    reason: 'Scan screen: live card capture via expo-camera (src/screens/ScanScreen.tsx).',
  },
  'android.permission.INTERNET': {
    decision: 'keep',
    reason: 'Card search, price data and auth all call the HTTPS API.',
  },
  'android.permission.POST_NOTIFICATIONS': {
    decision: 'keep',
    reason: 'Android 13+ runtime prompt for watchlist price-alert notifications.',
  },
  'android.permission.RECEIVE_BOOT_COMPLETED': {
    decision: 'keep',
    reason:
      'Contributed by expo-notifications so scheduled/delivered notifications survive a reboot. Normal-level, no runtime prompt.',
  },
  'android.permission.RECORD_AUDIO': {
    decision: 'blocked',
    reason:
      'expo-camera declares it for video capture. HoloHunter never records audio; the plugin is configured microphonePermission:false and this blocks the merge as a backstop.',
  },
  'android.permission.SYSTEM_ALERT_WINDOW': {
    decision: 'blocked',
    reason:
      "Declared only by React Native's debug-only manifest for the dev overlay (node_modules/react-native/ReactAndroid/src/debug/AndroidManifest.xml). It reached the build 6 release APK with no component using it. Draw-over-other-apps is a high-risk permission on Play.",
  },
  'android.permission.READ_EXTERNAL_STORAGE': {
    decision: 'blocked',
    reason:
      'Declared by expo-image-picker and expo-file-system. The app only calls ImagePicker.launchImageLibraryAsync (src/screens/ScanScreen.tsx), which goes through the system photo picker and needs no storage permission; the picker module only requests this from requestMediaLibraryPermissionsAsync, which the app never calls.',
  },
  'android.permission.WRITE_EXTERNAL_STORAGE': {
    decision: 'blocked',
    reason:
      'Same declarers as READ_EXTERNAL_STORAGE. expo-image-picker requests it only on the pre-Android-10 launchCameraAsync path, which the app does not use (camera capture goes through expo-camera). Play flags legacy broad storage access.',
  },
};

/**
 * Permissions Play treats as sensitive, restricted or legacy-broad. Any of
 * these contributed by a dependency must be either blocked or explicitly
 * justified in CLASSIFICATION with decision `keep` — never merely inherited.
 */
const SENSITIVE_OR_LEGACY = new Set([
  'android.permission.RECORD_AUDIO',
  'android.permission.SYSTEM_ALERT_WINDOW',
  'android.permission.READ_EXTERNAL_STORAGE',
  'android.permission.WRITE_EXTERNAL_STORAGE',
  'android.permission.MANAGE_EXTERNAL_STORAGE',
  'android.permission.QUERY_ALL_PACKAGES',
  'android.permission.ACCESS_FINE_LOCATION',
  'android.permission.ACCESS_COARSE_LOCATION',
  'android.permission.ACCESS_BACKGROUND_LOCATION',
  'android.permission.READ_CONTACTS',
  'android.permission.WRITE_CONTACTS',
  'android.permission.READ_SMS',
  'android.permission.SEND_SMS',
  'android.permission.RECEIVE_SMS',
  'android.permission.READ_CALL_LOG',
  'android.permission.WRITE_CALL_LOG',
  'android.permission.READ_PHONE_STATE',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.SCHEDULE_EXACT_ALARM',
  'android.permission.USE_EXACT_ALARM',
  'android.permission.READ_MEDIA_IMAGES',
  'android.permission.READ_MEDIA_VIDEO',
  'android.permission.READ_MEDIA_AUDIO',
  'android.permission.BODY_SENSORS',
  'android.permission.ACTIVITY_RECOGNITION',
  'android.permission.GET_ACCOUNTS',
]);

/**
 * node_modules manifests that must be found for the dependency scan to mean
 * anything. Without this the scan degrades to "found nothing, therefore
 * everything is fine" when dependencies are not installed.
 */
const SCAN_ANCHORS = [
  'expo-camera',
  'expo-image-picker',
  'expo-notifications',
  'react-native',
];

const BASELINE_PATH = 'docs/play/expected-release-permissions.txt';
const ARTIFACT_VERIFIER = 'scripts/ci/play-artifact-permissions-verify.sh';

// ------------------------------------------------------------------- helpers

function readJson(relative) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, relative), 'utf8'));
}

/** Recursively collect AndroidManifest.xml paths under node_modules. */
function findDependencyManifests(dir, out = [], depth = 0) {
  if (depth > 8) return out;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Gradle output and test fixtures are not shipped manifests.
      if (entry.name === 'build' || entry.name === '.git') continue;
      findDependencyManifests(full, out, depth + 1);
    } else if (entry.name === 'AndroidManifest.xml') {
      out.push(full);
    }
  }
  return out;
}

function declaredPermissions(manifestSource) {
  const found = new Set();
  const re = /<uses-permission[^>]*android:name\s*=\s*"([^"]+)"/g;
  let match;
  while ((match = re.exec(manifestSource)) !== null) found.add(match[1]);
  return found;
}

// ------------------------------------------------- layer 1: app configuration

process.stdout.write('\nLayer 1 — app.base.json permission contract\n');

const appBase = readJson('app.base.json');
const android = appBase.expo.android;

check('android.permissions is exactly the justified allowlist', () => {
  assert.deepEqual(
    [...(android.permissions ?? [])].sort(),
    [...ALLOWED].sort(),
    'app.base.json expo.android.permissions must list only permissions the app itself requests at runtime',
  );
});

check('android.blockedPermissions removes every permission marked blocked', () => {
  const blockedInConfig = new Set(android.blockedPermissions ?? []);
  for (const permission of BLOCKED) {
    assert.ok(
      blockedInConfig.has(permission),
      `${permission} is classified blocked but is missing from expo.android.blockedPermissions — it will merge into the release manifest`,
    );
  }
});

check('every blocked permission is classified, and no permission is both allowed and blocked', () => {
  for (const permission of BLOCKED) {
    assert.equal(
      CLASSIFICATION[permission]?.decision,
      'blocked',
      `${permission} is in BLOCKED but not classified as blocked`,
    );
    assert.ok(
      !ALLOWED.includes(permission),
      `${permission} cannot be both requested and blocked`,
    );
  }
});

check('every classification carries a reason', () => {
  for (const [permission, entry] of Object.entries(CLASSIFICATION)) {
    assert.ok(
      ['keep', 'blocked'].includes(entry.decision),
      `${permission} has an unknown decision "${entry.decision}"`,
    );
    assert.ok(
      typeof entry.reason === 'string' && entry.reason.length > 40,
      `${permission} needs a substantive reason — Play requires a functional justification per permission`,
    );
  }
});

check('expo-camera plugin keeps the microphone off at the source', () => {
  const cameraPlugin = (appBase.expo.plugins ?? []).find(
    (plugin) => Array.isArray(plugin) && plugin[0] === 'expo-camera',
  );
  assert.ok(cameraPlugin, 'expo-camera plugin entry not found in app.base.json');
  assert.equal(
    cameraPlugin[1].microphonePermission,
    false,
    'blockedPermissions is a backstop, not the fix: expo-camera must not request the microphone',
  );
  assert.equal(cameraPlugin[1].recordAudioAndroid, false);
});

// ------------------------------------------- layer 2: dependency attribution

process.stdout.write('\nLayer 2 — dependency permission attribution\n');

const manifestPaths = findDependencyManifests(path.join(ROOT, 'node_modules'));

check('dependency manifest scan actually reached the known declarers', () => {
  assert.ok(
    manifestPaths.length > 0,
    'no AndroidManifest.xml found under node_modules — run npm ci before this gate, otherwise it passes vacuously',
  );
  for (const anchor of SCAN_ANCHORS) {
    assert.ok(
      manifestPaths.some((file) => file.includes(`node_modules/${anchor}/`)),
      `expected to scan a manifest from ${anchor}; the scan is not covering node_modules as intended`,
    );
  }
});

const contributedBy = new Map();
for (const file of manifestPaths) {
  const relative = path.relative(ROOT, file);
  for (const permission of declaredPermissions(fs.readFileSync(file, 'utf8'))) {
    if (!contributedBy.has(permission)) contributedBy.set(permission, []);
    contributedBy.get(permission).push(relative);
  }
}

check('every dependency-declared permission is classified', () => {
  const unclassified = [...contributedBy.keys()].filter(
    (permission) => !(permission in CLASSIFICATION),
  );
  assert.deepEqual(
    unclassified,
    [],
    `a dependency declares ${unclassified.join(', ')} with no entry in CLASSIFICATION. ` +
      'Decide whether the app needs it, add the functional justification, and if not, block it — ' +
      `declarers: ${unclassified.map((p) => contributedBy.get(p).join(', ')).join(' | ')}`,
  );
});

check('no sensitive or legacy permission is silently inherited', () => {
  for (const [permission, declarers] of contributedBy) {
    if (!SENSITIVE_OR_LEGACY.has(permission)) continue;
    const entry = CLASSIFICATION[permission];
    if (entry.decision === 'blocked') {
      assert.ok(
        (android.blockedPermissions ?? []).includes(permission),
        `${permission} is sensitive and classified blocked but not in blockedPermissions`,
      );
    } else {
      assert.ok(
        (android.permissions ?? []).includes(permission),
        `${permission} is sensitive and kept, so it must be declared explicitly in expo.android.permissions ` +
          `rather than inherited from ${declarers.join(', ')}`,
      );
    }
  }
});

check('SYSTEM_ALERT_WINDOW is still only a debug-manifest contribution', () => {
  const declarers = contributedBy.get('android.permission.SYSTEM_ALERT_WINDOW') ?? [];
  for (const declarer of declarers) {
    assert.ok(
      declarer.includes('/debug/'),
      `${declarer} declares SYSTEM_ALERT_WINDOW outside a debug source set. ` +
        'A release-path declarer means some component now genuinely draws over other apps — ' +
        'blocking it would break that feature, so re-audit instead of leaving this gate green.',
    );
  }
});

// -------------------------------------------------- layer 3: Expo behaviour

process.stdout.write('\nLayer 3 — Expo removal behaviour on a seeded manifest\n');

const { AndroidConfig } = require('@expo/config-plugins');
const { Permissions } = AndroidConfig;

// Seed with everything any dependency can contribute, so the assertions below
// describe what Gradle would be handed — not a manifest we curated to pass.
const seeded = {
  manifest: {
    'uses-permission': [...contributedBy.keys()].map((name) => ({
      $: { 'android:name': name },
    })),
  },
};

Permissions.setAndroidPermissions({ android: { permissions: android.permissions } }, seeded);
Permissions.addBlockedPermissions(seeded, android.blockedPermissions);

const emitted = new Map(
  seeded.manifest['uses-permission'].map((entry) => [entry.$['android:name'], entry.$]),
);

check('Expo emits tools:node="remove" for every blocked permission', () => {
  for (const permission of BLOCKED) {
    const attributes = emitted.get(permission);
    assert.ok(attributes, `${permission} disappeared from the manifest instead of being marked for removal`);
    assert.equal(
      attributes['tools:node'],
      'remove',
      `${permission} must carry tools:node="remove"; without it Gradle merges the dependency declaration back in`,
    );
  }
});

check('kept permissions survive the transformation unmarked', () => {
  for (const permission of ALLOWED) {
    const attributes = emitted.get(permission);
    assert.ok(attributes, `${permission} must be present in the emitted manifest`);
    assert.notEqual(
      attributes['tools:node'],
      'remove',
      `${permission} is required by the scan feature and must not be removed`,
    );
  }
});

check('a permission absent from the blocklist is left intact — the gate is not removing everything', () => {
  const kept = [...contributedBy.keys()].filter(
    (permission) => CLASSIFICATION[permission].decision === 'keep',
  );
  assert.ok(kept.length > 0, 'expected at least one kept dependency permission to assert against');
  for (const permission of kept) {
    assert.notEqual(
      emitted.get(permission)?.['tools:node'],
      'remove',
      `${permission} is classified keep but was marked for removal`,
    );
  }
});

// ------------------------------------------------ layer 4: artifact baseline

process.stdout.write('\nLayer 4 — built-artifact baseline and verifier\n');

function baselinePermissions() {
  return fs
    .readFileSync(path.join(ROOT, BASELINE_PATH), 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'));
}

check(`${BASELINE_PATH} exists and is a sorted, unique permission list`, () => {
  const lines = baselinePermissions();
  assert.ok(lines.length > 0, `${BASELINE_PATH} lists no permissions`);
  assert.deepEqual(
    lines,
    [...new Set(lines)].sort(),
    `${BASELINE_PATH} must be sorted and free of duplicates so a diff against aapt2 output is readable`,
  );
  for (const permission of BLOCKED) {
    assert.ok(
      !lines.includes(permission),
      `${permission} is blocked in app.base.json but still expected in ${BASELINE_PATH}`,
    );
  }
  for (const permission of ALLOWED) {
    assert.ok(lines.includes(permission), `${permission} is requested but missing from ${BASELINE_PATH}`);
  }
});

/**
 * The baseline is the ONLY control the artifact verifier diffs against, which makes it
 * the weak point of the whole scheme: quietly adding a line here would let a real
 * permission through the artifact check unnoticed. So the baseline's own contents are
 * constrained, not merely its formatting.
 *
 * Every platform permission it lists must be one the app requests, one classified `keep`,
 * or one of the normal-level permissions the notification stack's Maven AARs contribute.
 * Vendor-namespaced entries (launcher badges, Firebase, the app's own androidx-scoped
 * receiver permission) are matched by prefix because they are numerous and all
 * normal-level — `permissions.md` attributes them.
 */
const INHERITED_NORMAL = new Set([
  'android.permission.INTERNET',
  'android.permission.ACCESS_NETWORK_STATE',
  'android.permission.WAKE_LOCK',
  'android.permission.VIBRATE',
  'android.permission.READ_APP_BADGE',
  'android.permission.RECEIVE_BOOT_COMPLETED',
  'android.permission.POST_NOTIFICATIONS',
]);

const VENDOR_PREFIXES = [
  'com.google.android.',
  'com.sec.android.',
  'com.htc.launcher.',
  'com.sonyericsson.home.',
  'com.sonymobile.home.',
  'com.anddoes.launcher.',
  'com.majeur.launcher.',
  'com.huawei.android.launcher.',
  'com.oppo.launcher.',
  'me.everything.badger.',
  'com.dicoge.holohunter.',
];

check(`${BASELINE_PATH} cannot be padded with an unjustified permission`, () => {
  for (const permission of baselinePermissions()) {
    if (ALLOWED.includes(permission)) continue;
    if (INHERITED_NORMAL.has(permission)) continue;
    if (CLASSIFICATION[permission]?.decision === 'keep') continue;
    if (VENDOR_PREFIXES.some((prefix) => permission.startsWith(prefix))) continue;
    assert.fail(
      `${BASELINE_PATH} expects ${permission}, which is neither requested by the app, classified ` +
        'as kept, nor a known normal-level contribution. The baseline is what the artifact ' +
        'verifier trusts, so adding a line here silently widens what the release may request. ' +
        'Justify it in CLASSIFICATION or in INHERITED_NORMAL, with the reason, before listing it.',
    );
  }
});

check(`${BASELINE_PATH} never expects a sensitive permission the app does not request`, () => {
  for (const permission of baselinePermissions()) {
    if (!SENSITIVE_OR_LEGACY.has(permission)) continue;
    assert.ok(
      ALLOWED.includes(permission),
      `${permission} is sensitive and appears in ${BASELINE_PATH} without being requested in ` +
        'expo.android.permissions. A sensitive permission must never be tolerated by the ' +
        'artifact verifier unless the app deliberately asks for it.',
    );
  }
});

check(`${ARTIFACT_VERIFIER} exists, is executable and reads the baseline`, () => {
  const full = path.join(ROOT, ARTIFACT_VERIFIER);
  const source = fs.readFileSync(full, 'utf8');
  assert.ok(
    (fs.statSync(full).mode & 0o111) !== 0,
    `${ARTIFACT_VERIFIER} must be executable or CI cannot invoke it`,
  );
  assert.ok(
    source.includes(BASELINE_PATH.split('/').pop()),
    `${ARTIFACT_VERIFIER} must compare against ${BASELINE_PATH}`,
  );
  assert.ok(
    source.includes('aapt2'),
    `${ARTIFACT_VERIFIER} must read the real merged manifest via aapt2, not restate the config`,
  );
  assert.ok(
    /set -euo pipefail/.test(source),
    `${ARTIFACT_VERIFIER} must fail closed`,
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
