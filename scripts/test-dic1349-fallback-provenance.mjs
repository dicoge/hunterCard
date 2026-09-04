#!/usr/bin/env node
/**
 * test-dic1349-fallback-provenance.mjs — DIC-1349 regression.
 *
 * Guards the HTTP fetch fallback in `scripts/build-database.js` against the
 * production failure surfaced by the DIC-1348 post-merge validation: a fresh
 * root install has no `puppeteer-extra`, so the yuyu scrape drops to the
 * fetch fallback. Before this fix the fallback stripped every HTML tag
 * BEFORE parsing and then tried to look up `<img>` URLs from raw HTML using
 * text-position offsets that do not correspond to HTML positions — so
 * `yuyuImage` was almost always absent or wrong. Every fallback listing then
 * failed `pricesEntryExactPrintMatchesSource` on the DIC-1334 gate and no
 * priced cardNumber could be admitted to the final artifact (fresh-scrape
 * 1,196 unique priced cardNumbers, binding rate 0 / 1,196).
 *
 * The tests below cover:
 *   1. Successful fallback → exact-printing binding. A synthetic yuyu-tei
 *      HTML page with three real card-product blocks produces three
 *      entries, each with a canonical `card.yuyu-tei.jp/hocg/{size}/
 *      {product}/{filename}.{ext}` `yuyuImage`, and each entry passes
 *      `pricesEntryExactPrintMatchesSource` against its sourceProduct.
 *   2. Same-cardNumber / different-rarity isolation. Two `hBP04-001` blocks
 *      at different rarities (SEC + OSR) become two separate listings on
 *      the same cardNumber. Neither one's yuyuImage bleeds onto the other,
 *      the DIC-1349 fix does not silently pick "the first image in the
 *      whole page" for either row (the DIC-1229 CR failure mode).
 *   3. Missing / mismatched provenance rejection. A card-product block
 *      whose product image URL is off-host (`evil.example.com`), whose
 *      path shape does not match `/hocg/{size}/{product}/…`, whose scheme
 *      is `javascript:`, or whose block has neither an `<img>` tag nor a
 *      `cart_ver` / `cart_cid` pair is DROPPED rather than admitted with
 *      an empty `yuyuImage` — otherwise the row would fail closed on the
 *      exact-print matcher downstream and just recreate the collapse this
 *      fix repairs.
 *   4. End-to-end binding through build-database.js — a real
 *      `HUNTERCARD_YUYU_FIXTURE_PATH` build that feeds the parseCardHtml
 *      output of a synthetic HTML page into scrapeYuyuPrices' shape lands
 *      the fallback listing onto the correct official printing row.
 *
 * Run: node scripts/test-dic1349-fallback-provenance.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseCardHtml } from './build-database.js';
import { pricesEntryExactPrintMatchesSource, yuyuImageProductPath } from './lib/preserve-market-fields.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

/**
 * Build a yuyu-tei-shaped card-product block matching the real page
 * markup (starbtn <img alt="Star" …>, product image with alt "hXXX-nnn
 * RARITY name", span with cardNumber, h4 with name, price in "円",
 * hidden cart_ver / cart_cid inputs). The overrides drop / mangle
 * individual fields so the fail-closed cases can drive a single mutation
 * against a known-good baseline.
 */
function makeCardBlock(overrides = {}) {
  const cardNum = overrides.cardNum ?? 'hBP04-001';
  const rarity = overrides.rarity ?? 'SEC';
  const name = overrides.name ?? '博衣こより(パラレル/サイン)';
  const price = overrides.price ?? '99,800';
  const imgSrc = overrides.imgSrc ?? 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg';
  const cartVer = overrides.cartVer ?? 'hbp04';
  const cartCid = overrides.cartCid ?? '10003';
  const includeImg = overrides.includeImg ?? true;
  const includeCartInputs = overrides.includeCartInputs ?? true;
  const alt = `${cardNum} ${rarity} ${name}`;

  const productImg = includeImg
    ? `<img src="${imgSrc}" alt="${alt}" class="card img-fluid">`
    : '';
  // Real yuyu-tei markup wraps every cart_ver / cart_cid input inside a
  // `<div class="d-flex counter text-center">` container. The parser's
  // source-boundary invariant (CR round-4 fix) scopes cart-input lookups
  // to that container, so fixture blocks must ship the same wrapper —
  // otherwise the "well-formed baseline" cases here would also fail
  // the invariant and mask real regressions.
  const cartInputs = includeCartInputs
    ? `<div class="d-flex counter text-center">
<input type="hidden" value="${cartVer}" class="cart_ver">
<input type="hidden" value="${cartCid}" class="cart_cid">
</div>`
    : '';

  return `
<div class="card-product position-relative mt-4  "><div class="starbtn" onclick="location.href='https://yuyu-tei.jp/member/login'">
<em class="d-block position-absolute z-index top-0 start-0"></em>
<img src="https://cdn.yuyu-tei.jp/images/common/btn-icon/star.svg" alt="Star" class="star star1 position-absolute z-index"></div>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><div class="position-relative product-img">
${productImg}</div>
</a>
<span class="d-block border border-dark p-1 w-100 text-center my-2">${cardNum}</span>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><h4 class="text-primary fw-bold">${name}</h4>
</a>
<strong class="d-block text-end ">
${price} 円
</strong>
${cartInputs}
</div>`;
}

function wrapPage(blocks) {
  return `<!DOCTYPE html><html><body><div class="row row-cols-md-4">${blocks.join('\n')}</div></body></html>`;
}

// ── Case 1: successful fallback → exact-printing binding ──
{
  const html = wrapPage([
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003' }),
    makeCardBlock({ cardNum: 'hBP04-004', rarity: 'OUR', name: '雪花ラミィ(パラレル)', price: '14,800', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10009.jpg', cartVer: 'hbp04', cartCid: '10009' }),
    makeCardBlock({ cardNum: 'hSD10-001', rarity: 'C', name: 'ときのそら', price: '30', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/promo-hsd10/12345.jpg', cartVer: 'promo-hsd10', cartCid: '12345' }),
  ]);

  const cards = parseCardHtml(html);
  assert.equal(cards.length, 3, `case 1: expected 3 parsed listings, got ${cards.length}`);
  assert.deepEqual(
    cards.map((c) => c.cardNum),
    ['hBP04-001', 'hBP04-004', 'hSD10-001'],
    'case 1: card numbers must be preserved in page order',
  );
  assert.deepEqual(
    cards.map((c) => c.rarity),
    ['SEC', 'OUR', 'C'],
    'case 1: rarity codes must be extracted from the product image alt attribute',
  );
  assert.deepEqual(
    cards.map((c) => c.imageVersion),
    ['hbp04', 'hbp04', 'promo-hsd10'],
    'case 1: imageVersion must be populated from the cart_ver hidden input',
  );
  assert.deepEqual(
    cards.map((c) => c.imageCid),
    ['10003', '10009', '12345'],
    'case 1: imageCid must be populated from the cart_cid hidden input',
  );
  for (const c of cards) {
    assert.ok(
      /^https:\/\/card\.yuyu-tei\.jp\/hocg\/100_140\/[a-z0-9-]+\/[a-z0-9-]+\.jpg$/i.test(c.yuyuImage),
      `case 1: yuyuImage must be a canonical yuyu-tei product URL, got ${JSON.stringify(c.yuyuImage)}`,
    );
  }
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[0].sellPrice, imageUrl: cards[0].yuyuImage }, 'hBP04'),
    'case 1: hBP04-001 SEC must pass pricesEntryExactPrintMatchesSource for sourceProduct hBP04',
  );
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[1].sellPrice, imageUrl: cards[1].yuyuImage }, 'hBP04'),
    'case 1: hBP04-004 OUR must pass pricesEntryExactPrintMatchesSource for sourceProduct hBP04',
  );
  assert.ok(
    pricesEntryExactPrintMatchesSource({ sellPrice: cards[2].sellPrice, imageUrl: cards[2].yuyuImage }, 'hPR'),
    'case 1: hSD10-001 promo-hsd10 must pass pricesEntryExactPrintMatchesSource for sourceProduct hPR (known promo carve-out)',
  );
}

// ── Case 2: same-cardNumber / different-rarity isolation ──
{
  const html = wrapPage([
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' }),
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'OSR', name: '博衣こより', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10001.jpg', cartVer: 'hbp04', cartCid: '10001', price: '580' }),
    // A third block that would have collided in the old text-position
    // fallback: same product but different card, its image URL sits close to
    // the second hBP04-001 block in the raw HTML. The block-scoped parser
    // must keep the URLs on their own rows.
    makeCardBlock({ cardNum: 'hBP04-002', rarity: 'C', name: '別カード', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', cartVer: 'hbp04', cartCid: '20001', price: '30' }),
  ]);

  const cards = parseCardHtml(html);
  const bp001 = cards.filter((c) => c.cardNum === 'hBP04-001');
  const bp002 = cards.filter((c) => c.cardNum === 'hBP04-002');
  assert.equal(bp001.length, 2, 'case 2: both hBP04-001 rarities must survive as separate listings');
  assert.equal(bp002.length, 1, 'case 2: the sibling hBP04-002 listing must not be swallowed');

  const sec = bp001.find((c) => c.rarity === 'SEC');
  const osr = bp001.find((c) => c.rarity === 'OSR');
  assert.ok(sec, 'case 2: SEC listing must be present');
  assert.ok(osr, 'case 2: OSR listing must be present');
  assert.equal(sec.sellPrice, 99800, 'case 2: SEC keeps its own price');
  assert.equal(osr.sellPrice, 580, 'case 2: OSR keeps its own price');
  assert.equal(sec.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 2: SEC yuyuImage must be its own /10003.jpg');
  assert.equal(osr.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10001.jpg', 'case 2: OSR yuyuImage must be its own /10001.jpg');
  assert.notEqual(sec.yuyuImage, osr.yuyuImage, 'case 2: same-cardNumber rarities must not share yuyuImage — that would fail canonicalYuyuImageIdentity ambiguity detection later');
  assert.equal(bp002[0].yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', 'case 2: sibling hBP04-002 must carry its own image');
}

/**
 * DIC-1349 CR round-2 additional helpers.
 *
 * `makeCardBlockRaw` builds a block from a caller-supplied product-image
 * tag string, cart_ver / cart_cid tag strings, and quote style for the
 * container class. Used exclusively by the CR round-2 cases below to
 * drive attribute-quoting, present-but-invalid-image, and foreign-field
 * leakage repros that the vanilla `makeCardBlock` helper cannot express.
 */
function makeCardBlockRaw({
  cardNum = 'hBP04-001',
  rarity = 'SEC',
  name = '博衣こより(パラレル/サイン)',
  price = '99,800',
  cartVer = 'hbp04',
  cartCid = '10003',
  productImgTag,           // full '<img …>' string (or '' to omit)
  cartVerTag,              // full '<input …>' string (or '' to omit)
  cartCidTag,              // full '<input …>' string (or '' to omit)
  containerQuote = '"',
  counterQuote = '"',      // container-quote for the .counter wrapper
  omitCounterWrapper = false, // set true for red-before-green cases that need
                             // the CR round-4 "cart inputs outside .counter"
                             // shape (footer-only mutation).
  extraInsideBlock = '',
} = {}) {
  const q = containerQuote;
  const cq = counterQuote;
  const inputs = [cartVerTag ?? '', cartCidTag ?? ''].filter(Boolean).join('\n');
  const cartSection = inputs
    ? (omitCounterWrapper
        ? inputs
        : `<div class=${cq}d-flex counter text-center${cq}>\n${inputs}\n</div>`)
    : '';
  return `
<div class=${q}card-product position-relative mt-4  ${q}><div class="starbtn" onclick="location.href='https://yuyu-tei.jp/member/login'">
<em class="d-block position-absolute z-index top-0 start-0"></em>
<img src="https://cdn.yuyu-tei.jp/images/common/btn-icon/star.svg" alt="Star" class="star star1 position-absolute z-index"></div>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><div class="position-relative product-img">
${productImgTag}</div>
</a>
<span class="d-block border border-dark p-1 w-100 text-center my-2">${cardNum}</span>
<a href="https://yuyu-tei.jp/sell/hocg/card/${cartVer}/${cartCid}"><h4 class="text-primary fw-bold">${name}</h4>
</a>
<strong class="d-block text-end ">
${price} 円
</strong>
${cartSection}
${extraInsideBlock}
</div>`;
}

// ── Case 3: fail-closed on missing / mismatched / off-host provenance ──
{
  const html = wrapPage([
    // (a) Baseline good block — must still parse alongside the bad ones so
    // the drops below are proven independent from a global parse failure.
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' }),
    // (b) Off-host image, no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-100', rarity: 'C', imgSrc: 'https://evil.example.com/hocg/100_140/hbp04/10003.jpg', includeCartInputs: false, price: '100' }),
    // (c) Wrong path shape (no /hocg/), no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-101', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp/wrong-path/hbp04/1.jpg', includeCartInputs: false, price: '200' }),
    // (d) No product img at all AND no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-102', rarity: 'C', includeImg: false, includeCartInputs: false, price: '300' }),
    // (e) No product img, but cart_ver + cart_cid present — must be
    //     ADMITTED via the canonical /hocg/100_140/{ver}/{cid}.jpg
    //     fallback URL (yuyu-tei's real shape when the img tag is absent
    //     in a rendered variant).
    makeCardBlock({ cardNum: 'hBP04-103', rarity: 'C', includeImg: false, cartVer: 'hbp04', cartCid: '30001', price: '400' }),
    // (f) Non-http scheme (javascript:) with no cart_ver/cid — must be dropped.
    makeCardBlock({ cardNum: 'hBP04-104', rarity: 'C', imgSrc: 'javascript:alert(1)', includeCartInputs: false, price: '500' }),
  ]);

  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));
  assert.ok(seen.has('hBP04-001'), 'case 3: the good baseline block must still parse');
  assert.ok(seen.has('hBP04-103'), 'case 3: the cart_ver+cart_cid-only block must be admitted via synthesised URL');
  for (const dropped of ['hBP04-100', 'hBP04-101', 'hBP04-102', 'hBP04-104']) {
    assert.ok(!seen.has(dropped), `case 3: block with unprovable provenance (${dropped}) must be DROPPED, not admitted with empty yuyuImage`);
  }
  // Every admitted row must carry a URL the exact-print matcher can bind.
  for (const c of cards) {
    assert.equal(yuyuImageProductPath(c.yuyuImage), 'hbp04', `case 3: every admitted row's yuyuImage must parse via yuyuImageProductPath (row ${c.cardNum})`);
  }
  // And the cart_ver+cart_cid fallback must produce the canonical URL.
  const bp103 = cards.find((c) => c.cardNum === 'hBP04-103');
  assert.equal(
    bp103.yuyuImage,
    'https://card.yuyu-tei.jp/hocg/100_140/hbp04/30001.jpg',
    'case 3: cart_ver+cart_cid fallback must synthesise the canonical yuyu-tei URL shape',
  );
}

// ── Case 3b (CR round 2, blocker #1): a PRESENT-but-invalid product image
//     with cart_ver + cart_cid still present must NOT be laundered into a
//     synthesised trusted URL. The pre-round-2 rewrite ignored an off-host
//     / wrong-path / bogus-scheme <img> and then fell through to the cart-
//     inputs synth, which turned `<img src="https://evil.example/…">
//     <input class="cart_ver" value="hbp04"> <input class="cart_cid"
//     value="99999">` into
//     `https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg` — the exact
//     "empty-rarity unique-source-product" fallback at
//     `scripts/build-database.js:~1420-1429` would then bind that URL onto
//     the official row. Every negative case here keeps a normal-shaped
//     cart_ver / cart_cid pair to match the production-realistic bypass
//     the CR flagged. ──
{
  const html = wrapPage([
    // Baseline good block so the drops below cannot be blamed on a global
    // parse failure.
    makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' }),
    // Off-host image, cart inputs still present.
    makeCardBlock({ cardNum: 'hBP04-200', rarity: 'C', imgSrc: 'https://evil.example.com/hocg/100_140/hbp04/99999.jpg', cartVer: 'hbp04', cartCid: '99999', price: '100' }),
    // Wrong-path image (no /hocg/), cart inputs still present.
    makeCardBlock({ cardNum: 'hBP04-201', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp/wrong-path/hbp04/99999.jpg', cartVer: 'hbp04', cartCid: '99999', price: '200' }),
    // Missing extension / not an image URL, cart inputs still present.
    makeCardBlock({ cardNum: 'hBP04-202', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999', cartVer: 'hbp04', cartCid: '99999', price: '300' }),
    // Non-http scheme, cart inputs still present.
    makeCardBlock({ cardNum: 'hBP04-203', rarity: 'C', imgSrc: 'javascript:alert(1)', cartVer: 'hbp04', cartCid: '99999', price: '400' }),
    // Valid host but non-default port (rev.6 rejects), cart inputs still present.
    makeCardBlock({ cardNum: 'hBP04-204', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp:444/hocg/100_140/hbp04/99999.jpg', cartVer: 'hbp04', cartCid: '99999', price: '500' }),
    // Host case-collision (`Card.YUYU-tei.jp`) via a lookalike wrong path — must fail closed.
    makeCardBlock({ cardNum: 'hBP04-205', rarity: 'C', imgSrc: 'https://card.yuyu-tei.jp.evil.example/hocg/100_140/hbp04/99999.jpg', cartVer: 'hbp04', cartCid: '99999', price: '600' }),
  ]);

  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));
  assert.ok(seen.has('hBP04-001'), 'case 3b: the good baseline block must still parse');
  for (const dropped of ['hBP04-200', 'hBP04-201', 'hBP04-202', 'hBP04-203', 'hBP04-204', 'hBP04-205']) {
    assert.ok(
      !seen.has(dropped),
      `case 3b (CR#1 fix): a present-but-invalid product image with cart_ver/cart_cid present must DROP the block (${dropped}); it must NOT be laundered via cart-inputs synth into a trusted /hocg/100_140/hbp04/99999.jpg URL`,
    );
  }
  // And prove the laundering shape the CR flagged is not produced anywhere
  // in the parser output — no admitted row should carry the synthesised
  // /99999.jpg URL that the CR called out by example.
  for (const c of cards) {
    assert.notEqual(
      c.yuyuImage,
      'https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg',
      `case 3b (CR#1 fix): the synthesised /hbp04/99999.jpg URL must not appear on any admitted row (row ${c.cardNum})`,
    );
  }
}

// ── Case 3c (CR round 2, blocker #2): after-closing-tag leakage. A block
//     that has NO product image and NO cart inputs must never absorb
//     valid-looking `cart_ver` / `cart_cid` (or product img) that live
//     OUTSIDE its own `</div>` — either in the sibling that follows, or
//     in trailing page footer content. The pre-round-2 rewrite ended each
//     slice at the NEXT card-product opening (or `html.length`), so the
//     LAST card on the page consumed everything after it. Repro: a final
//     unprovable card followed by footer `<input class="cart_ver"
//     value="hbp04"> <input class="cart_cid" value="99999">` used to emit
//     `/hbp04/99999.jpg`. Now that the parser walks the matching
//     `</div>`, the trailing footer stays outside the block and the row
//     is DROPPED. ──
{
  const goodBlock = makeCardBlock({ cardNum: 'hBP04-001', rarity: 'SEC', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', cartVer: 'hbp04', cartCid: '10003', price: '99,800' });
  // Final card-product block deliberately has no image tag and no cart inputs.
  const truncatedFinalBlock = makeCardBlock({ cardNum: 'hBP04-300', rarity: 'C', includeImg: false, includeCartInputs: false, price: '999' });

  // (1) The `truncatedFinalBlock` is the LAST card-product on the page, and
  // is followed by page footer HTML that contains a valid-looking cart_ver
  // / cart_cid pair, another product <img>, and an <h4>. If the parser
  // extended the slice past the block's `</div>`, it would attach any of
  // those footer fields to `hBP04-300` and emit a synthesised
  // `/hbp04/99999.jpg` URL.
  const footer = `
<footer class="page-footer">
<a href="https://yuyu-tei.jp/sell/hocg/card/hbp04/99999"><div class="position-relative product-img">
<img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg" alt="hBP04-300 C 別カード">
</div></a>
<h4>予告カード</h4>
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="99999" class="cart_cid">
</footer>`;

  const html = `<!DOCTYPE html><html><body><div class="row row-cols-md-4">${goodBlock}\n${truncatedFinalBlock}</div>${footer}</body></html>`;
  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));
  assert.ok(seen.has('hBP04-001'), 'case 3c: the good baseline block must still parse');
  assert.ok(
    !seen.has('hBP04-300'),
    'case 3c (CR#2 fix): the final unprovable block must be DROPPED, not absorb footer cart_ver/cart_cid or a footer <img> and emit /hbp04/99999.jpg',
  );
  for (const c of cards) {
    assert.notEqual(
      c.yuyuImage,
      'https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg',
      `case 3c (CR#2 fix): no admitted row may carry the footer's /hbp04/99999.jpg (row ${c.cardNum})`,
    );
  }

  // (2) Non-final variant: sibling-leakage guard. A truncated middle block
  // whose neighbour has cart_ver / cart_cid must not absorb them either.
  const html2 = wrapPage([
    goodBlock,
    truncatedFinalBlock,
    makeCardBlock({ cardNum: 'hBP04-004', rarity: 'OUR', imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', cartVer: 'hbp04', cartCid: '20001', price: '580' }),
  ]);
  const cards2 = parseCardHtml(html2);
  const seen2 = new Set(cards2.map((c) => c.cardNum));
  assert.ok(seen2.has('hBP04-001'), 'case 3c sibling: baseline still parses');
  assert.ok(seen2.has('hBP04-004'), 'case 3c sibling: the trailing valid block still parses');
  assert.ok(
    !seen2.has('hBP04-300'),
    'case 3c sibling (CR#2 fix): the truncated middle block must be DROPPED, not absorb the next sibling block\'s cart inputs or image',
  );
}

// ── Case 3d (CR round 2, blocker #3): valid HTML attribute variants must
//     not cause silent data loss. yuyu-tei's live markup uses double
//     quotes today but the HTTP fallback is a boundary the pre-round-2
//     rewrite left brittle: single-quoted `class`/`src`/`alt`/`value`,
//     reordered attributes, and entity-encoded values (e.g. `&amp;` in
//     the name) all silently produced ZERO rows. The parser must handle
//     each of these without loss. ──
{
  const cardNum = 'hBP04-001';
  const rarity = 'SEC';
  const name = '博衣こより'; // exercise decodeHtmlEntities via &amp; below

  // (1) Single-quoted container class, single-quoted product img
  //     attributes, single-quoted cart inputs.
  const singleQuotedProductImg = "<img src='https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg' alt='hBP04-001 SEC 博衣こより' class='card img-fluid'>";
  const singleQuotedCartVer = "<input type='hidden' value='hbp04' class='cart_ver'>";
  const singleQuotedCartCid = "<input type='hidden' value='10003' class='cart_cid'>";
  const singleQuotedBlock = makeCardBlockRaw({
    cardNum, rarity, name,
    cartVer: 'hbp04', cartCid: '10003',
    productImgTag: singleQuotedProductImg,
    cartVerTag: singleQuotedCartVer,
    cartCidTag: singleQuotedCartCid,
    containerQuote: "'",
  });

  // (2) Reordered attributes on the product img and cart inputs (class before
  //     src, value after class), still double-quoted.
  const reorderedProductImg = '<img class="card img-fluid" alt="hBP04-004 OUR 雪花ラミィ" src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg">';
  const reorderedCartVer = '<input class="cart_ver" value="hbp04" type="hidden">';
  const reorderedCartCid = '<input class="cart_cid" value="20001" type="hidden">';
  const reorderedBlock = makeCardBlockRaw({
    cardNum: 'hBP04-004', rarity: 'OUR', name: '雪花ラミィ',
    cartVer: 'hbp04', cartCid: '20001',
    productImgTag: reorderedProductImg,
    cartVerTag: reorderedCartVer,
    cartCidTag: reorderedCartCid,
  });

  // (3) Entity-encoded name in the block's <h4> (&amp; and &quot; both
  //     appear in yuyu-tei's real listing pages). Must be decoded, not
  //     dropped, and the row must still be admitted.
  const entityBlock = makeCardBlockRaw({
    cardNum: 'hBP04-005', rarity: 'C', name: 'Test &amp; Card', price: '30',
    cartVer: 'hbp04', cartCid: '30001',
    productImgTag: '<img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/30001.jpg" alt="hBP04-005 C Test &amp; Card" class="card img-fluid">',
    cartVerTag: '<input type="hidden" value="hbp04" class="cart_ver">',
    cartCidTag: '<input type="hidden" value="30001" class="cart_cid">',
  });

  const html = wrapPage([singleQuotedBlock, reorderedBlock, entityBlock]);
  const cards = parseCardHtml(html);
  const byNum = new Map(cards.map((c) => [c.cardNum, c]));
  assert.ok(byNum.get('hBP04-001'), 'case 3d/1 (CR#3 fix): single-quoted container + attributes must parse');
  assert.ok(byNum.get('hBP04-004'), 'case 3d/2 (CR#3 fix): reordered attributes must parse');
  assert.ok(byNum.get('hBP04-005'), 'case 3d/3 (CR#3 fix): entity-encoded name must parse (not dropped)');

  assert.equal(byNum.get('hBP04-001').yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 3d/1: single-quoted src is extracted intact');
  assert.equal(byNum.get('hBP04-001').rarity, 'SEC', 'case 3d/1: single-quoted alt still yields rarity');
  assert.equal(byNum.get('hBP04-001').imageVersion, 'hbp04', 'case 3d/1: single-quoted cart_ver still yields version');
  assert.equal(byNum.get('hBP04-001').imageCid, '10003', 'case 3d/1: single-quoted cart_cid still yields cid');

  assert.equal(byNum.get('hBP04-004').yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', 'case 3d/2: reordered src is extracted intact');
  assert.equal(byNum.get('hBP04-004').rarity, 'OUR', 'case 3d/2: reordered alt still yields rarity');
  assert.equal(byNum.get('hBP04-004').imageVersion, 'hbp04', 'case 3d/2: reordered cart_ver still yields version');
  assert.equal(byNum.get('hBP04-004').imageCid, '20001', 'case 3d/2: reordered cart_cid still yields cid');

  assert.equal(byNum.get('hBP04-005').name, 'Test & Card', 'case 3d/3: &amp; must decode to & in the name');
}

// ── Case 3e (CR round 3, blocker #1): genuinely unclosed card-product.
//     The prior div-depth counter would consume an ancestor `</div>` and
//     then admit the "card" with laundered synthesised provenance from
//     `<input class="cart_ver">` / `<input class="cart_cid">` that
//     structurally live OUTSIDE the card but that HTML5 parsing keeps as
//     children (no implicit-close rule for `<div>`). Real yuyu-tei
//     card-products always contain a `<div class="… product-img …">`
//     container; when it is absent, the extracted "card" is malformed
//     and must be dropped, even though cheerio's DOM read would
//     otherwise find valid-looking cart inputs inside. ──
{
  const goodBlock = makeCardBlock({
    cardNum: 'hBP04-001', rarity: 'SEC',
    imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg',
    cartVer: 'hbp04', cartCid: '10003', price: '99,800',
  });
  // Genuinely missing the card-product's OWN `</div>`, followed by footer
  // cart inputs and only then the row's close. The card-product has NO
  // product-img container — exactly the CR-round-3 mutation the review
  // called out.
  const unclosedFragment = `
<div class="card-product">
<span class="d-block">hBP04-099</span>
<h4>予告カード</h4>
<strong>500 円</strong>
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="99999" class="cart_cid">
`;
  const html = `<!DOCTYPE html><html><body>
<div class="row row-cols-md-4">
${goodBlock}
${unclosedFragment}
</div>
</body></html>`;

  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));
  assert.ok(seen.has('hBP04-001'), 'case 3e: the good baseline card must still parse');
  assert.ok(
    !seen.has('hBP04-099'),
    'case 3e (CR#round3-1 fix): a genuinely unclosed card-product with no product-img container must be DROPPED, not admitted via laundered cart_ver/cart_cid synth',
  );
  for (const c of cards) {
    assert.notEqual(
      c.yuyuImage,
      'https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg',
      `case 3e (CR#round3-1 fix): the CR-flagged laundered /hbp04/99999.jpg URL must not appear on any admitted row (row ${c.cardNum})`,
    );
  }
}

// ── Case 3f (CR round 3, blocker #2): prefixed alias attributes such as
//     `data-class="card-product"`, `data-class="cart_ver"`, and
//     `data-class="cart_cid"` must NEVER be treated as real
//     `class`/`cart_ver`/`cart_cid` structural attributes. The prior
//     regex-based `getTagAttr` used `\b${name}`, and the word boundary
//     in the `-` between `data-` and the attribute name meant these
//     prefixed aliases matched. A real DOM parser (cheerio / parse5)
//     addresses this by construction — attribute names are token-scoped
//     — but the regression pins the invariant so future refactors cannot
//     re-introduce the bypass. ──
{
  // A whole card whose ONLY structural attributes are `data-class`
  // aliases. If any of them were accepted, the parser would emit the
  // laundered `/hbp04/99999.jpg` URL.
  const html = `<!DOCTYPE html><html><body>
<div data-class="card-product">
<a href="https://yuyu-tei.jp/x"><div data-class="product-img">
<img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg" alt="hBP04-050 C fake" data-class="card img-fluid">
</div></a>
<span data-class="d-block">hBP04-050</span>
<h4>fake</h4>
<strong>500 円</strong>
<input type="hidden" value="hbp04" data-class="cart_ver">
<input type="hidden" value="99999" data-class="cart_cid">
</div>
</body></html>`;

  const cards = parseCardHtml(html);
  assert.equal(
    cards.length,
    0,
    'case 3f (CR#round3-2 fix): a card whose only structural attributes are `data-class` aliases must produce ZERO rows',
  );

  // Additionally: a well-formed card MUST NOT admit `data-class="cart_ver"`
  // / `data-class="cart_cid"` on its inputs and use them for URL synth.
  // Baseline good card has product-img+img (valid provenance from the
  // <img>), but its cart inputs are `data-class` aliases only. The card
  // must still emit — the URL from the valid `<img>` wins — and the
  // extracted imageVersion / imageCid must NOT come from the aliased
  // inputs (they must be empty).
  const html2 = `<!DOCTYPE html><html><body>
<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img">
<img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg" alt="hBP04-001 SEC 博衣こより" class="card img-fluid">
</div></a>
<span class="d-block">hBP04-001</span>
<h4>博衣こより</h4>
<strong>99,800 円</strong>
<input type="hidden" value="hbp04" data-class="cart_ver">
<input type="hidden" value="10003" data-class="cart_cid">
</div>
</body></html>`;
  const cards2 = parseCardHtml(html2);
  assert.equal(cards2.length, 1, 'case 3f/aliased-inputs: the well-formed card with a valid product <img> still parses');
  assert.equal(cards2[0].imageVersion, '', 'case 3f (CR#round3-2 fix): `data-class="cart_ver"` must NOT populate imageVersion');
  assert.equal(cards2[0].imageCid, '', 'case 3f (CR#round3-2 fix): `data-class="cart_cid"` must NOT populate imageCid');
  assert.equal(cards2[0].yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 3f/aliased-inputs: yuyuImage comes from the valid <img>, not the aliased inputs');
}

// ── Case 3g (CR round 3, blocker #3): bare (unquoted) `class=card-product`
//     is a valid HTML5 attribute form and the container matcher must
//     accept it. The prior container regex only allowed `"…"` / `'…'`,
//     so a bare `<div class=card-product>` produced zero rows. A real
//     HTML parser handles bare quoting natively; the regression pins it. ──
{
  // Bare `class=card-product` container + bare-quoted product-img +
  // bare-quoted cart inputs wrapped in a bare-quoted `.counter` div
  // (the CR round-4 source-boundary invariant requires cart inputs to
  // live inside a `.counter` container regardless of quoting style).
  const html = `<!DOCTYPE html><html><body>
<div class=card-product>
<a href=https://yuyu-tei.jp/x><div class=product-img>
<img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg" alt="hBP04-001 SEC 博衣こより" class=card>
</div></a>
<span class=d-block>hBP04-001</span>
<h4 class=text-primary>博衣こより</h4>
<strong class=text-end>99,800 円</strong>
<div class=counter>
<input type=hidden value=hbp04 class=cart_ver>
<input type=hidden value=10003 class=cart_cid>
</div>
</div>
</body></html>`;

  const cards = parseCardHtml(html);
  assert.equal(cards.length, 1, 'case 3g (CR#round3-3 fix): bare-quoted `<div class=card-product>` must parse');
  const c = cards[0];
  assert.equal(c.cardNum, 'hBP04-001', 'case 3g: card number extracted');
  assert.equal(c.rarity, 'SEC', 'case 3g: rarity extracted');
  assert.equal(c.sellPrice, 99800, 'case 3g: price extracted');
  assert.equal(c.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 3g: yuyuImage extracted from bare `class=card` <img>');
  assert.equal(c.imageVersion, 'hbp04', 'case 3g: imageVersion extracted from bare `class=cart_ver` input inside bare `class=counter`');
  assert.equal(c.imageCid, '10003', 'case 3g: imageCid extracted from bare `class=cart_cid` input inside bare `class=counter`');
}

// ── Case 3h (CR round 3, primary blocker): production-shaped
//     unclosed outer .card-product with its own name/price and an EMPTY
//     product-img container, followed by a valid sibling. The prior
//     round-3 head passed the empty-product-img check (the outer has a
//     product-img div, just no inner <img>), and HTML5's no-implicit-
//     close rule for `<div>` made cheerio fold the later sibling INTO the
//     outer. The outer then borrowed the sibling's trusted image and
//     cart_ver/cart_cid, emitted its own ¥1 with the sibling's
//     /hbp04/10003.jpg URL, and produced a duplicate `hBP04-001 SEC`
//     entry that would win lowest-price selection downstream.
//
//     Requirement: the outer must be DROPPED, the valid sibling must be
//     preserved verbatim, and no admitted row may carry the outer's ¥1
//     with the sibling's URL. ──
{
  const html = `<!DOCTYPE html><html><body>
<div class="row row-cols-md-4">

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"></div></a>
<span class="d-block">hBP04-001</span>
<h4 class="text-primary">fake pre-empt</h4>
<strong class="text-end">1 円</strong>
<!-- MISSING own </div> — the CR-round-3 primary mutation -->

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"><img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg" alt="hBP04-001 SEC 博衣こより(パラレル/サイン)" class="card img-fluid"></div></a>
<span class="d-block">hBP04-001</span>
<h4 class="text-primary">博衣こより(パラレル/サイン)</h4>
<strong class="text-end">99,800 円</strong>
<div class="d-flex counter text-center">
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="10003" class="cart_cid">
</div>
</div>

</div>
</body></html>`;

  const cards = parseCardHtml(html);

  // Exactly ONE admitted row — the valid sibling. The unclosed outer must
  // be dropped fully, not admitted as a duplicate.
  assert.equal(
    cards.length,
    1,
    `case 3h (CR round-3 primary fix): the unclosed outer must be DROPPED so exactly one admitted row (the valid sibling) remains — got ${cards.length}: ${JSON.stringify(cards)}`,
  );
  const sibling = cards[0];
  assert.equal(sibling.cardNum, 'hBP04-001', 'case 3h: sibling cardNum preserved');
  assert.equal(sibling.rarity, 'SEC', 'case 3h: sibling rarity preserved');
  assert.equal(sibling.sellPrice, 99800, 'case 3h: sibling price preserved — the outer\'s ¥1 must NOT win');
  assert.equal(sibling.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg', 'case 3h: sibling yuyuImage preserved');
  assert.equal(sibling.imageVersion, 'hbp04', 'case 3h: sibling imageVersion preserved');
  assert.equal(sibling.imageCid, '10003', 'case 3h: sibling imageCid preserved');

  // No admitted row anywhere may carry the outer's ¥1 laundered with the
  // sibling's URL — the CR flagged exactly this shape as the false ¥1 row.
  for (const c of cards) {
    assert.ok(
      !(c.sellPrice === 1 && c.yuyuImage === 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg'),
      `case 3h (CR round-3 primary fix): the ¥1 outer paired with the sibling's /hbp04/10003.jpg URL must never be admitted (row ${JSON.stringify(c)})`,
    );
  }

  // Prove same principle when the "later sibling" is instead a footer
  // with just cart inputs and no valid image — the outer's absorbed
  // footer must also not synth a laundered URL.
  const html2 = `<!DOCTYPE html><html><body>
<div class="row row-cols-md-4">

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"></div></a>
<span class="d-block">hBP04-099</span>
<h4>fake pre-empt</h4>
<strong>1 円</strong>
<!-- MISSING own </div> -->

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"><img src="https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg" alt="hBP04-004 SEC other"></div></a>
<span class="d-block">hBP04-004</span>
<h4>other</h4>
<strong>500 円</strong>
<div class="d-flex counter text-center">
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="20001" class="cart_cid">
</div>
</div>

</div>
</body></html>`;
  const cards2 = parseCardHtml(html2);
  const seen2 = new Set(cards2.map((c) => c.cardNum));
  assert.ok(!seen2.has('hBP04-099'), 'case 3h/2 (CR round-3 primary fix): the unclosed outer that would have inherited the sibling\'s /hbp04/20001.jpg URL under a different card number must be DROPPED');
  assert.ok(seen2.has('hBP04-004'), 'case 3h/2: the valid sibling must still be admitted');
  const sibling2 = cards2.find((c) => c.cardNum === 'hBP04-004');
  assert.equal(sibling2.sellPrice, 500, 'case 3h/2: sibling price preserved');
  assert.equal(sibling2.yuyuImage, 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/20001.jpg', 'case 3h/2: sibling URL preserved');
}

// ── Case 3i (CR round 4, sole blocker): production-shaped unclosed
//     outer .card-product with its own name/price and an EMPTY product-img
//     container, followed by FOOTER cart_ver / cart_cid inputs (NO valid
//     later sibling, NO other card-product). The nested-card guard from
//     round 4 does not fire because there is no descendant card-product;
//     HTML5's no-implicit-close rule for `<div>` still folds the footer
//     inputs into the unclosed card, and an unrestricted descendant
//     lookup (`$el.find('input.cart_ver')`) would synth
//     `https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg` from those
//     folded footer values (¥1 laundered row — exactly the CR-flagged
//     `hBP04-099` shape).
//
//     Source-boundary invariant (CR round-4 fix): yuyu-tei's real
//     card-product wraps cart inputs inside a `<div class="d-flex counter
//     text-center">` container. Scoping the cart-input lookup to that
//     container means FOOTER inputs (which live at the card-product's
//     root level, not inside .counter) return empty — no synth URL is
//     produced — and the card drops via the no-image + no-cart-inputs
//     fallthrough. The valid baseline card in the same page still parses
//     because its cart inputs ARE inside .counter. ──
{
  const goodBlock = makeCardBlock({
    cardNum: 'hBP04-001', rarity: 'SEC',
    imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/10003.jpg',
    cartVer: 'hbp04', cartCid: '10003', price: '99,800',
  });

  // CR round-4 mutation: unclosed outer, empty product-img, footer
  // cart_ver/cart_cid inputs OUTSIDE any .counter container. The outer
  // has NO nested card-product (so the round-3/round-4 nested guard does
  // NOT fire). Only the source-boundary invariant closes this bypass.
  const html = `<!DOCTYPE html><html><body>
<div class="row row-cols-md-4">

${goodBlock}

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"></div></a>
<span class="d-block">hBP04-099</span>
<h4>fake pre-empt</h4>
<strong>1 円</strong>
<!-- MISSING own </div> — the CR round-4 primary mutation.
     Footer cart inputs follow WITHOUT any .counter wrapper. -->
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="99999" class="cart_cid">

</div>
</body></html>`;

  const cards = parseCardHtml(html);
  const seen = new Set(cards.map((c) => c.cardNum));

  assert.ok(seen.has('hBP04-001'), 'case 3i: the good baseline card must still parse');
  assert.ok(
    !seen.has('hBP04-099'),
    'case 3i (CR round-4 sole blocker fix): the unclosed outer whose only cart inputs are FOOTER (outside .counter) must be DROPPED, not admitted via laundered cart-inputs synth into /hbp04/99999.jpg',
  );
  for (const c of cards) {
    assert.notEqual(
      c.yuyuImage,
      'https://card.yuyu-tei.jp/hocg/100_140/hbp04/99999.jpg',
      `case 3i (CR round-4 sole blocker fix): the CR-flagged laundered /hbp04/99999.jpg URL must not appear on any admitted row (row ${JSON.stringify(c)})`,
    );
    assert.notEqual(
      c.sellPrice,
      1,
      `case 3i (CR round-4 sole blocker fix): the outer's ¥1 must not win lowest-price selection anywhere (row ${JSON.stringify(c)})`,
    );
  }

  // Prove same principle when the outer has NO baseline sibling to
  // shield against a global "0 rows means broken parser" false green:
  // this variant should emit ZERO rows, not one laundered row.
  const htmlSolo = `<!DOCTYPE html><html><body>
<div class="row row-cols-md-4">

<div class="card-product">
<a href="https://yuyu-tei.jp/x"><div class="product-img"></div></a>
<span class="d-block">hBP04-099</span>
<h4>fake pre-empt</h4>
<strong>1 円</strong>
<input type="hidden" value="hbp04" class="cart_ver">
<input type="hidden" value="99999" class="cart_cid">

</div>
</body></html>`;
  const cardsSolo = parseCardHtml(htmlSolo);
  assert.equal(
    cardsSolo.length,
    0,
    `case 3i/solo (CR round-4 sole blocker fix): a lone unclosed card with only footer cart inputs must emit ZERO rows, not one laundered row — got ${JSON.stringify(cardsSolo)}`,
  );
}

// ── Case 4: end-to-end binding through build-database.js ──
// The parseCardHtml fix is worthless if the downstream binding logic still
// discards the listing. Feed a synthetic yuyu fixture whose entries have
// the exact shape parseCardHtml now emits (yuyuImage, imageVersion,
// imageCid, rarity, sourceSeries) and prove the fixture lands on the
// correct official printing row.
const dbPath = path.join(repo, 'data/database.json');
const publicDbPath = path.join(repo, 'public/data/database.json');
const scrapeLogPath = path.join(repo, 'data/scrape-log.txt');
const priceHistoryIndexPath = path.join(repo, 'data/price-history/index.json');
const originalDb = fs.readFileSync(dbPath, 'utf8');
const originalPublicDb = fs.readFileSync(publicDbPath, 'utf8');
const originalScrapeLog = fs.existsSync(scrapeLogPath) ? fs.readFileSync(scrapeLogPath, 'utf8') : null;
const originalPriceHistoryIndex = fs.existsSync(priceHistoryIndexPath) ? fs.readFileSync(priceHistoryIndexPath, 'utf8') : null;

const historyDir = path.join(repo, 'data/price-history');
const preRunBytes = new Map();
for (const f of fs.readdirSync(historyDir)) {
  const p = path.join(historyDir, f);
  if (fs.statSync(p).isFile()) preRunBytes.set(p, fs.readFileSync(p));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1349-fallback-'));
const fixturePath = path.join(tmp, 'yuyu-dic1349.json');

let passed = false;
try {
  const baseline = JSON.parse(originalDb);
  const cards = baseline.cards || {};

  // Pick an official printing whose sourceProduct we can drive an exact-
  // print listing for. Any hBP04 C printing works — the fixture below
  // synthesises a listing whose yuyuImage matches the row's sourceProduct.
  const targetKey = Object.keys(cards).find((k) => {
    const c = cards[k];
    return c && c.cardNumber && String(c.sourceProduct || c.series || '').toLowerCase() === 'hbp04';
  });
  assert.ok(targetKey, 'case 4: expected at least one hBP04 official printing in the shipped database');
  const target = cards[targetKey];

  // Build the fixture from parseCardHtml's OWN output shape (rarity,
  // yuyuImage, imageVersion, imageCid). This is what
  // scrapeAllWithFetch would produce on the fresh-root-install path.
  const parsed = parseCardHtml(wrapPage([
    makeCardBlock({
      cardNum: target.cardNumber,
      rarity: target.rarity || 'C',
      name: target.name || 'カード',
      price: '777',
      imgSrc: 'https://card.yuyu-tei.jp/hocg/100_140/hbp04/dic1349.jpg',
      cartVer: 'hbp04',
      cartCid: 'dic1349',
    }),
  ]));
  assert.equal(parsed.length, 1, 'case 4: exactly one listing must parse');
  const listing = parsed[0];

  const fixture = {
    prices: {
      [listing.cardNum]: [
        {
          sellPrice: listing.sellPrice,
          rarity: listing.rarity,
          name: listing.name,
          yuyuImage: listing.yuyuImage,
          imageVersion: listing.imageVersion,
          imageCid: listing.imageCid,
          sourceSeries: 'hBP04',
          timestamp: new Date().toISOString(),
        },
      ],
    },
    totalCards: 100,
    seriesWithPrices: 1,
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));

  const build = spawnSync(process.execPath, ['scripts/build-database.js'], {
    cwd: repo,
    env: {
      ...process.env,
      HUNTERCARD_YUYU_FIXTURE_PATH: fixturePath,
      HUNTERCARD_SKIP_IMAGE_DOWNLOADS: '1',
    },
    encoding: 'utf8',
  });
  assert.equal(
    build.status,
    0,
    `case 4: build-database.js fixture run must succeed on the parseCardHtml-shaped fixture\nSTDOUT:\n${build.stdout}\nSTDERR:\n${build.stderr}`,
  );

  const rebuilt = JSON.parse(fs.readFileSync(dbPath, 'utf8')).cards;
  const boundRow = rebuilt[targetKey];
  assert.ok(boundRow, `case 4: target row ${targetKey} must survive the build`);
  assert.equal(
    boundRow.sellPrice,
    777,
    `case 4: fallback-shaped listing must bind onto the target official printing (got sellPrice=${boundRow.sellPrice})`,
  );
  assert.equal(
    yuyuImageProductPath(boundRow.yuyuImage),
    'hbp04',
    `case 4: bound yuyuImage must retain its hBP04 product path (got ${boundRow.yuyuImage})`,
  );
  passed = true;
} finally {
  fs.writeFileSync(dbPath, originalDb);
  fs.writeFileSync(publicDbPath, originalPublicDb);
  if (originalScrapeLog === null) {
    fs.rmSync(scrapeLogPath, { force: true });
  } else {
    fs.writeFileSync(scrapeLogPath, originalScrapeLog);
  }
  if (originalPriceHistoryIndex === null) {
    fs.rmSync(priceHistoryIndexPath, { force: true });
  } else {
    fs.writeFileSync(priceHistoryIndexPath, originalPriceHistoryIndex);
  }
  // Restore every pre-existing price-history file byte-for-byte, and delete
  // any file the build produced fresh. Matches the pattern used by
  // scripts/test-dic1334-final-artifact-collapse.mjs.
  const postFiles = new Set(fs.readdirSync(historyDir).map((f) => path.join(historyDir, f)));
  for (const [p, bytes] of preRunBytes) fs.writeFileSync(p, bytes);
  for (const p of postFiles) {
    if (!preRunBytes.has(p) && fs.statSync(p).isFile()) fs.rmSync(p, { force: true });
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

assert.ok(passed, 'case 4: end-to-end binding must complete without an early throw');

console.log('✓ DIC-1349 HTTP fallback exact-printing provenance regression passed');
