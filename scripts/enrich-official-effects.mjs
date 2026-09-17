#!/usr/bin/env node
/**
 * scripts/enrich-official-effects.mjs
 *
 * DIC-1468: the missing enrichment stage of the Official Catalog Sync pipeline.
 *
 * The sync workflow discovered brand-new official printings, upserted them into
 * data/database.json, and then failed its own completeness gate, because
 * NOTHING in the pipeline ever acquired skill text for a brand-new cardNumber:
 * data/effects-jp.json only ever grew when a human ran scripts/scrape-effects.js
 * by hand. Six new hBP09 yell printings (hY01-015, hY02-013, hY03-017,
 * hY04-014, hY05-012, hY06-012) therefore landed with neither skillsJp nor
 * skillsZh and tripped verify-official-catalog-completeness.mjs with 12
 * failures on run 35276519463.
 *
 * This step closes the acquisition gap in two passes, both fail-closed:
 *
 *  1. Japanese (source-backed). Every official cardNumber with no
 *     data/effects-jp.json entry is fetched from its own official detail page
 *     and parsed with the SAME audited parser scripts/scrape-effects.js uses.
 *     Nothing is synthesized: if a page cannot be fetched, is too short to be
 *     a real card page, or does not itself declare the cardNumber we asked
 *     for, that card is recorded as a failure and the run exits non-zero so
 *     the pipeline stops before committing anything.
 *
 *     The identity check matters: parseCardPage() takes `cardNumber`/`name`
 *     from the row we hand it and reads only the skills from the HTML, so a
 *     detail id that ever pointed at a different card would silently stamp one
 *     card's rules text onto another's cardNumber. We assert the page's own
 *     "カードナンバー：<span>…</span>" anchor matches first.
 *
 *  2. Traditional Chinese (controlled-map derivation, rules-text-free only).
 *     See scripts/lib/official-effects-enrichment.mjs for why this is not
 *     fabrication and not a translation call: only a card whose Japanese entry
 *     carries NO rules text is eligible, and then every field comes from a
 *     committed controlled map. Cards with rules text stay fail-closed and keep
 *     relying on the reviewed data/official-skills-zh-gap.json pin.
 *
 * Because a derived entry makes a pinned baseline cardNumber "already
 * translated", the baseline is then ratcheted DOWN: entries that now have a
 * real data/effects-zh.json entry are removed and `maxEntries` is lowered to
 * match, exactly as that file's own note requires ("Remove entries here as real
 * translations land in data/effects-zh.json, and lower maxEntries to match").
 * The ratchet is shrink-only by assertion — this script can never add a
 * cardNumber to the baseline nor raise its cap.
 *
 * Usage:
 *   node scripts/enrich-official-effects.mjs                # acquire + derive
 *   node scripts/enrich-official-effects.mjs --derive-only  # no network
 */
import https from 'node:https';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseCardPage } from './scrape-effects.js';
import {
  missingEffectsCardNumbers,
  deriveStructuralZh,
} from './lib/official-effects-enrichment.mjs';

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.join(path.dirname(__filename), '..');

// Same endpoint, pacing, and retry budget as scripts/scrape-effects.js — this
// step is an incremental top-up of that artifact, not a second scraper.
const BASE_URL = 'https://hololive-official-cardgame.com/cardlist/?id=';
const RATE_LIMIT_MS = 150;
const MAX_RETRIES = 3;
const REQUEST_TIMEOUT_MS = 15000;
// A real detail page is tens of KB; anything this small is an error page.
const MIN_PAGE_BYTES = 500;

const OFFICIAL_DIR = path.join(repoRoot, 'data', 'official');
const EFFECTS_JP_PATH = path.join(repoRoot, 'data', 'effects-jp.json');
const EFFECTS_ZH_PATH = path.join(repoRoot, 'data', 'effects-zh.json');
const NAME_ZH_PATH = path.join(repoRoot, 'data', 'character-names-zh.json');
const ZH_GAP_PATH = path.join(repoRoot, 'data', 'official-skills-zh-gap.json');

// The page's own card-number anchor, used to prove the fetched page really is
// the card we asked for before we accept any skill text from it.
const PAGE_CARD_NUMBER_RE = /カードナンバー[：:]\s*<span[^>]*>\s*([A-Za-z0-9-]+)\s*<\/span>/;

/**
 * Does `html` itself declare `cardNumber`? Fail-closed: a page with no
 * recognizable anchor returns false rather than being trusted.
 */
export function cardNumberDeclaredOnPage(html, cardNumber) {
  if (typeof html !== 'string' || typeof cardNumber !== 'string' || !cardNumber) return false;
  const match = html.match(PAGE_CARD_NUMBER_RE);
  if (!match) return false;
  return match[1] === cardNumber;
}

/** Null-prototype JSON map load (DIC-1417), `{}`-shaped default when absent. */
export function loadJsonMap(file) {
  if (!fs.existsSync(file)) return Object.create(null);
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return Object.create(null);
  return Object.assign(Object.create(null), parsed);
}

/** Every official row across data/official/<code>.json, aggregated. */
export function readOfficialRows(officialDirectory = OFFICIAL_DIR) {
  const files = fs.readdirSync(officialDirectory).filter((f) => (
    f.endsWith('.json') && !f.startsWith('_') && f !== 'all-cards.json' && f !== 'all-new-cards.json'
  ));
  const rows = [];
  for (const file of files.sort()) {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(path.join(officialDirectory, file), 'utf8'));
    } catch (err) {
      throw new Error(`data/official/${file} is unreadable: ${err.message}`);
    }
    if (Array.isArray(parsed)) rows.push(...parsed);
  }
  return rows;
}

/**
 * Derive every eligible Traditional-Chinese entry missing from `effectsZh`.
 * Pure: returns the additions rather than mutating either map.
 */
export function deriveMissingZh(effectsJp, effectsZh, nameZhMap) {
  const additions = Object.create(null);
  const skipped = [];
  for (const cardNumber of Object.keys(effectsJp).sort()) {
    if (Object.hasOwn(effectsZh, cardNumber)) continue;
    const derived = deriveStructuralZh(effectsJp[cardNumber], nameZhMap);
    if (derived) additions[cardNumber] = derived;
    else skipped.push(cardNumber);
  }
  return { additions, skipped };
}

/**
 * Ratchet the pinned skillsZh gap baseline DOWN: drop every cardNumber that now
 * has a real data/effects-zh.json entry and lower `maxEntries` to match.
 * Shrink-only by assertion — never adds an entry, never raises the cap.
 */
export function shrinkZhGapBaseline(baseline, effectsZh) {
  if (!baseline || typeof baseline !== 'object' || !Array.isArray(baseline.cardNumbers)) {
    throw new Error('data/official-skills-zh-gap.json must be an object with a cardNumbers array');
  }
  if (!Number.isInteger(baseline.maxEntries)) {
    throw new Error('data/official-skills-zh-gap.json must declare an integer maxEntries ratchet');
  }
  const kept = baseline.cardNumbers.filter((cardNumber) => !Object.hasOwn(effectsZh, cardNumber));
  const removed = baseline.cardNumbers.filter((cardNumber) => Object.hasOwn(effectsZh, cardNumber));

  // Shrink-only invariants. These are assertions, not policy knobs: a bug that
  // tried to grow the fail-closed baseline must crash the pipeline instead.
  if (kept.length > baseline.cardNumbers.length) {
    throw new Error('refusing to grow the pinned skillsZh gap baseline');
  }
  const keptSet = new Set(kept);
  for (const cardNumber of keptSet) {
    if (!baseline.cardNumbers.includes(cardNumber)) {
      throw new Error(`refusing to add ${cardNumber} to the pinned skillsZh gap baseline`);
    }
  }
  const maxEntries = kept.length;
  if (maxEntries > baseline.maxEntries) {
    throw new Error('refusing to raise the pinned skillsZh gap baseline maxEntries ratchet');
  }
  return { baseline: { ...baseline, maxEntries, cardNumbers: kept }, removed };
}

// --- IO helpers -------------------------------------------------------

// data/effects-*.json are written with sorted keys and NO trailing newline,
// matching scripts/scrape-effects.js writeOutput() byte for byte so an
// enrichment run produces a minimal diff.
function writeEffectsFile(file, map) {
  const sorted = {};
  for (const key of Object.keys(map).sort()) sorted[key] = map[key];
  fs.writeFileSync(file, JSON.stringify(sorted, null, 2), 'utf8');
}

function fetchUrl(url, retries = MAX_RETRIES) {
  return new Promise((resolve, reject) => {
    const requester = url.startsWith('https') ? https : http;
    const req = requester.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; hunterCard/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      timeout: REQUEST_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode === 200) resolve(data);
        else if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve, reject), 500);
        else reject(new Error(`HTTP ${res.statusCode}`));
      });
    });
    req.on('timeout', () => {
      req.destroy();
      if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve, reject), 500);
      else reject(new Error('timeout'));
    });
    req.on('error', (err) => {
      if (retries > 0) setTimeout(() => fetchUrl(url, retries - 1).then(resolve, reject), 500);
      else reject(err);
    });
  });
}

async function main() {
  const deriveOnly = process.argv.includes('--derive-only');
  console.log('=== official catalog effects enrichment (DIC-1468) ===');

  const effectsJp = loadJsonMap(EFFECTS_JP_PATH);
  const effectsZh = loadJsonMap(EFFECTS_ZH_PATH);
  const nameZhMap = loadJsonMap(NAME_ZH_PATH);
  const officialRows = readOfficialRows();

  // --- Pass 1: source-backed Japanese acquisition ---------------------
  const todo = missingEffectsCardNumbers(officialRows, effectsJp);
  const failures = [];
  let acquired = 0;

  if (!todo.length) {
    console.log('[jp] every official cardNumber already has a data/effects-jp.json entry');
  } else if (deriveOnly) {
    console.log(`[jp] --derive-only: skipping network acquisition of ${todo.length} cardNumber(s)`);
  } else {
    console.log(`[jp] acquiring ${todo.length} missing cardNumber(s) from the official cardlist`);
    for (let i = 0; i < todo.length; i++) {
      const card = todo[i];
      const url = `${BASE_URL}${card.id}`;
      process.stdout.write(`  [${i + 1}/${todo.length}] ${card.cardNumber} ${card.name} ... `);
      try {
        const html = await fetchUrl(url);
        if (!html || html.length < MIN_PAGE_BYTES) {
          process.stdout.write('FAIL (empty page)\n');
          failures.push(`${card.cardNumber}: detail page ${url} returned ${html ? html.length : 0} bytes`);
        } else if (!cardNumberDeclaredOnPage(html, card.cardNumber)) {
          // Cross-printing guard: never accept skills from a page that does
          // not declare the cardNumber we asked for.
          process.stdout.write('FAIL (card-number mismatch)\n');
          failures.push(`${card.cardNumber}: detail page ${url} does not declare cardNumber ${card.cardNumber}`);
        } else {
          const parsed = parseCardPage(html, card);
          if (parsed.cardNumber !== card.cardNumber) {
            process.stdout.write('FAIL (parsed identity drift)\n');
            failures.push(`${card.cardNumber}: parsed entry claims ${parsed.cardNumber}`);
          } else {
            effectsJp[card.cardNumber] = parsed;
            acquired++;
            process.stdout.write('OK\n');
          }
        }
      } catch (err) {
        process.stdout.write(`FAIL (${err.message})\n`);
        failures.push(`${card.cardNumber}: ${err.message}`);
      }
      if (i < todo.length - 1) await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    }
    if (acquired) writeEffectsFile(EFFECTS_JP_PATH, effectsJp);
  }

  // --- Pass 2: controlled-map Traditional-Chinese derivation ----------
  const { additions, skipped } = deriveMissingZh(effectsJp, effectsZh, nameZhMap);
  const derivedNumbers = Object.keys(additions);
  if (derivedNumbers.length) {
    for (const cardNumber of derivedNumbers) effectsZh[cardNumber] = additions[cardNumber];
    writeEffectsFile(EFFECTS_ZH_PATH, effectsZh);
    console.log(`[zh] derived ${derivedNumbers.length} rules-text-free entr(ies) from controlled maps: ${derivedNumbers.join(', ')}`);
  } else {
    console.log('[zh] no rules-text-free cardNumber needed derivation');
  }
  console.log(`[zh] ${skipped.length} cardNumber(s) stay fail-closed (rules text present or unresolved controlled term)`);

  // --- Baseline ratchet: shrink only ----------------------------------
  const baselineBefore = JSON.parse(fs.readFileSync(ZH_GAP_PATH, 'utf8'));
  const { baseline: baselineAfter, removed } = shrinkZhGapBaseline(baselineBefore, effectsZh);
  if (removed.length) {
    fs.writeFileSync(ZH_GAP_PATH, `${JSON.stringify(baselineAfter, null, 2)}\n`, 'utf8');
    console.log(`[baseline] ratcheted ${baselineBefore.cardNumbers.length} -> ${baselineAfter.cardNumbers.length} entries (maxEntries ${baselineBefore.maxEntries} -> ${baselineAfter.maxEntries}); removed ${removed.join(', ')}`);
  } else {
    console.log(`[baseline] unchanged at ${baselineBefore.cardNumbers.length}/${baselineBefore.maxEntries} pinned cardNumber(s)`);
  }

  if (failures.length) {
    console.error(`\n✗ ${failures.length} cardNumber(s) could not be enriched from the official source:`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('No skill text is ever invented for these — fix the source or the detail id and re-run.');
    process.exit(1);
  }

  console.log(`\n✓ effects enrichment complete: ${acquired} cardNumber(s) acquired from source, ${derivedNumbers.length} Traditional-Chinese entr(ies) derived`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error('Fatal error:', err); process.exit(1); });
}
