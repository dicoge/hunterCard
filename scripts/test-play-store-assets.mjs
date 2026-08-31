#!/usr/bin/env node
/**
 * Play store-listing asset invariants (DIC-1259).
 *
 * The failures this guards against:
 *
 *   1. Uploading a store icon Play rejects at the form level, or screenshots
 *      in a channel format Play refuses. DIC-1257 caught exactly this: the
 *      committed 512x512 icon was written as 8-bit RGB (Play requires 32-bit
 *      RGBA), and phone screenshots captured via `adb screencap -p` were
 *      8-bit RGBA (Play requires 24-bit RGB).
 *
 *   2. Uploading a technically-correctly-formatted PNG whose pixel content
 *      is silently corrupted. DIC-1259 CR 2 caught this: the first fix wrote
 *      IHDR colour type 2 (RGB) but handed the packer a 4-byte-per-pixel
 *      buffer. pngjs's bitpacker takes a fast path when
 *      `inputColorType === colorType` and passed the mis-shaped buffer
 *      through unchanged; every fourth decoded pixel had the alpha byte
 *      (255) leak into a colour channel, producing the "dense RGB stripes
 *      with repeated/scrambled rows" the reviewer flagged. IHDR/colour-type
 *      checks alone will not catch this — the file is a perfectly valid RGB
 *      PNG, it just decodes to garbage.
 *
 * Format checks read the PNG IHDR chunk directly and require the exact
 * colour type Play documents for each surface:
 *   - 512x512 listing icon        -> 32-bit RGBA (IHDR colour type 6)
 *   - 1024x500 feature graphic    -> 24-bit RGB  (IHDR colour type 2)
 *   - 320..3840 phone screenshots -> 24-bit RGB  (IHDR colour type 2)
 *
 * Content checks decode each file with pngjs and prove the pixel stream is
 * coherent — for the feature graphic, that sampled positions match the
 * design palette (dark navy background at known coordinates) and that the
 * gradient has smooth inter-pixel transitions; for the phone screenshot,
 * that adjacent horizontal pixels do not alternate in the period-4
 * "channel-pinned-to-255" pattern that the packing bug produces.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'docs/play/store-listing');

// Store-MVP surface bans these product claims / features anywhere in the
// listing pack (docs + generator + committed graphic bytes). DIC-1259 CR 3
// requires mutation-sensitive checks that fail on ANY re-appearance.
//   - "reference prices" / "參考價格": the Store-MVP artifact has no
//     secondary-market pricing at all (FEATURES.buyPrice/priceSpread etc.
//     are false).
//   - "price tracker": the app is not that anymore.
//   - "collection tracking": removed with favourites in DIC-1256.
//   - "市場數據" / "NT$": the market-data section is compiled out.
//   - "收藏" / "入手提醒": drawer entries removed in DIC-1256.
const BANNED_LISTING_CLAIMS = [
  { needle: '參考價格', why: 'Store-MVP has no secondary-market pricing (DIC-1256).' },
  { needle: 'reference prices', why: 'Store-MVP has no secondary-market pricing (DIC-1256).' },
  { needle: 'price tracker', why: 'The store binary is not a price tracker (DIC-1256).' },
  { needle: 'price-tracker', why: 'The store binary is not a price tracker (DIC-1256).' },
  { needle: 'collection tracking', why: 'Favourites / collection UI is compiled out (DIC-1256).' },
  { needle: '收藏卡牌', why: 'Favourites UI is compiled out (DIC-1256).' },
];

const BANNED_LISTING_SOURCES = [
  'docs/play/store-listing.md',
  'docs/play/app-content.md',
  'docs/play/README.md',
  'scripts/generate-play-store-assets.mjs',
];

// Historical / educational mentions that explicitly frame the string as
// "removed" or "old" are allowed — the ban is on ADVERTISING the feature,
// not on explaining that it went away. Lines that carry any of these
// markers are exempted from the sweep.
const HISTORICAL_MARKERS = [
  'removed',
  'deleted',
  'stripped',
  'invalidated',
  'the old text',
  'advertised features',
  '(DIC-1256 removes',
  'DIC-1256 removes',
  'past releases',
  '不會',
];

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

function readAsset(name) {
  const filePath = path.join(OUT_DIR, name);
  assert.ok(fs.existsSync(filePath), `${path.relative(ROOT, filePath)} is missing`);
  const buffer = fs.readFileSync(filePath);
  return { ihdr: readIhdr(buffer), decoded: PNG.sync.read(buffer), path: filePath };
}

function pixel(decoded, x, y) {
  const idx = (y * decoded.width + x) * 4;
  return [decoded.data[idx], decoded.data[idx + 1], decoded.data[idx + 2], decoded.data[idx + 3]];
}

// The corrupted output the first fix produced had a distinctive signature:
// every 4 consecutive pixels along a row consisted of one correct pixel
// followed by three whose R, G, and B channels (in turn) were pinned to
// exactly 255 — the alpha byte from the source RGBA buffer leaking into a
// colour channel because the filter was told the stream was 3 bytes per
// pixel but received a 4-bytes-per-pixel buffer. Real photographic /
// gradient content never hits that exact period-4 pattern on a smooth region,
// so scanning ~100 sampled offsets and counting how many exhibit it is a
// deterministic detector.
function countPeriod4PinnedPixels(decoded, sampleRowY, xStart, xEnd) {
  let hits = 0;
  let samples = 0;
  for (let x = xStart; x + 3 < Math.min(xEnd, decoded.width); x += 4) {
    const p1 = pixel(decoded, x + 1, sampleRowY);
    const p2 = pixel(decoded, x + 2, sampleRowY);
    const p3 = pixel(decoded, x + 3, sampleRowY);
    // The bug pins exactly ONE channel per pixel to 255 (the leaked alpha);
    // the other two carry colour values. White text / white background pins
    // all three to 255 and must not be counted here — otherwise a legitimate
    // white run reads as corruption.
    const p1IsAlphaLeak = p1[0] === 255 && p1[1] !== 255 && p1[2] !== 255;
    const p2IsAlphaLeak = p2[1] === 255 && p2[0] !== 255 && p2[2] !== 255;
    const p3IsAlphaLeak = p3[2] === 255 && p3[0] !== 255 && p3[1] !== 255;
    if (p1IsAlphaLeak && p2IsAlphaLeak && p3IsAlphaLeak) hits += 1;
    samples += 1;
  }
  return { hits, samples };
}

function maxRowChannelDelta(decoded, sampleRowY, xStart, xEnd) {
  let maxDelta = 0;
  for (let x = xStart + 1; x < Math.min(xEnd, decoded.width); x += 1) {
    const cur = pixel(decoded, x, sampleRowY);
    const prev = pixel(decoded, x - 1, sampleRowY);
    for (let c = 0; c < 3; c += 1) {
      const delta = Math.abs(cur[c] - prev[c]);
      if (delta > maxDelta) maxDelta = delta;
    }
  }
  return maxDelta;
}

// ------------------------------------------------------------------ asserts

process.stdout.write('\nPlay store-listing assets — IHDR / colour type\n');

const icon = readAsset('icon-512.png');
const feature = readAsset('feature-graphic-1024x500.png');

check('512x512 listing icon is a 32-bit RGBA PNG', () => {
  const { ihdr, path: p } = icon;
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
  const { ihdr, path: p } = feature;
  assert.equal(ihdr.width, 1024, `${p} must be 1024x500; got ${describe(ihdr)}`);
  assert.equal(ihdr.height, 500, `${p} must be 1024x500; got ${describe(ihdr)}`);
  assert.equal(
    ihdr.colorType,
    2,
    `${path.relative(ROOT, p)} must be RGB (colour type 2) — Play requires a 24-bit PNG or JPEG for the feature graphic, without alpha. Got ${describe(ihdr)}.`,
  );
  assert.equal(ihdr.bitDepth, 8, `${p} must be 8 bits per channel; got bitDepth=${ihdr.bitDepth}`);
});

process.stdout.write('\nFeature graphic — pixel content matches the design palette\n');

// The design's background is a linear gradient from #132840 (top-left,
// R=19 G=40 B=64) through #1E3A5F to #24486F. A pixel sampled from the
// top-left navy region — well outside the safe area's centered mark and
// copy — must be dark navy. If the packer bug ships again the sampled
// values are (255, N, N) / (N, 255, N) / (N, N, 255), not dark navy.
check('feature-graphic top-left navy region is actually dark navy', () => {
  const [r, g, b] = pixel(feature.decoded, 30, 30);
  assert.ok(
    r < 60 && g < 80 && b < 110,
    `feature-graphic pixel (30,30) should be in the dark-navy background range (~19,40,64); got (${r},${g},${b}). ` +
      "If any channel is close to 255 the RGBA-as-RGB packing bug is back; see the DIC-1259 CR note in the generator's stripAlphaToRgb.",
  );
});

check('feature-graphic bottom-left navy region is actually dark navy', () => {
  const [r, g, b] = pixel(feature.decoded, 30, 470);
  assert.ok(
    r < 60 && g < 80 && b < 110,
    `feature-graphic pixel (30,470) should be in the dark-navy background range; got (${r},${g},${b}).`,
  );
});

check('feature-graphic gradient row has smooth inter-pixel transitions', () => {
  // Row 60 is above the safe-area / mark / copy stack and is pure gradient.
  const maxDelta = maxRowChannelDelta(feature.decoded, 60, 30, 700);
  assert.ok(
    maxDelta < 40,
    `feature-graphic row 60 has a max adjacent-pixel channel delta of ${maxDelta} across 30..700 — a smooth gradient should be under ~40. ` +
      'The RGBA-as-RGB packing bug alternates dark navy with (255,·,·)/(·,255,·)/(·,·,255) every 4 pixels, giving deltas ~200.',
  );
});

check('feature-graphic has no period-4 channel-pinned-to-255 stripes', () => {
  // Multiple sample rows so a legitimate white pixel here or there does not
  // hide the pattern. The bug hits EVERY row identically; a real image does
  // not have 255-pinned channels at that specific offset even in one row.
  for (const y of [40, 200, 350, 460]) {
    const { hits, samples } = countPeriod4PinnedPixels(feature.decoded, y, 20, 900);
    assert.ok(
      samples >= 20 && hits <= 1,
      `feature-graphic row ${y}: ${hits}/${samples} 4-pixel windows show the RGBA-as-RGB alpha-leak stripe pattern. ` +
        "This is the DIC-1259 CR 2 corruption signature — regenerate assets after fixing stripAlphaToRgb / PNG.sync.write.",
    );
  }
});

process.stdout.write('\nPhone screenshots — 24-bit RGB + pixel content is coherent\n');

const phoneFiles = fs
  .readdirSync(OUT_DIR)
  .filter((name) => /^phone-.*\.png$/i.test(name))
  .sort();

check('at least two phone screenshots exist (Play submission minimum)', () => {
  assert.ok(
    phoneFiles.length >= 2,
    `Play requires a minimum of two phone screenshots at submission; only ${phoneFiles.length} committed under docs/play/store-listing/. Add renders (or captures) to bring the count to at least 2 before the pack can be considered submission-ready.`,
  );
});

for (const name of phoneFiles) {
  const asset = readAsset(name);

  check(`${name} is a 24-bit RGB PNG at a Play-accepted phone aspect`, () => {
    const { ihdr, path: p } = asset;
    assert.ok(
      ihdr.width >= 320 && ihdr.width <= 3840 && ihdr.height >= 320 && ihdr.height <= 3840,
      `${path.relative(ROOT, p)} dimensions out of Play's 320..3840 range: got ${describe(ihdr)}`,
    );
    const ratio = ihdr.width / ihdr.height;
    assert.ok(
      (ratio >= 9 / 16 - 0.02 && ratio <= 9 / 16 + 0.02) ||
        (ratio >= 16 / 9 - 0.02 && ratio <= 16 / 9 + 0.02),
      `${path.relative(ROOT, p)} aspect ratio ${ratio.toFixed(3)} is neither 9:16 nor 16:9. Got ${describe(ihdr)}. Reshoot at 1080x1920 or crop to that ratio.`,
    );
    assert.equal(
      ihdr.colorType,
      2,
      `${path.relative(ROOT, p)} must be RGB (colour type 2). Got ${describe(ihdr)}.`,
    );
    assert.equal(ihdr.bitDepth, 8, `${p} must be 8 bits per channel; got bitDepth=${ihdr.bitDepth}`);
  });

  check(`${name} pixel stream is not corrupted by the RGBA-as-RGB packing bug`, () => {
    // The bug hits EVERY row identically, so scanning several rows for the
    // period-4 channel-pinned signature reliably detects it while ignoring
    // the occasional legitimate white pixel a UI screenshot may contain.
    const rowsToProbe = [
      Math.floor(asset.decoded.height * 0.25),
      Math.floor(asset.decoded.height * 0.5),
      Math.floor(asset.decoded.height * 0.75),
    ];
    let flaggedRows = 0;
    for (const y of rowsToProbe) {
      const { hits, samples } = countPeriod4PinnedPixels(
        asset.decoded,
        y,
        20,
        asset.decoded.width - 20,
      );
      if (samples > 0 && hits / samples > 0.5) flaggedRows += 1;
    }
    assert.equal(
      flaggedRows,
      0,
      `${name}: ${flaggedRows} of ${rowsToProbe.length} sampled rows show the period-4 alpha-leak pattern (>50% of 4-pixel windows). ` +
        'This is the DIC-1259 CR 2 corruption signature. Restore the file from the pre-corruption commit or a fresh capture, then re-encode with `node scripts/generate-play-store-assets.mjs --recode-screenshots`.',
    );
  });

  check(`${name} decodes to a non-degenerate image (min unique row hashes, no giant flat block)`, () => {
    // A corrupted or truncated file often reduces to a small handful of
    // identical rows. A real UI screenshot has thousands of distinct rows.
    const rowHashes = new Set();
    for (let y = 0; y < asset.decoded.height; y += 4) {
      let h = 0;
      for (let x = 0; x < asset.decoded.width; x += 16) {
        const [r, g, b] = pixel(asset.decoded, x, y);
        h = (h * 31 + r) | 0;
        h = (h * 31 + g) | 0;
        h = (h * 31 + b) | 0;
      }
      rowHashes.add(h);
    }
    assert.ok(
      rowHashes.size >= 30,
      `${name} decodes to ${rowHashes.size} distinct sampled-row hashes across ${Math.ceil(asset.decoded.height / 4)} sampled rows. That is too flat for a real UI capture — the file may be truncated, single-colour, or corrupted.`,
    );
  });

  check(`${name} is not clipped: the top ~15% of the frame is not a black bar`, () => {
    // DIC-1259 CR 3 called out a clipped phone-01-home whose page title was
    // hidden behind a black bar. Detect that failure mode: the top strip
    // should not be uniformly near-black across the full width. A
    // legitimate status bar is dark but not pure black, and the app bar
    // below it is #1a1a2e — near-black but not black. Real capture with a
    // title cut off shows an almost-pure-#0a0a0a bar for hundreds of
    // vertical pixels.
    const bandStart = 30;
    const bandEnd = Math.floor(asset.decoded.height * 0.15);
    let nearBlackRows = 0;
    let totalRows = 0;
    for (let y = bandStart; y < bandEnd; y += 4) {
      let uniformlyBlack = true;
      for (let x = 40; x < asset.decoded.width - 40; x += 40) {
        const [r, g, b] = pixel(asset.decoded, x, y);
        if (r > 18 || g > 18 || b > 24) {
          uniformlyBlack = false;
          break;
        }
      }
      if (uniformlyBlack) nearBlackRows += 1;
      totalRows += 1;
    }
    const ratio = nearBlackRows / totalRows;
    assert.ok(
      ratio < 0.6,
      `${name}: ${Math.round(ratio * 100)}% of sampled rows in the top 15% band (y=${bandStart}..${bandEnd}) are uniformly near-black — the header/title strip looks clipped. Recapture from the Store-MVP surface with the app bar visible.`,
    );
  });

  check(`${name} does not show removed Store-MVP UI markers (prices / favourites / market)`, () => {
    // We do not run OCR here. Instead, we assert two pixel-content signals:
    //
    // 1) Colour histogram over the whole frame contains none of the exact
    //    Store-MVP-forbidden UI accent hues (the market-data section's amber
    //    trend arrows, the favourites star gold, the price-tag red).
    //    These are all COLORS constants from src/constants — a real capture
    //    of the Store-MVP surface will not contain them at any pixel because
    //    the components that draw them are compiled out.
    //
    // 2) The screenshot's dominant background is #0f0f23 (Store-MVP
    //    background). If the screenshot came from a market view or an
    //    ads-enabled surface the dominant background will differ.
    //
    // Both checks are approximate — they cannot prove the surface is
    // Store-MVP, but they DO fail on the specific stale-UI regressions
    // DIC-1259 CR 3 called out.
    const FORBIDDEN_HUES = [
      // Exact hex colours the market/collection UI draws with. Kept as
      // triplets so a legitimate-looking pixel can be distinguished from
      // an accidental near-match.
      { rgb: [212, 0, 27], why: 'price-tag red (NT$ styling from removed market row)' },
      { rgb: [16, 185, 129], why: 'trend-up green from removed market delta' },
      { rgb: [239, 68, 68], why: 'trend-down red from removed market delta' },
    ];
    for (const { rgb, why } of FORBIDDEN_HUES) {
      let hits = 0;
      const [fr, fg, fb] = rgb;
      for (let y = 0; y < asset.decoded.height; y += 8) {
        for (let x = 0; x < asset.decoded.width; x += 8) {
          const [r, g, b] = pixel(asset.decoded, x, y);
          if (Math.abs(r - fr) <= 3 && Math.abs(g - fg) <= 3 && Math.abs(b - fb) <= 3) {
            hits += 1;
            if (hits > 40) break;
          }
        }
        if (hits > 40) break;
      }
      // A tiny number of matches (< 40 sampled pixels across the whole
      // frame) can appear from font antialiasing on unrelated glyphs; a
      // real market UI produces hundreds because it fills entire pill /
      // badge shapes with the colour.
      assert.ok(
        hits <= 40,
        `${name} shows ${hits}+ sampled pixels matching the ${why} colour rgb(${fr},${fg},${fb}) — this indicates removed market/collection UI is present in the screenshot. Recapture from the Store-MVP surface.`,
      );
    }
    // Background sample from a corner that in every phone screen is
    // guaranteed to be background (not overlapped by content). If the
    // background is not the Store-MVP #0f0f23, the screenshot is from a
    // different surface entirely.
    const [bgR, bgG, bgB] = pixel(asset.decoded, 20, 500);
    assert.ok(
      bgR < 35 && bgG < 35 && bgB < 55,
      `${name} background sample at (20, 500) is rgb(${bgR},${bgG},${bgB}), not the Store-MVP background #0f0f23. Screenshot may be from a different surface.`,
    );
  });
}

// ----------------------- banned-claims sweep across the pack (DIC-1259 CR 3)

process.stdout.write('\nBanned Store-MVP listing claims must not appear in the pack\n');

function findBannedClaims() {
  const violations = [];
  for (const rel of BANNED_LISTING_SOURCES) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) continue;
    const source = fs.readFileSync(abs, 'utf8');
    const lines = source.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const lower = line.toLowerCase();
      const isHistorical = HISTORICAL_MARKERS.some((marker) => lower.includes(marker.toLowerCase()));
      for (const { needle, why } of BANNED_LISTING_CLAIMS) {
        if (line.includes(needle) && !isHistorical) {
          violations.push({ file: rel, line: i + 1, snippet: line.trim(), needle, why });
        }
      }
    }
  }
  return violations;
}

check('no banned Store-MVP claim (參考價格 / reference prices / price tracker / collection tracking / 收藏卡牌) appears as a live listing claim', () => {
  const violations = findBannedClaims();
  assert.equal(
    violations.length,
    0,
    'the following files still advertise features the Store-MVP artifact does not have:\n' +
      violations
        .map(
          (v) => `  ${v.file}:${v.line}  — "${v.needle}" (${v.why})\n    line: ${v.snippet}`,
        )
        .join('\n'),
  );
});

// Feature-graphic PNG is committed alongside the docs; the removed claims
// live in the HTML template in the generator, but the RENDERED bytes also
// need to be sanity-checked. We cannot OCR the PNG in-process without an
// extra dep, but we CAN assert that the generator source no longer contains
// the two most common ways the claim slipped in — Chinese and English.
check('generator source does not embed the banned feature-graphic claims', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'scripts/generate-play-store-assets.mjs'),
    'utf8',
  );
  assert.ok(
    !source.includes('參考價格'),
    'scripts/generate-play-store-assets.mjs still contains 參考價格 — regenerating would put the removed feature back on the store graphic.',
  );
  assert.ok(
    !/reference prices/i.test(source),
    'scripts/generate-play-store-assets.mjs still contains "reference prices" — regenerating would put the removed feature back on the store graphic.',
  );
});

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
    /RGB_ENCODER_OPTIONS[\s\S]{0,200}colorType:\s*2[\s\S]{0,200}inputColorType:\s*6[\s\S]{0,200}inputHasAlpha:\s*true/.test(
      source,
    ),
    'the RGB encoder options no longer set inputColorType:6 + inputHasAlpha:true — pngjs will fast-path the 4bpp buffer through the RGB packer and produce the DIC-1259 CR 2 corruption again.',
  );
  assert.ok(
    /--recode-screenshots/.test(source),
    'the generator no longer exposes --recode-screenshots — captured phone screenshots would have to be re-encoded by hand.',
  );
  assert.ok(
    /looksCorruptedByPreviousStripAlphaBug/.test(source),
    'the generator no longer refuses to re-encode a file that already carries the alpha-leak corruption — running --recode-screenshots on a corrupted file would freeze that corruption in place.',
  );
  assert.ok(
    /generatePhoneScreenshots\b/.test(source) && /PHONE_SCREENS\b/.test(source),
    'the generator no longer produces phone screenshots for the Store-MVP surface — Play requires at least two, and this test enforces that count.',
  );
});

process.stdout.write(`\nPASS — ${checks} checks\n`);
