#!/usr/bin/env node
/**
 * Privacy-policy / code agreement (DIC-1248).
 *
 * The Play Data safety answer for Photos rests on one fact: the native binary
 * does not transmit card image bytes off-device. That fact is NOT obvious from
 * reading the call graph, and it is easy to break by accident.
 *
 * Reading the call graph alone suggests the opposite. recognizeCardFromImage()
 * calls recognizeViaApi() as step 0 on every platform, and recognizeViaApi()
 * POSTs `{ image }` to /api/recognize-card, which forwards to Google Gemini. It
 * looks like every scan uploads a photo. It does not, because of what
 * preprocessCardImage() returns on native:
 *
 *   - src/services/imagePreprocessor.ts is written entirely against the DOM
 *     (`new Image()`, `document.createElement('canvas')`, `canvas.toDataURL`).
 *   - React Native polyfills fetch, Blob, File, FileReader, URL and friends, but
 *     defines no global `Image` and no `document`.
 *   - So on native `new Image()` throws inside the promise executor, the outer
 *     try/catch returns the ORIGINAL uri, and that uri is a `file:///...` path.
 *   - ScanScreen never requests base64 — `takePictureAsync({ quality: 0.8 })`
 *     and `launchImageLibraryAsync({ quality: 0.8 })` both yield a path.
 *
 * What is POSTed on native is therefore a local file path string, not image
 * data. Gemini cannot decode it, recognition fails, and the local OCR fallback
 * runs. No pixels leave the device.
 *
 * That makes the Photos = "not collected" answer correct today and fragile
 * tomorrow. Adding a native image preprocessor (expo-image-manipulator, a
 * `.native.ts` variant) or passing `base64: true` would start uploading real
 * photos silently, with no test failing and the published policy still promising
 * the opposite. This gate is the thing that fails in that case.
 *
 * It is two-directional: it reads the code to decide whether image bytes can
 * leave the device, then requires the policy to match that direction. Neither
 * side can be edited alone.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

const preprocessor = read('src/services/imagePreprocessor.ts');
const scanScreen = read('src/screens/ScanScreen.tsx');
const policy = read('public/privacy.html');

// ------------------------------------- can image bytes leave the device?

process.stdout.write('\nWhat the native scan can actually transmit\n');

check('the image preprocessor is still DOM-only, so it returns its input unchanged on native', () => {
  assert.ok(
    /new Image\(\)/.test(preprocessor) && /document\.createElement/.test(preprocessor),
    'imagePreprocessor.ts no longer looks like browser-only code. If it gained a native ' +
      'implementation, scans now upload real image bytes — re-answer Data safety for Photos ' +
      'and update the privacy policy before changing this gate.',
  );
  assert.ok(
    /catch\s*\{[\s\S]{0,120}return imageUri;/.test(preprocessor),
    'preprocessCardImage must still fall back to returning the original uri when the DOM path ' +
      'throws; that fallback is the reason no pixels leave the device on native.',
  );
});

check('no native-only image preprocessor variant has been added', () => {
  for (const variant of [
    'src/services/imagePreprocessor.native.ts',
    'src/services/imagePreprocessor.android.ts',
    'src/services/imagePreprocessor.ios.ts',
  ]) {
    assert.ok(
      !fs.existsSync(path.join(ROOT, variant)),
      `${variant} exists. A native preprocessor would produce real base64 image data, which ` +
        'recognizeViaApi would then upload. Photos would become collected data.',
    );
  }
});

check('no native image-manipulation dependency that could produce base64 has appeared', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const manipulators = deps.filter((name) =>
    /^expo-image-manipulator$|^react-native-image-resizer|^@bam\.tech\/react-native-image-resizer/.test(name),
  );
  assert.deepEqual(
    manipulators,
    [],
    `${manipulators.join(', ')} was added. It can turn a file uri into base64 on native, which ` +
      'is exactly what would start uploading card photos. Re-answer Data safety before allowing this.',
  );
});

check('the scan never requests base64 from the camera or the picker', () => {
  assert.ok(
    !/base64:\s*true/.test(scanScreen),
    'ScanScreen requests base64 image data. That data would be POSTed to /api/recognize-card, ' +
      'so card photos would leave the device — Photos must then be declared as collected.',
  );
});

// The gate is only meaningful while the recognition call actually exists.
check('the recognition upload path still exists and is still measured', () => {
  const recognition = read('src/services/cardRecognition.ts');
  assert.ok(
    /recognizeViaApi/.test(recognition) && /\/api\/recognize-card/.test(recognition),
    'cardRecognition.ts no longer posts to /api/recognize-card — re-derive this gate against the ' +
      'new code rather than deleting it.',
  );
});

// ------------------------------------------ policy must match that direction

process.stdout.write('\nThe published policy must describe the same behaviour\n');

check('the policy tells mobile users their card image stays on the device', () => {
  for (const claim of ['卡牌影像都不會離開您的裝置', 'the card image never leaves your device']) {
    assert.ok(
      policy.includes(claim),
      `public/privacy.html must state "${claim}". On native the image is recognised on-device and ` +
        'no pixels are transmitted; the policy has to say so in both languages.',
    );
  }
});

check('the policy still discloses the web upload to Google Gemini', () => {
  for (const phrase of ['/api/recognize-card', 'Google Gemini']) {
    assert.ok(
      policy.includes(phrase),
      `public/privacy.html must keep disclosing "${phrase}" — the web build does upload the image.`,
    );
  }
});

check('the policy does not claim a mobile upload that does not happen', () => {
  for (const claim of [
    '手機 App（iOS / Android）與網頁版皆會上傳影像',
    'The image is uploaded on mobile (iOS / Android) as well as on the web',
  ]) {
    assert.ok(
      !policy.includes(claim),
      `public/privacy.html claims "${claim}", but native recognition runs on-device. ` +
        'Over-declaring is a mismatch too — Play compares the policy against the Data safety form.',
    );
  }
});

check('the policy discloses that captured photos are written to the app cache', () => {
  assert.ok(
    policy.includes('快取') && /cache/i.test(policy),
    'takePictureAsync writes the photo to the app cache directory and the app does not clear it. ' +
      'The policy must not imply the photo is held only in memory.',
  );
});

// ------------------------------------- other claims with a source in this repo

process.stdout.write('\nOther policy claims that have a verifiable source in this repo\n');

check('the policy does not deny having cloud data while a deletion backend exists', () => {
  assert.ok(
    fs.existsSync(path.join(ROOT, 'api/auth/delete-account.ts')),
    'expected api/auth/delete-account.ts to exist',
  );
  for (const claim of [
    '目前並沒有任何雲端帳號或資料需要刪除',
    'There is currently no cloud account or data to delete',
  ]) {
    assert.ok(
      !policy.includes(claim),
      `public/privacy.html claims "${claim}" while api/auth/delete-account.ts cascade-deletes a real ` +
        "cloud account. Play's mandatory data-deletion declaration is built from this section.",
    );
  }
});

check('the policy does not claim to store financial data while no billing is integrated', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const billing = deps.filter((name) =>
    /stripe|revenuecat|react-native-iap|expo-in-app-purchases|braintree|paddle/i.test(name),
  );
  assert.deepEqual(
    billing,
    [],
    `a billing dependency (${billing.join(', ')}) was added. Data safety must now declare purchase ` +
      'data, and an Android subscription must go through Google Play Billing.',
  );
  for (const claim of ['記錄您的交易代碼', 'Logs your transaction identifier']) {
    assert.ok(
      !policy.includes(claim),
      `public/privacy.html claims "${claim}" but no payment integration exists.`,
    );
  }
});

check('the policy still tells users the push token has no self-service deletion', () => {
  const hasUnregister =
    fs.existsSync(path.join(ROOT, 'api/push/unregister.ts')) ||
    /unregister/i.test(read('api/push/register.ts'));
  if (hasUnregister) {
    assert.fail(
      'a push unregister path now exists — update the policy and answer "users can request deletion" in Data safety',
    );
  }
  assert.ok(
    policy.includes('推播 Token 不會被上述刪除流程移除') &&
      policy.includes('The push token is not removed by the deletion flow above'),
    'no unregister endpoint exists, so the policy must keep telling users the push token survives ' +
      'account deletion and needs an email request',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
