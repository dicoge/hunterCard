#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { discoverExpansionsFromHtml, parseCardsFromHtml } from './scrape-official-cards.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');

const selectFixture = `
<select class="saerchform-Select" name="expansion_name">
  <option value="">指定なし</option>
  <option value="selehGS26">【使用可能カード】hGS 2026 大阪 セレクションロード</option>
  <option value="hEB01">エクストラブースター サマー・ホログラム</option>
</select>`;

const discovered = discoverExpansionsFromHtml(selectFixture);
assert.deepStrictEqual(discovered.map((e) => e.code), ['hEB01'], 'discovery must include hEB01 and exclude legality label selehGS26');

const lazyPageFixture = `
<li class="ex-item"><a href="/cardlist/?id=2525&%2Fcardlist%2Fcardsearch_ex=&expansion=hEB01&view=text">
<div class="img w100"><img src="/wp-content/images/cardlist/hEB01/hBP01-081_RR_02.png" alt="星街すいせい"></div>
<p class="number">hBP01-081</p><p class="name">星街すいせい</p>
<div class="info"><dl><dt>カードタイプ</dt><dd>ホロメン</dd><dt>レアリティ</dt><dd>RR</dd><dt>収録商品</dt><dd>エクストラブースター サマー・ホログラム<br />【使用可能カード】hGS 2026 大阪 セレクションロード</dd></dl>
<dl class="info_Detail"><dt>色</dt><dd><img src="/wp-content/images/texticon/type_blue.png" alt="青" /></dd><dt>HP</dt><dd>120</dd><dt>Bloomレベル</dt><dd>1st</dd></dl></div>
</a></li>`;
const parsed = parseCardsFromHtml(lazyPageFixture, 'hEB01');
assert.strictEqual(parsed.length, 1, 'lazy cardsearch_ex hrefs must parse');
assert.strictEqual(parsed[0].sourceProduct, 'hEB01');
assert.strictEqual(parsed[0].color, 'blue');
assert.strictEqual(parsed[0].sellPrice, undefined, 'official parser must not invent prices');

const officialPath = path.join(repo, 'data/official/hEB01.json');
const dbPath = path.join(repo, 'data/database.json');
const nativePath = path.join(repo, 'public/data/database.json');
const auditPath = path.join(repo, 'docs/audits/official-catalog-audit.json');

const official = JSON.parse(fs.readFileSync(officialPath, 'utf8'));
assert.strictEqual(official.length, 214, 'hEB01 official file must contain the official 214 rows');
assert.ok(official.every((c) => c.sourceProduct === 'hEB01'), 'every hEB01 row must carry sourceProduct=hEB01');
assert.ok(!official.some((c) => c.sourceProduct === 'selehGS26'), 'selehGS26 must not become a sourceProduct/printing');
assert.ok(official.some((c) => c.cardNumber === 'hBP01-021' && c.rarity === 'C'));
assert.ok(official.some((c) => c.cardNumber === 'hBP01-021' && c.rarity === 'HR'), 'same card number distinct printings must be preserved');

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const hEB01Cards = Object.values(db.cards || {}).filter((c) => c.sourceProduct === 'hEB01' || c.series === 'hEB01');
assert.strictEqual(hEB01Cards.length, 214, 'database must contain 214 hEB01 printings');
assert.ok(hEB01Cards.every((c) => c.sellPrice == null && Array.isArray(c.prices) && c.prices.length === 0), 'hEB01 exact-version prices must remain null/unknown when yuyu has no exact hEB01 source');

const native = JSON.parse(fs.readFileSync(nativePath, 'utf8'));
const nativeHEB01 = Object.values(native.cards || {}).filter((c) => c.sourceProduct === 'hEB01' || c.series === 'hEB01');
assert.strictEqual(nativeHEB01.length, 214, 'native/public database must contain hEB01');

const audit = JSON.parse(fs.readFileSync(auditPath, 'utf8'));
const auditHEB01 = audit.officialToNormalized?.find((s) => s.code === 'hEB01');
assert.ok(auditHEB01, 'audit must include hEB01');
assert.strictEqual(auditHEB01.expectedCount, 214);
assert.strictEqual(auditHEB01.ingestedCount, 214);
assert.strictEqual(auditHEB01.missingCount, 0);

console.log('✓ official catalog sync invariants passed');
