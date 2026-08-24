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

function main() {
  const db = readJson(dbPath);
  if (!db.cards || typeof db.cards !== 'object') throw new Error('data/database.json missing cards map');

  const officialFiles = fs.readdirSync(officialDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_') && !f.startsWith('all-') && !f.startsWith('cardList_'));

  let upserted = 0;
  for (const file of officialFiles) {
    const cards = readJson(path.join(officialDir, file));
    if (!Array.isArray(cards)) continue;
    for (const card of cards) {
      if (!card?.sourceProduct) continue;
      const id = printingId(card);
      if (!id || !card.cardNumber) continue;
      const previous = db.cards[id] || {};
      db.cards[id] = {
        ...toDatabaseCard(card, id),
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

  db.lastUpdated = new Date().toISOString();
  db.totalCards = Object.keys(db.cards).length;
  fs.writeFileSync(dbPath, `${JSON.stringify(db, null, 2)}\n`, 'utf8');
  console.log(`✓ synced ${upserted} official sourceProduct printings into data/database.json (totalCards=${db.totalCards})`);
}

main();
