#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildPreservationIndex,
  findPreservedMatch,
  applyPreservedMarketFields,
} from './lib/preserve-market-fields.js';
import { printingId, imageSuffix } from './lib/printing-identity.js';
import { broadcastYtStats } from './lib/yt-stats-fanout.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const officialDir = path.join(repo, 'data', 'official');
const dbPath = path.join(repo, 'data', 'database.json');
const translationPath = path.join(repo, 'data', 'character-names-zh.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// DIC-1415: the sync writer is the single place brand-new printings enter the
// database, and it MUST enrich them with controlled Traditional-Chinese names
// from data/character-names-zh.json — the same map add-zh-names.js uses for
// build-database.js. Carrying only `previous.nameZh` forward works for rows
// that already exist, but a newly discovered expansion (upstream hBP09
// 「ボリュームヴォルテックス」) upserts only fresh rows, so every one shipped with
// no nameZh and the scheduled sync died at the Validate gate. The map is the
// only source of translations (never an unauthorized translation provider; the
// DIC-1185 OpenRouter denylist stays in force). Rows whose names have no
// controlled entry are left without nameZh so the existing Validate gate —
// `database must fail closed instead of shipping empty Traditional-Chinese
// names` — keeps tripping and no incomplete publication is ever staged.
function loadTranslationMap(filepath) {
  if (!fs.existsSync(filepath)) {
    throw new Error(`${filepath} missing; cannot enrich new printings with Traditional-Chinese names`);
  }
  const raw = readJson(filepath);
  // DIC-1417: a plain `{}` leaks Object.prototype through `translationMap[key]`
  // lookups — an untranslated official name such as `__proto__` resolves to the
  // inherited Object.prototype object (truthy, non-string) and sails past the
  // `!card.nameZh` fail-closed gate as `nameZh: {}`. A null-prototype object
  // keeps resolution own-property-only AND stores literal keys like `__proto__`
  // or `constructor` as real own entries instead of aliasing the prototype.
  const clean = Object.create(null);
  for (const [jp, zh] of Object.entries(raw)) {
    // Match add-zh-names.js: drop entries corrupted with U+FFFD replacement
    // characters so poisoning cannot leak into the database.
    if (jp.includes('\uFFFD') || zh.includes('\uFFFD')) continue;
    clean[jp] = zh;
  }
  return clean;
}

function decodeNameZhCandidate(input = '') {
  return String(input)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#039;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function resolveNameZh(name, previousNameZh, translationMap) {
  // Own-property-only, non-empty-string resolution (DIC-1417): a preserved or
  // translated nameZh must be a real string — never an inherited prototype
  // object — so untranslated rows stay fail-closed (`''` trips `!nameZh`).
  if (typeof previousNameZh === 'string' && previousNameZh.trim()) return previousNameZh;
  const nameKey = String(name || '');
  for (const candidate of [nameKey, decodeNameZhCandidate(nameKey)]) {
    if (!Object.hasOwn(translationMap, candidate)) continue;
    const zh = translationMap[candidate];
    if (typeof zh === 'string' && zh.trim()) return zh;
  }
  return '';
}

function cardSignature(card) {
  return [
    card.cardNumber || '',
    card.sourceProduct || card.expansion || card.series || '',
    card.rarity || '',
    imageSuffix(card.imageUrl) || card.id || '',
  ].join('|');
}

function dbCardSignature(id, card) {
  return [
    card.cardNumber || '',
    card.sourceProduct || card.series || '',
    card.rarity || '',
    imageSuffix(card.officialImage || card.imageUrl || '') || String(id).split('_').slice(3).join('_') || '',
  ].join('|');
}

function toDatabaseCard(card, id) {
  return {
    id,
    cardNumber: card.cardNumber || '',
    name: card.name || '',
    type: card.cardType || card.type || '',
    color: card.color || '',
    rarity: card.rarity || '',
    series: card.expansion || card.series || card.sourceProduct || '',
    sourceProduct: card.sourceProduct || card.expansion || card.series || '',
    sourceProductName: card.sourceProductName || '',
    sourceProductText: card.sourceProductText || '',
    sellPrice: null,
    yuyuName: '',
    yuyuImage: '',
    prices: [],
    officialImage: card.imageUrl || '',
    localImage: '',
    hp: card.hp || '',
    life: card.life || '',
    arts: card.arts || '',
    bloomLevel: card.bloomLevel || '',
    timestamp: '',
    _rawPricesArchive: [],
  };
}

// DIC-1204/1321: exact-id lookups miss rows whose printing IDs get renamed by
// DIC-1084 canonicalization, wiping their proven sellPrice / priceHistory /
// ytStats. Preservation now routes through `applyPreservedMarketFields`
// (matching build-database.js): exact id first, then a strict
// cardNumber|sourceProduct|rarity signature; ambiguous signatures refuse to
// guess; and yuyu-derived fields only carry forward when the previous
// yuyuImage URL provably matches the current sourceProduct (DIC-1227), with a
// signature fallback onto a SEC signed printing stripping prices[] and yuyu
// descriptors (DIC-1013/1140 fail-closed).

function canonicalProductsFromMeta(officialDirectory) {
  const meta = readJson(path.join(officialDirectory, '_meta.json'));
  const products = new Set((meta.seriesStats || meta.series || [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.code)
    .filter(Boolean));
  if (products.size === 0) throw new Error('data/official/_meta.json missing canonical product list');
  return products;
}

export function syncOfficialCatalogToDatabase({ databasePath = dbPath, officialDirectory = officialDir, translationPath: nameZhMapPath = translationPath } = {}) {
  const db = readJson(databasePath);
  if (!db.cards || typeof db.cards !== 'object') throw new Error('data/database.json missing cards map');

  // DIC-1421: brand-new printings (new id, new sourceProduct) have no previous
  // row for `applyPreservedMarketFields` to preserve ytStats from — a fresh
  // hBP09/hPR reprint of an already-tracked holomen shipped without ytStats and
  // the DIC-1153/1204 audit went red (expected 2136 rows to carry ytStats; got
  // 2072 on the 2026-09-12 sync PR #191). Snapshot the pre-upsert cards and,
  // after the upsert pass, run the canonical name-based broadcast
  // (`lib/yt-stats-fanout.js`) which fans the member's owned, source-proven
  // ytStats onto every newly added printing whose name/nameZh matches — exactly
  // the deterministic fan-out `restore-market-fields-post-canonicalization.mjs`
  // uses for the DIC-1153 pinned row count. Nothing untracked or malformed is
  // ever broadcast, and preserved ytStats is never displaced (fill-only).
  const previousCards = { ...db.cards };
  const zhNames = loadTranslationMap(nameZhMapPath);
  const canonicalProducts = canonicalProductsFromMeta(officialDirectory);
  const officialFiles = fs.readdirSync(officialDirectory)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('all-') && !f.startsWith('cardList_'));

  // DIC-1204: index the previous DB by both exact id AND strict
  // cardNumber|sourceProduct|rarity signature so a canonical-id rename does
  // not silently drop that row's proven sellPrice / priceHistory / ytStats.
  const preservationIndex = buildPreservationIndex(db.cards);
  let upserted = 0;
  let sellPreserved = 0;
  const canonicalSignatures = new Set();
  for (const file of officialFiles) {
    const cards = readJson(path.join(officialDirectory, file));
    if (!Array.isArray(cards)) continue;
    for (const card of cards) {
      if (!card?.sourceProduct || !canonicalProducts.has(card.sourceProduct)) continue;
      canonicalSignatures.add(cardSignature(card));
      const id = printingId(card);
      if (!id || !card.cardNumber) continue;
      const preview = toDatabaseCard(card, id);
      const match = findPreservedMatch(preservationIndex, id, preview);
      const previous = match?.card || db.cards[id] || {};
      const matchKind = match?.matchKind || 'exact-id';
      // DIC-1321: route preservation through `applyPreservedMarketFields`
      // (the same path build-database.js uses) instead of the ungated
      // `preservedMarketPayload` spread. The old path flattened the previous
      // row's prices[] / sellPrice / priceHistory onto the fresh row without
      // the `yuyuPayloadMatchesSource` gate, so an official-sync running on a
      // 0-priced snapshot would blindly re-inflate every row — the 0↔1547
      // oscillation (local scheduler writes 0; official-sync ungated-restores
      // 1547; repeat). The gated path keeps printing/product isolation:
      // sellPrice / prices[] / priceHistory only carry forward when the
      // previous yuyuImage URL provably matches this row's sourceProduct, and
      // prices[] survives only entry-by-entry on provable matches. Fresh
      // non-null fields still win. ytStats/skills stay preserved as before.
      // applyPreservedMarketFields mutates `preview` in place with the gated
      // payload, so preview is the final row.
      const summary = applyPreservedMarketFields(preview, previous, {
        matchKind,
        preserveYuyuPayload: true,
      });
      if (summary.sellPrice || summary.prices || summary.priceHistory || summary.ytStats || summary.yuyu) sellPreserved++;
      db.cards[id] = {
        ...preview,
        skillsJp: previous.skillsJp,
        skillsZh: previous.skillsZh,
        // DIC-1415: brand-new printings have no previous row to preserve nameZh
        // from — resolve a controlled Traditional-Chinese name or stay
        // fail-closed so the Validate gate still refuses incomplete names.
        nameZh: resolveNameZh(card.name, previous.nameZh, zhNames),
      };
      for (const key of ['skillsJp', 'skillsZh', 'nameZh', 'ytStats']) {
        if (db.cards[id][key] == null) delete db.cards[id][key];
      }
      upserted++;
    }
  }

  // DIC-1421: broadcast owned ytStats onto every newly added printing whose
  // normalized character name maps to a tracked holomen (fill-only, seeds from
  // current then pre-sync rows). Runs before pruning so a to-be-pruned row can
  // still serve as the proven seed for its member's surviving printings.
  const ytStatsBroadcast = broadcastYtStats(db.cards, previousCards);

  let pruned = 0;
  for (const [id, card] of Object.entries(db.cards)) {
    const sourceProduct = card?.sourceProduct || card?.series || '';
    if (!canonicalProducts.has(sourceProduct)) continue;
    if (canonicalSignatures.has(dbCardSignature(id, card))) continue;
    delete db.cards[id];
    pruned++;
  }

  db.lastUpdated = new Date().toISOString();
  db.totalCards = Object.keys(db.cards).length;
  fs.writeFileSync(databasePath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  return { upserted, sellPreserved, pruned, ytStatsBroadcast, totalCards: db.totalCards };
}

function main() {
  const result = syncOfficialCatalogToDatabase();
  console.log(`✓ synced ${result.upserted} official sourceProduct printings into data/database.json (totalCards=${result.totalCards}; preservedSell=${result.sellPreserved}; pruned=${result.pruned}; ytStatsBroadcast=${result.ytStatsBroadcast})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
