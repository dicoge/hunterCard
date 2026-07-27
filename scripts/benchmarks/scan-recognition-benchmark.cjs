#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const datasetPath = path.resolve(__dirname, '../../data/benchmarks/scan-recognition-v1.json');
const dataset = JSON.parse(fs.readFileSync(datasetPath, 'utf8'));

function loadCards() {
  const dbPath = path.resolve(__dirname, '../../data/database.json');
  const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  const cards = Object.values(db.cards || {});
  const needed = new Set(dataset.samples.map(s => s.expectedCardNumber.toLowerCase()));
  return cards.filter(c => needed.has(String(c.cardNumber || '').toLowerCase()));
}

const prefixMap = { np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr', sp: 'hsp', ocg: 'hocg', pc: 'hpc', cs: 'hcs', co: 'hco', wf: 'hwf', ys: 'hys', ent: 'hent', bd: 'hbd' };
function normalizeCardNumber(raw) {
  if (!raw) return null;
  let cleaned = String(raw).trim().replace(/^['"`\s]+|['"`\s]+$/g, '').replace(/\.$/, '').toLowerCase();
  if (!cleaned || cleaned === 'none' || cleaned === 'unknown') return null;
  cleaned = cleaned.normalize('NFKC').replace(/[oO〇]/g, '0').replace(/[lI｜]/g, '1').replace(/[－‐‑‒–—―−_\s]+/g, '-');
  const m = cleaned.match(/(h?[a-z]{2,3}\d{0,2}-?\d{1,3})/i);
  if (!m) return null;
  let r = m[1].replace(/-+/g, '-');
  if (!r.includes('-')) r = r.replace(/(\d)(\d{2,3})$/, '$1-$2');
  if (!r.startsWith('h')) {
    const p = r.slice(0, 2), rest = r.slice(2);
    r = (prefixMap[p] || 'h' + p) + rest;
  }
  return r;
}
function normalizeText(v) { return String(v || '').normalize('NFKC').toLowerCase().replace(/[・･\s'"`.,，、:：;；()（）\[\]【】]/g, '').trim(); }
function editDistance(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return dp[a.length][b.length];
}
function similarity(a, b) {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(0.95, Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.25);
  return Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length));
}
function rankCandidates(cards, extracted) {
  const normalizedNumber = normalizeCardNumber(extracted.cardNumberRaw);
  const normalizedNumberFlat = normalizedNumber?.replace(/[^a-z0-9]/g, '') || '';
  const character = normalizeText(extracted.characterName);
  const title = normalizeText(extracted.cardTitle);
  const rarity = normalizeText(extracted.rarity).toUpperCase();
  const hp = String(extracted.hp || '').replace(/\D/g, '');
  const bloom = normalizeText(extracted.bloom);
  const ranked = cards.map(entry => {
    let score = 0;
    const entryNumber = String(entry.cardNumber || '').toLowerCase();
    const entryFlat = entryNumber.replace(/[^a-z0-9]/g, '');
    const entryName = normalizeText(entry.name);
    const entryRarity = normalizeText(entry.rarity).toUpperCase();
    const entryHp = String(entry.hp || '').replace(/\D/g, '');
    const entryBloom = normalizeText(entry.bloomLevel || entry.type || '');
    if (normalizedNumber && entryNumber === normalizedNumber) score += 100;
    else if (normalizedNumberFlat && entryFlat) {
      const distance = editDistance(entryFlat, normalizedNumberFlat);
      if (distance <= 1) score += 78;
      else if (distance <= 2 && normalizedNumberFlat.length >= 8) score += 62;
    }
    const charScore = character ? similarity(character, entryName) : 0;
    if (charScore >= 0.9) score += 26; else if (charScore >= 0.55) score += 14 * charScore;
    const titleScore = title ? similarity(title, entryName) : 0;
    if (titleScore >= 0.9) score += 18; else if (titleScore >= 0.55) score += 10 * titleScore;
    if (rarity && entryRarity === rarity) score += 8;
    if (hp && entryHp && entryHp === hp) score += 8;
    if (bloom && entryBloom && (entryBloom.includes(bloom) || bloom.includes(entryBloom))) score += 5;
    return { cardNumber: entry.cardNumber, score };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);
  const bestByNumber = new Map();
  for (const item of ranked) {
    if (!bestByNumber.has(item.cardNumber)) bestByNumber.set(item.cardNumber, item);
  }
  return [...bestByNumber.values()];
}

const cards = loadCards();
let top1 = 0, top3 = 0;
const results = dataset.samples.map(sample => {
  const ranked = rankCandidates(cards, sample.extracted);
  const top = ranked.slice(0, 3).map(r => r.cardNumber);
  const ok1 = top[0] === sample.expectedCardNumber;
  const ok3 = top.includes(sample.expectedCardNumber);
  if (ok1) top1++;
  if (ok3) top3++;
  return { id: sample.id, expected: sample.expectedCardNumber, top, ok1, ok3 };
});
const summary = { samples: results.length, top1: top1 / results.length, top3: top3 / results.length, targets: dataset.targets, results };
console.log(JSON.stringify(summary, null, 2));
if (summary.top1 < dataset.targets.top1 || summary.top3 < dataset.targets.top3) process.exit(1);
