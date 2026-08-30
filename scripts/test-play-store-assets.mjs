#!/usr/bin/env node
/**
 * Play store-listing asset invariants (DIC-1259).
 *
 * The failure this guards against: uploading a store icon Play rejects at the
 * form level, or screenshots in a channel format Play refuses. DIC-1257 caught
 * exactly this after a dimensions-only check had let a wrong-channel-format
 * PNG through: the committed 512x512 icon was written as 8-bit RGB by macOS
 * `sips` (Play requires 32-bit RGBA), and phone screenshots captured via
 * `adb screencap -p` were 8-bit RGBA (Play requires 24-bit RGB). Dimensions
 * were fine, everyone signed off, and the store submission would have failed
 * at the first upload prompt.
 *
 * A dimensions-only assertion cannot catch a channel-format regression. Read
 * the PNG IHDR chunk directly here and require the exact colour type Play
 * documents for each surface:
 *   - 512x512 listing icon        -> 32-bit RGBA (IHDR colour type 6)
 *   - 1024x500 feature graphic    -> 24-bit RGB  (IHDR colour type 2)
 *   - 320..3840 phone screenshots -> 24-bit RGB  (IHDR colour type 2)
 *
 * The IHDR chunk is the only source of truth: some encoders write RGB pixel
 * data into a 4-channel container (and vice versa), so this reader parses the
 * chunk header rather than counting the buffer length.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs/play/store-listing');

let checks = 0;
function check(label, fn) {
  fn();
  checks += 1;
  process.stdout.write(`  ok  ${label}\n`);
}

// ------------------------------------------------------ IHDR / colour reader

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// IHDR is always the first chunk after the 8-byte signature. Layout:
//   4 bytes  length (always 13)
//   4 bytes  chunk type ("IHDR")
//  13 bytes  data: 4 width, 4 height, 1 bit depth, 1 colour type,
//                  1 compression, 1 filter, 1 interlace
//   4 bytes  CRC
function readIhdr(buffer) {
  assert.ok(
    buffer.length >= 8 + 4 + 4 + 13 + 4,
    'buffer too small to contain a PNG signature and IHDR',
  );
  assert.ok(
    buffer.slice(0, 8).equals(PNG_SIGNATURE),
    'file is not a PNG (missing signature)',
  );
  const length = buffer.readUInt32BE(8);
  assert.equal(length, 13, 'first chunk length is not 13; IHDR must be the first chunk');
  const type = buffer.slice(12, 16).toString('ascii');
  assert.equal(type, 'IHDR', 'first chunk type is not IHDR');
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
    bitDepth: buffer.readUInt8(24),
    colorType: buffer.readUInt8(25),
    compression: buffer.readUInt8(26),
    filter: buffer.readUInt8(27),
    interlace: buffer.readUInt8(28),
  };
}

const COLOR_TYPE_LABEL = {
  0: 'grayscale',
  2: 'RGB (24-bit)',
  3: 'palette',
  4: 'grayscale + alpha',
  6: 'RGBA (32-bit)',
};

function describe(ihdr) {
  return `${ihdr.width}x${ihdr.height} ${COLOR_TYPE_LABEL[ihdr.colorType] ?? `colorType=${ihdr.colorType}`}, bitDepth=${ihdr.bitDepth}`;
}

function readPng(name) {
  const filePath = path.join(OUT_DIR, name);
  assert.ok(fs.existsSync(filePath), `${path.relative(ROOT, filePath)} is missing`);
  return { ihdr: readIhdr(fs.readFileSync(filePath)), path: filePath };
}

// ------------------------------------------------------------------ asserts

process.stdout.write('\nPlay store-listing assets\n');

check('512x512 listing icon is a 32-bit RGBA PNG', () => {
  const { ihdr, path: p } = readPng('icon-512.png');
  assert.equal(ihdr.width, 512, `${p} must be 512x512; got ${describe(ihdr)}`);
  assert.equal(ihdr.height, 512, `${p} must be 512x512; got ${describe(ihdr)}`);
  assert.equal(
    ihdr.colorType,
    6,
    `${path.relative(ROOT, p)} must be RGBA (colour type 6) — Play requires a 32-bit PNG for the app icon. Got ${describe(ihdr)}. Regenerate with node scripts/generate-play-store-assets.mjs.`,
  );
  assert.equal(ihdr.bitDepth, 8, `${p} must be 8 bits per channel; got bitDepth=${ihdr.bitDepth}`);
});

check('1024x500 feature graphic is a 24-bit RGB PNG', () => {
  const { ihdr, path: p } = readPng('feature-graphic-1024x500.png');
  assert.equal(ihdr.width, 1024, `${p} must be 1024x500; got ${describe(ihdr)}`);
  assert.equal(ihdr.height, 500, `${p} must be 1024x500; got ${describe(ihdr)}`);
  assert.equal(
    ihdr.colorType,
    2,
    `${path.relative(ROOT, p)} must be RGB (colour type 2) — Play requires a 24-bit PNG or JPEG for the feature graphic, without alpha. Got ${describe(ihdr)}.`,
  );
  assert.equal(ihdr.bitDepth, 8, `${p} must be 8 bits per channel; got bitDepth=${ihdr.bitDepth}`);
});

process.stdout.write('\nPhone screenshots (present-file check — 24-bit RGB required for every one)\n');

const phoneFiles = fs
  .readdirSync(OUT_DIR)
  .filter((name) => /^phone-.*\.png$/i.test(name))
  .sort();

check('at least one phone screenshot exists — or the store-listing doc explains it does not', () => {
  if (phoneFiles.length === 0) {
    // Play requires two before actual submission. The docs must call this out
    // instead of the test silently passing on an empty directory.
    const storeListing = fs.readFileSync(path.join(ROOT, 'docs/play/store-listing.md'), 'utf8');
    assert.ok(
      /must be captured|recapture|pending/i.test(storeListing),
      'no phone-*.png files under docs/play/store-listing/ and docs/play/store-listing.md does not explain the gap. Either recapture screenshots or document that they are pending.',
    );
    return;
  }
});

for (const name of phoneFiles) {
  check(`${name} is a 24-bit RGB PNG at a Play-accepted phone aspect`, () => {
    const { ihdr, path: p } = readPng(name);
    // Play's documented range for phone screenshots is 320..3840 on each side
    // and a 16:9-to-9:16 aspect. Assert the range and either 9:16 or 16:9.
    assert.ok(
      ihdr.width >= 320 && ihdr.width <= 3840 && ihdr.height >= 320 && ihdr.height <= 3840,
      `${path.relative(ROOT, p)} dimensions out of Play's 320..3840 range: got ${describe(ihdr)}`,
    );
    const ratio = ihdr.width / ihdr.height;
    assert.ok(
      (ratio >= 9 / 16 - 0.02 && ratio <= 9 / 16 + 0.02) ||
        (ratio >= 16 / 9 - 0.02 && ratio <= 16 / 9 + 0.02),
      `${path.relative(ROOT, p)} aspect ratio ${ratio.toFixed(3)} is neither 9:16 nor 16:9 — Play rejects phone screenshots outside that range. Got ${describe(ihdr)}. Reshoot at 1080x1920 or crop to that ratio.`,
    );
    assert.equal(
      ihdr.colorType,
      2,
      `${path.relative(ROOT, p)} must be RGB (colour type 2) — Play requires 24-bit PNGs with no alpha for phone screenshots. Got ${describe(ihdr)}. Re-encode with node scripts/generate-play-store-assets.mjs --recode-screenshots.`,
    );
    assert.equal(ihdr.bitDepth, 8, `${p} must be 8 bits per channel; got bitDepth=${ihdr.bitDepth}`);
  });
}

// ---------------------------------------------- guard against generator drift

process.stdout.write('\nGenerator drift guard\n');

check('the generator source still writes each surface with the required colour type', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts/generate-play-store-assets.mjs'),
    'utf8',
  );
  assert.ok(
    /generateIcon\b/.test(source) && /colorType:\s*6/.test(source),
    'the icon generator no longer references colorType 6 — regenerating would silently write the wrong format again.',
  );
  assert.ok(
    /stripAlphaToRgb|colorType:\s*2/.test(source),
    'the feature-graphic generator no longer strips the alpha channel — the browser screenshot may drift to RGBA on a chromium upgrade.',
  );
  assert.ok(
    /--recode-screenshots/.test(source),
    'the generator no longer exposes --recode-screenshots — captured phone screenshots would have to be re-encoded by hand.',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
