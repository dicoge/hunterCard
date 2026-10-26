#!/usr/bin/env node
/**
 * test-dic1461-yuyu-parser-rarity.mjs — DIC-1461 Puppeteer parser regression.
 *
 * Live evidence (artifact price-evidence-live-20260917.json) proved the
 * 2026-09-17 1216→424 priced-cardNumber collapse was caused by yuyu-tei's
 * card-product redesign: the card number now sits alone in its own <span>
 * and the name in an <h4>, so the legacy single-line "hXXX-nnn RARITY name"
 * shape the Puppeteer extractor relied on is gone and EVERY listing parsed
 * with rarity '' — leaving only single-candidate printings provable.
 *
 * The listing's own product-image alt still carries the full immutable
 * identity ("hBP01-001 OUR 天音かなた(パラレル)"), which is exactly where
 * the DIC-1349 HTTP-fallback parser already reads it from. This regression
 * proves the Puppeteer path now does the same, hermetically, against the
 * REAL captured 2026-09-17 live markup served from a local HTTP server
 * (no external network):
 *
 *   1. Redesigned markup: rarity comes from the listing's own image alt
 *      (OUR / SEC), name from <h4>, image URL from the product <img>.
 *   2. A foreign alt (different card number) can never vouch for a
 *      listing's rarity — stays '' (fail closed, no cross-listing borrow).
 *   3. Legacy markup (rarity token inline in the card line) still parses
 *      identically — the alt derivation only fills the gap.
 *
 * Run: node scripts/test-dic1461-yuyu-parser-rarity.mjs
 */
import assert from 'node:assert/strict';
import http from 'node:http';

import { scrapeSeriesPage } from './build-database.js';

// Real .card-product markup captured live on 2026-09-17 (trimmed to the
// structural elements the parser walks; image src rewritten to the local
// server so the page settles without external network — the parser only
// matches on the substring 'card.yuyu-tei.jp' in the src attribute).
const cardProduct = ({ cardNum, alt, name, img, soldOut = false }) => `
<div class="card-product position-relative mt-4 ${soldOut ? ' sold-out ' : ' '}">
  <a href="#"><div class="position-relative product-img">
  <img src="IMGBASE/card.yuyu-tei.jp/hocg/100_140/${img}" alt="${alt}" class="card img-fluid"></div></a>
  <span class="d-block border border-dark p-1 w-100 text-center my-2">${cardNum}</span>
  <a href="#"><h4 class="text-primary fw-bold">${name}</h4></a>
  <strong class="d-block text-end">24,800 円</strong>
  <div class="form-check p-0"><label class="form-check-label fw-bold float-start cart_sell_zaiko">在庫 : 3 点</label></div>
  <div class="d-flex counter text-center">
    <input type="hidden" value="hbp01" class="cart_ver">
    <input type="hidden" value="10013" class="cart_cid">
  </div>
  <a href="javascript:;" class="btn btn-primary cart_sell_in w-100 main-btn fw-bold mt-2">カートへ</a>
</div>`;

// Legacy (pre-redesign) shape: card number + rarity token + name on one line.
const legacyCardProduct = `
<div class="card-product position-relative mt-4">
  <img src="IMGBASE/card.yuyu-tei.jp/hocg/100_140/hbp01/10001.jpg" alt="hBP01-001 OSR 天音かなた" class="card img-fluid">
  <div>hBP01-001 OSR 天音かなた</div>
  <strong>780 円</strong>
  <div class="d-flex counter text-center">
    <input type="hidden" value="hbp01" class="cart_ver">
    <input type="hidden" value="10001" class="cart_cid">
  </div>
</div>`;

const pageHtml = (imgBase) => `<!DOCTYPE html><html><head><title>fixture</title></head><body>
${cardProduct({
    cardNum: 'hBP01-006',
    alt: 'hBP01-006 SEC 小鳥遊キアラ(パラレル/サイン)',
    name: '小鳥遊キアラ(パラレル/サイン)',
    img: 'hbp01/10013.jpg',
  })}
${cardProduct({
    cardNum: 'hBP01-001',
    alt: 'hBP01-001 OUR 天音かなた(パラレル)',
    name: '天音かなた(パラレル)',
    img: 'hbp01/10002.jpg',
  })}
${cardProduct({
    cardNum: 'hBP01-002',
    alt: 'hBP09-999 UR まったく別のカード',
    name: 'アキ・ローゼンタール',
    img: 'hbp01/10004.jpg',
  })}
${legacyCardProduct}
</body></html>`.replaceAll('IMGBASE/', imgBase);

const GIF = Buffer.from('R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==', 'base64');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url.startsWith('/?')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml(`http://127.0.0.1:${server.address().port}/`));
  } else {
    res.writeHead(200, { 'content-type': 'image/gif' });
    res.end(GIF);
  }
});

await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

let browser;
try {
  const puppeteer = (await import('puppeteer-extra')).default;
  const StealthPlugin = (await import('puppeteer-extra-plugin-stealth')).default;
  puppeteer.use(StealthPlugin());
  browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
  });

  const cards = await scrapeSeriesPage(browser, url);
  const byNum = new Map(cards.map((c) => [`${c.cardNum}|${c.imageCid ?? ''}`, c]));

  // ── 1. Redesigned markup: rarity restored from the listing's own alt ──
  const sec = cards.find((c) => c.cardNum === 'hBP01-006');
  assert.ok(sec, 'redesigned SEC listing must parse');
  assert.equal(sec.rarity, 'SEC', `rarity must come from the product image alt (got '${sec.rarity}')`);
  assert.equal(sec.name, '小鳥遊キアラ(パラレル/サイン)', 'name must come from the <h4>');
  assert.ok(sec.yuyuImage.includes('card.yuyu-tei.jp/hocg/100_140/hbp01/10013.jpg'), 'image URL must be the listing product image');

  const our = cards.find((c) => c.cardNum === 'hBP01-001' && c.name.includes('パラレル'));
  assert.ok(our, 'redesigned OUR listing must parse');
  assert.equal(our.rarity, 'OUR', `rarity must come from the product image alt (got '${our.rarity}')`);

  // ── 2. Foreign alt must never vouch for this listing ──
  const foreign = cards.find((c) => c.cardNum === 'hBP01-002');
  assert.ok(foreign, 'foreign-alt listing must still parse (price/name/image)');
  assert.equal(
    foreign.rarity,
    '',
    `an alt naming a DIFFERENT card number must not supply this listing's rarity (got '${foreign.rarity}')`,
  );

  // ── 3. Legacy markup unchanged: inline token still wins ──
  const legacy = cards.find((c) => c.cardNum === 'hBP01-001' && !c.name.includes('パラレル'));
  assert.ok(legacy, 'legacy-shape listing must parse');
  assert.equal(legacy.rarity, 'OSR', 'legacy inline rarity token must keep working');

  assert.equal(byNum.size, cards.length, 'sanity: listings are distinct per cardNum+imageCid');
  console.log('✓ DIC-1461 yuyu Puppeteer parser rarity regression passed (alt-derived, fail-closed on foreign alt, legacy intact)');
} finally {
  if (browser) { try { await browser.close(); } catch { /* closed */ } }
  server.close();
}
