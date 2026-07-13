// scripts/backfill-price-history.js
//
// Backfill price-history from git history.
//
// data/database.json has a "chore: update database YYYY-MM-DD" commit for
// every day since 2026-06-16 (new key format: `cardNumber_variant`). Each of
// those snapshots carries the day's crawled `sellPrice`. This script mines the
// snapshots that price-history does not yet have and appends them, so the
// historical trend starts from mid-June instead of 2026-07-02.
//
// Idempotent: a date already present in a card's records is never rewritten.
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// ─── Price History Sanitizer (DIC-412 / DIC-414) ───

function medianOf(arr) {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function sanitizePriceHistory(existingRecords, candidatePrice) {
  const SPIKE_FACTOR = 5;
  const ABSOLUTE_CAP = 50000;

  if (!Number.isFinite(candidatePrice) || candidatePrice <= 0) return null;

  if (!existingRecords || existingRecords.length === 0) {
    if (candidatePrice > ABSOLUTE_CAP) {
      console.warn(`  [sanitize] Price ${candidatePrice} > absolute cap ${ABSOLUTE_CAP} — no history, capping`);
      return ABSOLUTE_CAP;
    }
    return candidatePrice;
  }

  const oldPrices = existingRecords
    .map(r => r.price)
    .filter(p => Number.isFinite(p) && p > 0);

  if (oldPrices.length === 0) return candidatePrice;

  const sorted = [...oldPrices].sort((a, b) => a - b);

  let referencePrices;
  if (oldPrices.length < 3) {
    referencePrices = sorted;
  } else {
    const halfLen = Math.ceil(sorted.length / 2);
    referencePrices = sorted.slice(sorted.length - halfLen);
  }

  // baseline is derived only from existingRecords, never candidatePrice, so a
  // spike can't inflate its own reference and slip through.
  const baseline = medianOf(referencePrices);

  if (candidatePrice > baseline * SPIKE_FACTOR || candidatePrice > ABSOLUTE_CAP) {
    console.warn(
      `  [sanitize] Spike rejected: candidate=${candidatePrice} ` +
      `(baseline=${baseline}, records=${oldPrices.length}) — dropping record`
    );
    return null;
  }

  return candidatePrice;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = path.resolve(__dirname, "..");
const HIST_DIR = path.join(PROJECT_DIR, "data", "price-history");

// 1. All dated "update database" commits (newest first from git log).
const logOutput = execSync("git log --format='%H %s' -- data/database.json", {
  cwd: PROJECT_DIR,
  encoding: "utf-8",
});
const commits = logOutput
  .trim()
  .split("\n")
  .map((line) => {
    const m = line.match(
      /^([a-f0-9]+) chore: update database (\d{4}-\d{2}-\d{2})$/
    );
    if (!m) return null;
    return { sha: m[1], date: m[2] };
  })
  .filter(Boolean);

// 2. For each dated snapshot, read that commit's database.json and append.
//    Dedup is per-card (see `existing.records.some(...)` below), so a run that
//    only partially filled a date can be safely re-run to backfill the rest.
let totalAdded = 0;
for (const { sha, date } of commits) {
  const raw = execSync(`git show ${sha}:data/database.json`, {
    cwd: PROJECT_DIR,
    encoding: "utf-8",
    maxBuffer: 100 * 1024 * 1024,
  });
  const db = JSON.parse(raw);
  if (!db.cards) continue;

  const keys = Object.keys(db.cards);
  // New format uses composite keys (`cardNumber_variant`) which contain "_".
  // Old format keys are bare card numbers (no "_") and must be skipped.
  if (!keys.some((k) => k.includes("_"))) {
    console.log(`skip ${date} (old format)`);
    continue;
  }

  let added = 0;
  for (const [cardId, card] of Object.entries(db.cards)) {
    if (!card.sellPrice || card.sellPrice <= 0) continue;

    const safeId = cardId.replace(/[^a-zA-Z0-9_-]/g, "_");
    const filePath = path.join(HIST_DIR, `${safeId}.json`);

    let existing = {
      cardId,
      cardNumber: card.cardNumber || "",
      name: card.name || "",
      records: [],
      lastUpdated: "",
      nameZh: card.nameZh || "",
    };
    try {
      existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    } catch {}

    if (existing.records.some((r) => r.date === date)) continue;

    const sanitized = sanitizePriceHistory(existing.records, card.sellPrice);
    if (sanitized === null || sanitized <= 0) continue;

    existing.records.push({
      date,
      price: sanitized,
      source: "yuyu-tei",
      currency: "JPY",
      cardId,
    });
    existing.records.sort((a, b) => a.date.localeCompare(b.date));
    existing.lastUpdated = new Date().toISOString();
    fs.writeFileSync(filePath, JSON.stringify(existing, null, 2));
    added++;
  }
  console.log(`${date}: added ${added} records`);
  totalAdded += added;
}

console.log("Total added:", totalAdded);
