#!/usr/bin/env node
/**
 * Behavioural proof that a native scan transmits no image bytes (DIC-1248).
 *
 * The Play Data safety answer "Photos: not collected" rests entirely on this.
 * A sibling gate, test-privacy-disclosure.mjs, checks the *mechanisms* that
 * currently make it true — the DOM-only preprocessor, no base64 request, no
 * image-manipulation dependency. Adversarial review showed that enumerating
 * mechanisms is not enough: real pixels can be uploaded using nothing but React
 * Native built-ins, e.g. `await (await fetch(uri)).blob()` piped through
 * `FileReader.readAsDataURL` inside recognizeViaApi, adding no dependency and
 * touching neither the preprocessor nor the capture options. Every static check
 * still passed while the app uploaded photos.
 *
 * So this gate does not describe how the code avoids uploading. It runs the real
 * recognizeCardFromImage under React-Native-shaped globals — `window === global`
 * with no `location`, and no `Image`, `document` or `HTMLCanvasElement` — with
 * `fetch` intercepted, and asserts on the bytes that would go out:
 *
 *   the value POSTed as `image` must be the input uri, unchanged.
 *
 * Any route to real image data changes that value, whatever mechanism produces
 * it, so this fails on mechanisms nobody has thought of yet.
 *
 * Two modules are aliased to keep the probe honest and cheap: `react-native`,
 * whose real entry point is Flow-typed and cannot be parsed by node, is reduced
 * to the `Platform` shape the recognition path reads; and `./webOcr`, the local
 * OCR fallback, is stubbed so the probe measures the network call rather than
 * running Tesseract. Neither stub sits between the image and the network —
 * imagePreprocessor and cardRecognition are the real modules.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ------------------------------------------------------------ module aliasing

register(
  'data:text/javascript,' +
    encodeURIComponent(`
      import { existsSync } from 'node:fs';
      import { fileURLToPath } from 'node:url';
      import { extname } from 'node:path';

      const RN_STUB = 'data:text/javascript,' + encodeURIComponent(
        "export const Platform = { OS: 'android', select: (o) => (o.android !== undefined ? o.android : o.default) };" +
        "export default { Platform };"
      );
      const OCR_STUB = 'data:text/javascript,' + encodeURIComponent(
        "export async function recognizeCardNumber() { return { cardId: null, rawText: '' }; }" +
        "export async function performOcr() { return ''; }" +
        "export async function recognizeCardFromOcr() { return { success: false }; }"
      );

      export async function resolve(specifier, context, next) {
        if (specifier === 'react-native') return { url: RN_STUB, shortCircuit: true };
        if (specifier === './webOcr' || specifier.endsWith('/webOcr')) {
          return { url: OCR_STUB, shortCircuit: true };
        }
        const isRelative = specifier.startsWith('./') || specifier.startsWith('../');
        if (isRelative && extname(specifier) === '' && context.parentURL) {
          const candidate = new URL(specifier + '.ts', context.parentURL);
          if (existsSync(fileURLToPath(candidate))) return next(candidate.href, context);
          const index = new URL(specifier + '/index.ts', context.parentURL);
          if (existsSync(fileURLToPath(index))) return next(index.href, context);
        }
        return next(specifier, context);
      }
    `),
  import.meta.url,
);

// ------------------------------------------------- React-Native-shaped globals

// React Native sets window = global and nothing else (Libraries/Core/setUpGlobals.js).
// There is no location, no document, no Image, no canvas. Establish exactly that,
// so the probe cannot accidentally succeed because node happens to expose a DOM.
delete globalThis.document;
delete globalThis.Image;
delete globalThis.HTMLCanvasElement;
globalThis.window = globalThis;
delete globalThis.window.location;

check('the probe really is running without a DOM', () => {
  assert.equal(typeof globalThis.Image, 'undefined', 'Image must be undefined, as on React Native');
  assert.equal(typeof globalThis.document, 'undefined', 'document must be undefined, as on React Native');
  assert.equal(globalThis.window, globalThis, 'React Native sets window = global');
  assert.equal(
    globalThis.window.location,
    undefined,
    'window.location must be undefined; cardRecognition uses it to pick the web origin',
  );
});

// ------------------------------------------------------------- capture fetch

// The probe must let a would-be uploader succeed, otherwise it proves nothing:
// if reading the local file always failed here, a real bypass would fall back to
// posting the uri and look identical to correct behaviour. So local-file reads
// are served with plausible image bytes, and React Native's FileReader — which
// node does not provide but the runtime does — is supplied. The bypass is given
// everything it needs to work; the assertion below is what catches it.
const FAKE_IMAGE_BYTES = Buffer.from('\xFF\xD8\xFF\xE0'.repeat(64) + 'probe-jpeg-body', 'binary');

globalThis.FileReader = class {
  readAsDataURL(blob) {
    this.result = `data:image/jpeg;base64,${FAKE_IMAGE_BYTES.toString('base64')}`;
    queueMicrotask(() => this.onloadend?.({ target: this }) ?? this.onload?.({ target: this }));
  }
  readAsArrayBuffer() {
    this.result = FAKE_IMAGE_BYTES.buffer;
    queueMicrotask(() => this.onloadend?.({ target: this }) ?? this.onload?.({ target: this }));
  }
};

const captured = [];

// Every outbound transport must be watched, not just the one the current code
// happens to use. React Native implements fetch on top of XMLHttpRequest and
// exposes both, so a gate that only wraps fetch can be walked around by calling
// XHR directly.
globalThis.XMLHttpRequest = class {
  open(method, url) {
    this._url = String(url);
  }
  setRequestHeader() {}
  send(body) {
    captured.push({ url: this._url, body, transport: 'xhr' });
    this.status = 0;
    this.readyState = 4;
    queueMicrotask(() => this.onerror?.(new Error('probe: network intercepted')));
  }
  abort() {}
};

globalThis.fetch = async (url, init) => {
  const href = String(url);

  // Reading the captured photo off local storage — let it succeed.
  if (href.startsWith('file:') || href.startsWith('content:')) {
    return {
      ok: true,
      status: 200,
      blob: async () => new Blob([FAKE_IMAGE_BYTES], { type: 'image/jpeg' }),
      arrayBuffer: async () => FAKE_IMAGE_BYTES.buffer,
      text: async () => FAKE_IMAGE_BYTES.toString('binary'),
    };
  }

  captured.push({ url: href, body: init?.body });
  // Fail the outbound call the way an unreachable backend would, so the caller
  // takes its normal fallback path instead of parsing a fabricated success.
  throw new Error('probe: network intercepted');
};

const { recognizeCardFromImage } = await import(
  pathToFileURL(path.join(ROOT, 'src/services/cardRecognition.ts')).href
);

// Both real entry points: a camera capture path and an Android gallery pick.
const INPUTS = [
  'file:///data/user/0/com.dicoge.holohunter/cache/Camera/scan-1.jpg',
  'content://media/external/images/media/1024',
];

const BASE64_ISH = /^[A-Za-z0-9+/]{64,}={0,2}$/;

for (const uri of INPUTS) {
  captured.length = 0;
  await recognizeCardFromImage(uri).catch(() => {});

  check(`no image bytes are transmitted for ${uri.slice(0, 34)}…`, () => {
    assert.ok(
      captured.length > 0,
      'the recognition call made no request at all; the probe measured nothing. Re-derive it against the current code.',
    );

    for (const request of captured) {
      assert.ok(
        typeof request.body === 'string' || request.body == null,
        `request to ${request.url} sent a non-string body (${Object.prototype.toString.call(request.body)}). ` +
          'A Blob, FormData or ArrayBuffer body is exactly how image bytes would leave the device.',
      );

      // Look at the ENTIRE request — url and body, whatever the field is named
      // and whatever endpoint it goes to. Checking only the `image` field of the
      // recognition call would miss an upload under another key, to another
      // host, or over another transport.
      const wire = `${request.url} ${request.body ?? ''}`;
      assert.ok(
        !/data:image\//i.test(wire),
        `a request to ${request.url} carries a data:image payload. Encoded image content is ` +
          'leaving the device, whatever field or transport it travels in.',
      );
      assert.ok(
        !/[A-Za-z0-9+/]{200,}={0,2}/.test(wire),
        `a request to ${request.url} carries a long base64 run, which is what encoded image ` +
          'content looks like on the wire.',
      );

      if (request.body == null) continue;
      let payload;
      try {
        payload = JSON.parse(request.body);
      } catch {
        continue; // non-JSON body already covered by the wire checks above
      }
      if (!('image' in payload)) continue;

      assert.equal(
        payload.image,
        uri,
        `the value POSTed as "image" is no longer the uri that was passed in. Something now converts ` +
          'the photo into transmittable data before the request, so card images DO leave the device. ' +
          'Google Play Data safety must declare Photos as collected, the privacy policy must stop ' +
          'promising on-device recognition, and a prominent in-app disclosure is required before the ' +
          'first upload. Update all three, then update this gate.',
      );
      assert.ok(
        !String(payload.image).startsWith('data:'),
        'the posted image is a data: URI — that is encoded image content leaving the device.',
      );
      assert.ok(
        !BASE64_ISH.test(String(payload.image)),
        'the posted image looks like a base64 payload rather than a uri.',
      );
    }
  });
}

check('the request that is made is the recognition endpoint, so the probe hit the real path', () => {
  assert.ok(
    captured.some((request) => request.url.includes('/api/recognize-card')),
    'no request to /api/recognize-card was observed; the probe did not exercise the upload path it exists to measure',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
