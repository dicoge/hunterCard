#!/usr/bin/env node
/**
 * Privacy-policy / code agreement (DIC-1248, re-derived 2026-10-14).
 *
 * Two-directional, as before: read the code to decide whether card photos leave the
 * device, then require the published policy to say the same. The DIRECTION flipped on
 * 2026-10-14 (owner decision: "正式支援上傳照片給 AI 並同步隱私告知"):
 *
 *   - native capture now returns the photo bytes (`base64: true`) and recognizeViaApi
 *     uploads a validated data URL to /api/recognize-card, which forwards it to Google
 *     Gemini. The old accidental behaviour (posting a `file://` path Gemini could not
 *     decode) is gone.
 *   - an in-app disclosure + consent gates the first upload.
 *
 * So this gate now fails if the code uploads WITHOUT the consent gate, or if the policy
 * still promises on-device recognition / makes a Google retention promise, or if the
 * upload path loses its image validation. The behavioural bytes-on-the-wire proof is
 * scripts/test-native-scan-no-image-upload.mjs; the server + copy proof is
 * scripts/test-native-ai-photo-upload.mjs.
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

// ------------------------------------- do card photos leave the device, and how?

process.stdout.write('\nWhat the native scan actually transmits (upload direction since 2026-10-14)\n');

const recognition = read('src/services/cardRecognition.ts');

check('native capture and library pick request the photo bytes', () => {
  assert.ok(/takePictureAsync\(\{\s*quality: 0\.7,\s*base64: true,/.test(scanScreen), 'camera capture must request base64');
  assert.ok(/base64: !isWeb,/.test(scanScreen), 'library pick must request base64 on native');
});

check('every upload path is gated by the photo-upload disclosure', () => {
  assert.ok(/requestPhotoUploadConsent/.test(scanScreen) && /hasUploadConsent\(\)/.test(scanScreen),
    'ScanScreen must ask for consent before uploading — Play requires a prominent disclosure before collection');
});

check('the upload path still exists and only sends a validated image data URL', () => {
  assert.ok(/recognizeViaApi/.test(recognition) && /\/api\/recognize-card/.test(recognition));
  assert.ok(/buildRecognitionDataUrl/.test(recognition) && /validateRecognitionDataUrl/.test(recognition),
    'cardRecognition must build/validate the payload with recognitionImagePolicy');
  assert.ok(!/data:image\/jpeg;base64,\$\{imageUri\}/.test(recognition), 'a uri must never be wrapped as base64');
});

check('the web preprocessor is still DOM-only and is not the native byte source', () => {
  assert.ok(/new Image\(\)/.test(preprocessor) && /document\.createElement/.test(preprocessor));
  for (const variant of ['src/services/imagePreprocessor.native.ts', 'src/services/imagePreprocessor.android.ts', 'src/services/imagePreprocessor.ios.ts']) {
    assert.ok(!fs.existsSync(path.join(ROOT, variant)), `${variant} appeared — re-derive the payload contract`);
  }
});

// ------------------------------------------ policy must match that direction

process.stdout.write('\nThe published policy must describe the same behaviour\n');

check('the policy states that mobile uploads the image too (both languages)', () => {
  for (const claim of ['手機 App（iOS / Android）與網頁版皆會上傳影像', 'The image is uploaded on mobile (iOS / Android) as well as on the web']) {
    assert.ok(policy.includes(claim), `public/privacy.html must state "${claim}"`);
  }
});

check('the policy no longer promises the image stays on the device', () => {
  for (const claim of ['卡牌影像都不會離開您的裝置', 'the card image never leaves your device']) {
    assert.ok(!policy.includes(claim), `public/privacy.html still claims "${claim}"`);
  }
});

check('the policy discloses our endpoint, Google Gemini, and the consent step', () => {
  for (const phrase of ['/api/recognize-card', 'Google Gemini', '同意並上傳', 'Agree and upload']) {
    assert.ok(policy.includes(phrase), `public/privacy.html must mention "${phrase}"`);
  }
});

check('the policy makes no promise about Google-side retention or training', () => {
  assert.ok(policy.includes('無法代 Google 承諾') && policy.includes("cannot make promises on Google's behalf"));
});

check('the policy discloses that captured photos are written to the app cache', () => {
  assert.ok(
    policy.includes('快取') && /cache/i.test(policy),
    'takePictureAsync writes the photo to the app cache directory and the app does not clear it.',
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
    `a billing dependency (${billing.join(', ')}) was added. This is expected eventually — the ` +
      'owner chose a monthly subscription as the launch product on 2026-08-30 — but it cannot ' +
      'ship while the published privacy policy still tells users there is no payment mechanism ' +
      'at all. Before removing this gate, work through docs/play/subscription.md: update the ' +
      'privacy policy in both languages, switch Data safety Financial info -> Purchase history ' +
      'to collected, answer what happens to purchase records on account deletion, flip both App ' +
      'content purchase questions and re-run the content rating questionnaire, and confirm the ' +
      'purchase flow uses Google Play Billing rather than linking out to web checkout.',
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
