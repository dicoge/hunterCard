/**
 * merge-prices.mjs — 將 fix-prices-scraper 的新價格資料合併進 database.json
 * 保留官方資料不變，只更新 yuyu 價格部分
 */
import fs from 'fs';

const DB_PATH = '../data/database.json';
const PRICES_PATH = 'prices_fix.json';

const db = JSON.parse(fs.readFileSync(DB_PATH, 'utf-8'));
const newPrices = JSON.parse(fs.readFileSync(PRICES_PATH, 'utf-8'));

let updatedCount = 0;
let newCardCount = 0;

for (const [key, card] of Object.entries(db.cards)) {
  // Get the base card number
  const cardNum = card.cardNumber || '';
  if (!cardNum) continue;

  const newVariants = newPrices[cardNum];
  if (!newVariants) continue;

  // Format new price entries to match our schema
  const priceEntries = newVariants.map(v => ({
    name: v.name || '',
    sellPrice: v.sellPrice || null,
    rarity: v.rarity || '',
  }));

  // Find lowest price
  let lowestPrice = null;
  let lowestName = '';
  for (const entry of priceEntries) {
    if (entry.sellPrice && (lowestPrice === null || entry.sellPrice < lowestPrice)) {
      lowestPrice = entry.sellPrice;
      lowestName = entry.name || '';
    }
  }

  // Only update if we have MORE variants than before
  const oldCount = (card.prices || []).length;
  if (priceEntries.length > oldCount) {
    card.sellPrice = lowestPrice;
    card.yuyuName = lowestName;
    card.prices = priceEntries;
    updatedCount++;
  } else if (oldCount === 0 && priceEntries.length > 0) {
    // Card had no prices before but now has some
    card.sellPrice = lowestPrice;
    card.yuyuName = lowestName;
    card.prices = priceEntries;
    newCardCount++;
  }
}

// Also try to add new cards that weren't in the database but have prices
// (Only for card numbers that aren't already covered)
for (const [cardNum, variants] of Object.entries(newPrices)) {
  const exists = Object.values(db.cards).some(c => c.cardNumber === cardNum);
  if (exists) continue;

  const priceEntries = variants.map(v => ({
    name: v.name || '',
    sellPrice: v.sellPrice || null,
    rarity: v.rarity || '',
  }));

  let lowestPrice = null;
  let lowestName = '';
  for (const entry of priceEntries) {
    if (entry.sellPrice && (lowestPrice === null || entry.sellPrice < lowestPrice)) {
      lowestPrice = entry.sellPrice;
      lowestName = entry.name || '';
    }
  }

  // Add as yuyu-only card (no official data)
  db.cards[cardNum] = {
    id: cardNum,
    cardNumber: cardNum,
    name: lowestName || '',
    type: '',
    color: '',
    rarity: '',
    series: '',
    sellPrice: lowestPrice,
    yuyuName: lowestName,
    yuyuImage: '',
    prices: priceEntries,
    officialImage: '',
    localImage: '',
    hp: '',
    life: '',
    arts: '',
    timestamp: new Date().toISOString(),
  };
  newCardCount++;
}

// Fix totalCards
db.totalCards = Object.keys(db.cards).length;
db.lastUpdated = new Date().toISOString();

fs.writeFileSync(DB_PATH, `${JSON.stringify(db, null, 2)}\n`, 'utf-8');

console.log('=== MERGE COMPLETE ===');
console.log('Updated cards (more variants):', updatedCount);
console.log('New cards added:', newCardCount);
console.log('Total cards:', db.totalCards);

// Verify hBP04-005
for (const [k, c] of Object.entries(db.cards)) {
  if (k.includes('hBP04-005')) {
    console.log('\nhBP04-005 [' + k + '] prices:');
    (c.prices || []).forEach(p => console.log('  ¥' + (p.sellPrice?.toLocaleString() || 'N/A'), p.rarity ? '['+p.rarity+']' : '', p.name));
  }
}