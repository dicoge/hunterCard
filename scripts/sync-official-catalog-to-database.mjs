#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(__dirname, '..');
const officialDir = path.join(repo, 'data', 'official');
const dbPath = path.join(repo, 'data', 'database.json');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function imageSuffix(url = '') {
  return String(url).match(/\/([^/]+)\.png$/i)?.[1] || '';
}

function printingId(card) {
  const cardNumber = card.cardNumber || imageSuffix(card.imageUrl).match(/^(h[A-Za-z0-9]+-\d{3})/)?.[1] || '';
  const sourceProduct = card.sourceProduct || card.expansion || card.series || '';
  return [cardNumber, sourceProduct, card.rarity || '', imageSuffix(card.imageUrl) || card.id || '']
    .filter(Boolean)
    .join('_');
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

function preservedExactSellPayload(previous = {}) {
  const payload = {};
  if (Number.isFinite(previous.sellPrice) && previous.sellPrice > 0) payload.sellPrice = previous.sellPrice;
  if (Array.isArray(previous.prices) && previous.prices.length > 0) payload.prices = previous.prices;
  if (previous.yuyuName) payload.yuyuName = previous.yuyuName;
  if (previous.yuyuImage) payload.yuyuImage = previous.yuyuImage;
  if (previous.timestamp) payload.timestamp = previous.timestamp;
  if (previous.priceHistory && typeof previous.priceHistory === 'object' && Object.keys(previous.priceHistory).length > 0) {
    payload.priceHistory = previous.priceHistory;
  }
  if (Array.isArray(previous._rawPricesArchive) && previous._rawPricesArchive.length > 0) {
    payload._rawPricesArchive = previous._rawPricesArchive;
  }
  return payload;
}

function canonicalProductsFromMeta(officialDirectory) {
  const meta = readJson(path.join(officialDirectory, '_meta.json'));
  const products = new Set((meta.seriesStats || meta.series || [])
    .map((entry) => typeof entry === 'string' ? entry : entry?.code)
    .filter(Boolean));
  if (products.size === 0) throw new Error('data/official/_meta.json missing canonical product list');
  return products;
}

export function syncOfficialCatalogToDatabase({ databasePath = dbPath, officialDirectory = officialDir } = {}) {
  const db = readJson(databasePath);
  if (!db.cards || typeof db.cards !== 'object') throw new Error('data/database.json missing cards map');

  const canonicalProducts = canonicalProductsFromMeta(officialDirectory);
  const officialFiles = fs.readdirSync(officialDirectory)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('all-') && !f.startsWith('cardList_'));

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
      const previous = db.cards[id] || {};
      const preservedSell = preservedExactSellPayload(previous);
      if (Object.keys(preservedSell).length > 0) sellPreserved++;
      db.cards[id] = {
        ...toDatabaseCard(card, id),
        ...preservedSell,
        skillsJp: previous.skillsJp,
        skillsZh: previous.skillsZh,
        nameZh: previous.nameZh,
        ytStats: previous.ytStats,
      };
      for (const key of ['skillsJp', 'skillsZh', 'nameZh', 'ytStats']) {
        if (db.cards[id][key] == null) delete db.cards[id][key];
      }
      upserted++;
    }
  }

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
  return { upserted, sellPreserved, pruned, totalCards: db.totalCards };
}

function main() {
  const result = syncOfficialCatalogToDatabase();
  console.log(`✓ synced ${result.upserted} official sourceProduct printings into data/database.json (totalCards=${result.totalCards}; preservedSell=${result.sellPreserved}; pruned=${result.pruned})`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
