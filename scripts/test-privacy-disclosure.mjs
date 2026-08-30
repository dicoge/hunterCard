#!/usr/bin/env node
/**
 * Privacy-policy / code agreement (DIC-1248).
 *
 * The failure this guards against is the one found while preparing the Play
 * submission: the published privacy policy at /privacy stated
 *
 *   "手機 App（iOS / Android）：文字辨識 (OCR) 完全在您的裝置本機進行，
 *    卡牌影像不會離開您的裝置，也不會上傳到我們的伺服器。"
 *
 * while src/services/cardRecognition.ts uploads the image to
 * /api/recognize-card — which forwards it to Google Gemini — as Step 0 of every
 * scan on every platform, with on-device OCR only as the fallback. A store
 * submission whose Data safety answers are built on that sentence is a false
 * declaration, and Play enforces against exactly that.
 *
 * The check is deliberately two-directional. It does not hard-code "the policy
 * must say images are uploaded": it reads the code first, decides whether the
 * upload path exists, and then requires the policy to match whichever way the
 * code actually behaves. Removing the upload from the code without updating the
 * policy fails too — the gate cannot be satisfied by editing only one side.
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

const recognition = read('src/services/cardRecognition.ts');
const scanFlow = read('src/services/scanRecognitionFlow.ts');
const policy = read('public/privacy.html');

// ------------------------------------------------- what the code actually does

/**
 * The native scan uploads the image if runNativeCameraScan reaches
 * recognizeCardFromImage (through the ScanFlowIo.recognizeFromImage port) and
 * recognizeCardFromImage posts the image to the recognition endpoint.
 */
function nativeScanUploadsImages() {
  const nativeFlow = scanFlow.slice(scanFlow.indexOf('export async function runNativeCameraScan'));
  const nativeReachesRecognizer = /io\.recognizeFromImage\s*\(/.test(
    nativeFlow.slice(0, nativeFlow.indexOf('export async function', 40) + 1 || undefined),
  );

  const recognizerBody = recognition.slice(
    recognition.indexOf('export async function recognizeCardFromImage'),
  );
  const recognizerCallsApi = /recognizeViaApi\s*\(/.test(recognizerBody);

  const apiPostsImage =
    /\/api\/recognize-card/.test(recognition) && /body:\s*JSON\.stringify\(\{\s*image/.test(recognition);

  return nativeReachesRecognizer && recognizerCallsApi && apiPostsImage;
}

const uploadsImages = nativeScanUploadsImages();

check('the scan upload path is determined from the code, not assumed', () => {
  // Both halves of the disjunction below are real states; what must never
  // happen is being unable to tell. If the shape of the code changed enough
  // that neither pattern matches, this gate has stopped measuring anything.
  assert.ok(
    /recognizeViaApi/.test(recognition),
    'cardRecognition.ts no longer contains recognizeViaApi — this gate can no longer tell whether images leave the device. Re-derive the check against the new code before editing the policy.',
  );
  assert.ok(
    /runNativeCameraScan/.test(scanFlow),
    'scanRecognitionFlow.ts no longer exports runNativeCameraScan — re-derive this gate.',
  );
});

// ------------------------------------------------ policy must match the code

// Claims that are only true when nothing is uploaded, in both languages.
const ON_DEVICE_ONLY_CLAIMS = [
  '卡牌影像不會離開您的裝置',
  '不會上傳到我們的伺服器',
  'never leaves your device',
  'is not uploaded to our servers',
  '手機 App 的辨識則在裝置端完成、不上傳',
  'recognition runs on-device and images are not uploaded',
];

// Disclosures that must be present when images do leave the device.
const UPLOAD_DISCLOSURES_ZH = ['/api/recognize-card', 'Google Gemini', '備援'];
const UPLOAD_DISCLOSURES_EN = ['/api/recognize-card', 'Google Gemini', 'fallback'];

if (uploadsImages) {
  process.stdout.write('\nCode uploads scan images off-device — asserting the policy discloses it\n');

  check('the policy makes no on-device-only claim', () => {
    for (const claim of ON_DEVICE_ONLY_CLAIMS) {
      assert.ok(
        !policy.includes(claim),
        `public/privacy.html still claims "${claim}", but the native scan posts the image to /api/recognize-card. ` +
          'Publishing this while submitting to Play is a false Data safety declaration.',
      );
    }
  });

  check('the policy names the endpoint, the third party and the fallback (zh)', () => {
    for (const phrase of UPLOAD_DISCLOSURES_ZH) {
      assert.ok(
        policy.includes(phrase),
        `public/privacy.html must disclose "${phrase}" in the Chinese section — users have to be told where their photo goes`,
      );
    }
  });

  check('the policy names the endpoint, the third party and the fallback (en)', () => {
    for (const phrase of UPLOAD_DISCLOSURES_EN) {
      assert.ok(
        policy.includes(phrase),
        `public/privacy.html must disclose "${phrase}" in the English section`,
      );
    }
  });

  check('the disclosure covers gallery images, not only the camera', () => {
    assert.ok(
      policy.includes('從相簿選取') || policy.includes('photo library'),
      'ScanScreen passes gallery picks through the same uploading recognizer, so the policy must not describe this as camera-only',
    );
  });
} else {
  process.stdout.write('\nCode keeps scan images on-device — asserting the policy no longer claims otherwise\n');

  check('the policy does not still disclose an upload that no longer happens', () => {
    assert.ok(
      !policy.includes('手機 App 與網頁版皆會上傳影像'),
      'the native upload path is gone; public/privacy.html still tells users their images are uploaded. Update the policy in the same change.',
    );
  });
}

// ------------------------------------- other policy claims with a code source

process.stdout.write('\nOther policy claims that have a verifiable source in this repo\n');

check('the policy does not deny having cloud data while a deletion backend exists', () => {
  const hasDeletionEndpoint = fs.existsSync(path.join(ROOT, 'api/auth/delete-account.ts'));
  assert.ok(hasDeletionEndpoint, 'expected api/auth/delete-account.ts to exist');
  for (const claim of [
    '目前並沒有任何雲端帳號或資料需要刪除',
    'There is currently no cloud account or data to delete',
  ]) {
    assert.ok(
      !policy.includes(claim),
      `public/privacy.html claims "${claim}" while api/auth/delete-account.ts cascade-deletes a real cloud account. ` +
        "Play's mandatory data-deletion declaration is built from this section.",
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
    `a billing dependency (${billing.join(', ')}) was added. Data safety must now declare purchase data, ` +
      'and an Android subscription must go through Google Play Billing — re-answer the questionnaire before shipping.',
  );
  for (const claim of [
    '記錄您的交易代碼',
    'Logs your transaction identifier',
  ]) {
    assert.ok(
      !policy.includes(claim),
      `public/privacy.html claims "${claim}" but no payment integration exists. Over-declaring collection is also a mismatch.`,
    );
  }
});

check('the policy still tells users the push token has no self-service deletion', () => {
  const hasUnregisterEndpoint =
    fs.existsSync(path.join(ROOT, 'api/push/unregister.ts')) ||
    /unregister/i.test(read('api/push/register.ts'));
  if (hasUnregisterEndpoint) {
    assert.fail(
      'a push unregister path now exists — update the policy and answer "users can request deletion" in Data safety',
    );
  }
  assert.ok(
    policy.includes('推播 Token 不會被上述刪除流程移除') &&
      policy.includes('The push token is not removed by the deletion flow above'),
    'no unregister endpoint exists, so the policy must keep telling users the push token survives account deletion and needs an email request',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
