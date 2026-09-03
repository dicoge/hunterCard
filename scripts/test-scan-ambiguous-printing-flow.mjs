#!/usr/bin/env node
/**
 * DIC-1325 re-review regression: an unresolved printing reaches the candidate
 * picker and commits NOTHING.
 *
 * cardRecognition already refuses to pick a printing when only a cardNumber is
 * known, returning success + card + lowConfidence + candidates and no price.
 * But both production consumers committed that result before anything looked at
 * `lowConfidence`: `runNativeCameraScan` tested `success && card` first and went
 * straight to `onVisionRecognized`, and ScanScreen's `handleRecognized`
 * auto-added anything at confidence >= 0.85. Ambiguous hBP01-024 therefore
 * auto-added a null-price placeholder instead of offering its 8 printings.
 *
 * This drives the REAL exported flow functions with the REAL recognition
 * service over the REAL shipped catalog, recording every UI callback. The
 * commit callbacks are `onRecognized` / `onVisionRecognized`; the picker is
 * `showLowConfidenceCandidates`. "Zero commit" is asserted as literally zero
 * calls to the former.
 *
 * ScanScreen's `handleRecognized` is a React closure this harness cannot invoke
 * without booting the camera screen. Its guard is asserted statically, and the
 * classifier it now branches on is asserted behaviourally against the real
 * ambiguous result. Stated, not glossed.
 *
 * Run: node --import ./scripts/register-web-render.mjs \
 *        scripts/test-scan-ambiguous-printing-flow.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

const shippedDb = JSON.parse(read('public/data/database.json'));
// Swappable per case so the gallery section can drive the real recognition
// endpoint into its cardNumber-only response.
let apiResponse = null;
globalThis.fetch = async (url) => {
  if (String(url).includes('/data/database.json')) {
    return { ok: true, status: 200, json: async () => shippedDb };
  }
  if (apiResponse) return { ok: true, status: 200, json: async () => apiResponse };
  return { ok: false, status: 500, json: async () => ({ success: false }) };
};

const { recognizeCardFromOcr, recognizeCardFromImage, loadAllCards } =
  await import('../src/services/cardRecognition.ts');
const { runNativeCameraScan, runWebCameraScan, isAmbiguousPrinting } =
  await import('../src/services/scanRecognitionFlow.ts');

let passed = 0;
function check(label, cond, detail) {
  if (cond) { passed += 1; console.log(`  ✓ ${label}`); }
  else { console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`); process.exitCode = 1; }
}

const AMBIGUOUS = 'hBP01-024';
const rows = Object.values(shippedDb.cards).filter((c) => c.cardNumber === AMBIGUOUS);
const uniqueRow = Object.values(shippedDb.cards).find((c) => {
  const sib = Object.values(shippedDb.cards).filter((o) => o.cardNumber === c.cardNumber);
  return sib.length === 1 && typeof c.sellPrice === 'number' && c.sellPrice > 0;
});

/** Records every UI callback so "committed" is an observed fact, not an inference. */
function recordingUi() {
  const calls = [];
  const rec = (name) => (...args) => calls.push({ name, args });
  return {
    calls,
    committed: () => calls.filter((c) => c.name === 'onRecognized' || c.name === 'onVisionRecognized'),
    pickerShown: () => calls.filter((c) => c.name === 'showLowConfidenceCandidates'),
    setStatus: rec('setStatus'),
    setBusy: rec('setBusy'),
    setScanError: rec('setScanError'),
    setSearchError: rec('setSearchError'),
    setSearchResults: rec('setSearchResults'),
    setSuggestions: rec('setSuggestions'),
    setRecognizedText: rec('setRecognizedText'),
    setCandidateReason: rec('setCandidateReason'),
    showLowConfidenceCandidates: rec('showLowConfidenceCandidates'),
    onRecognized: rec('onRecognized'),
    onVisionRecognized: rec('onVisionRecognized'),
  };
}

/**
 * Real recognition service, wired so the flow reaches its OCR-text leg: the
 * vision API is unavailable (the shape a native device hits when the backend is
 * down), OCR reads the card number off the card, and recognizeFromOcr is the
 * genuine exported implementation reading the shipped catalog.
 */
function ioFor(cardNumber) {
  return {
    callRecognitionApi: async () => { throw new Error('backend down'); },
    recognizeFromImage: async () => ({ success: false, error: '' }),
    ocrText: async () => cardNumber,
    recognizeFromOcr: (text) => recognizeCardFromOcr(text),
    searchCards: async () => [],
    mapApiCard: (c) => c,
    mapApiCandidates: () => undefined,
  };
}

// ── 0. Fixture integrity ────────────────────────────────────────────────────
check(`${AMBIGUOUS} still has multiple printings`, rows.length > 1, `got ${rows.length}`);
check('found a single-printing control with a price', !!uniqueRow);
{
  const r = await recognizeCardFromOcr(AMBIGUOUS);
  check('the service still classifies it as an unresolved printing', isAmbiguousPrinting(r) === true);
  check('and that result still carries no price', r.card?.sellPrice == null, `got ${r.card?.sellPrice}`);
  check('and still carries a confidence that WOULD have auto-added it',
    (r.confidence ?? 0) >= 0.85,
    `confidence=${r.confidence} — if this drops below 0.85 the regression stops reproducing`);
}

// ── 1. Native flow: picker, zero commit ─────────────────────────────────────
{
  const ui = recordingUi();
  await runNativeCameraScan('img://x', ioFor(AMBIGUOUS), ui);
  check('native: commits NOTHING for an unresolved printing',
    ui.committed().length === 0,
    `committed ${JSON.stringify(ui.committed().map((c) => c.name))}`);
  check('native: shows the candidate picker', ui.pickerShown().length === 1);
  const cands = ui.pickerShown()[0]?.args[0] ?? [];
  check('native: picker offers every printing', cands.length === rows.length, `got ${cands.length}`);
  check('native: candidates keep distinct compound printing ids',
    new Set(cands.map((c) => c.card.id)).size === cands.length,
    `ids=${JSON.stringify(cands.map((c) => c.card.id))}`);
  check('native: candidates carry their own individual prices',
    cands.some((c) => c.card.sellPrice === 50) && cands.some((c) => c.card.sellPrice === 120),
    `prices=${JSON.stringify(cands.map((c) => c.card.sellPrice))}`);
  check('native: stops the busy spinner so the picker is usable',
    ui.calls.some((c) => c.name === 'setBusy' && c.args[0] === false));
}

// ── 2. Web flow: same guarantee ─────────────────────────────────────────────
{
  const ui = recordingUi();
  await runWebCameraScan('img://x', ioFor(AMBIGUOUS), ui);
  check('web: commits NOTHING for an unresolved printing',
    ui.committed().length === 0,
    `committed ${JSON.stringify(ui.committed().map((c) => c.name))}`);
  check('web: shows the candidate picker', ui.pickerShown().length === 1);
  check('web: picker offers every printing',
    (ui.pickerShown()[0]?.args[0] ?? []).length === rows.length);
}

// ── 3. Control: a resolved printing still auto-recognises normally ──────────
// Without this the fix could be "never commit anything", which would satisfy
// every assertion above while breaking the product.
{
  const ui = recordingUi();
  await runNativeCameraScan('img://x', ioFor(uniqueRow.cardNumber), ui);
  const committed = ui.committed();
  check(`control ${uniqueRow.cardNumber}: still commits normally`, committed.length === 1,
    `committed ${committed.length}`);
  check('control: commits the card with its own price',
    committed[0]?.args[0]?.sellPrice === uniqueRow.sellPrice,
    `got ${committed[0]?.args[0]?.sellPrice}, own ${uniqueRow.sellPrice}`);
  check('control: does NOT divert to the candidate picker', ui.pickerShown().length === 0);
}

// ── 3b. Gallery path: the branch that bypassed every guard ──────────────────
// pickFromGallery ran `galleryVisionResult.success && card` -> commitCard ahead
// of its own lowConfidence check, so it auto-added the placeholder even after
// the camera flows were fixed. It now routes through handleRecognized.
//
// The branch lives in a React closure this harness cannot invoke, so it is
// covered in two executable-plus-structural halves: the real
// recognizeCardFromImage call that feeds it, and an invariant over every
// commitCard site in the screen.
{
  apiResponse = { success: true, cardNumber: AMBIGUOUS };
  const galleryVisionResult = await recognizeCardFromImage('data:image/png;base64,iVBORw0KGgo=');
  apiResponse = null;

  check('gallery: recognizeCardFromImage really returns the ambiguous result',
    galleryVisionResult.success === true && !!galleryVisionResult.card);
  check('gallery: that result is classified as an unresolved printing',
    isAmbiguousPrinting(galleryVisionResult) === true);
  check('gallery: the placeholder it would have committed carries no price',
    galleryVisionResult.card?.sellPrice == null, `got ${galleryVisionResult.card?.sellPrice}`);
  check('gallery: it offers every compound printing id as a candidate',
    (galleryVisionResult.candidates?.length ?? 0) === rows.length
      && new Set(galleryVisionResult.candidates.map((c) => c.card.id)).size === rows.length,
    `got ${galleryVisionResult.candidates?.length}`);
  check('gallery: its confidence WOULD have satisfied the old success branch',
    galleryVisionResult.success === true,
    'if this stops being success-shaped the bypass no longer reproduces');

  const screen = read('src/screens/ScanScreen.tsx');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const branch = code.slice(code.indexOf('galleryVisionResult.success'), code.indexOf('galleryVisionResult.lowConfidence'));
  check('gallery: the success branch no longer calls commitCard directly',
    !branch.includes('commitCard('), branch.trim().slice(0, 160));
  check('gallery: the success branch routes through handleRecognized',
    /handleRecognized\(/.test(branch));
  check('gallery: and classifies the result on the way',
    /isAmbiguousPrinting\(galleryVisionResult\)/.test(branch));
}

// ── 3c. Class invariant: no unclassified commit site can be added back ──────
// Three separate bypasses of the same shape have now been reported. Rather than
// pin a fourth instance, pin the rule: a card may only be committed from the
// single decision point, or from a handler where the USER already chose.
{
  const screen = read('src/screens/ScanScreen.tsx');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const lines = code.split('\n');
  const commitLines = lines
    .map((l, i) => ({ l, i }))
    .filter(({ l }) => /commitCard\(/.test(l) && !/const commitCard/.test(l));

  // Which enclosing function each commit belongs to, by scanning upward for the
  // nearest declaration.
  const owners = commitLines.map(({ i }) => {
    for (let j = i; j >= 0; j--) {
      const m = lines[j].match(/(?:const|function)\s+([A-Za-z0-9_]+)\s*[=(]/);
      if (m) return m[1];
      if (/onVisionRecognized:/.test(lines[j])) return 'onVisionRecognized';
    }
    return '<unknown>';
  });

  // handleRecognized  — the single decision point, guarded above the auto-add.
  // handleConfirmCandidate / handleSelectSuggestion — the user already picked.
  // onVisionRecognized — flow adapter; the flow classifies before calling it.
  const ALLOWED = new Set([
    'handleRecognized',
    'handleConfirmCandidate',
    'handleSelectSuggestion',
    'onVisionRecognized',
  ]);
  const rogue = owners.filter((o) => !ALLOWED.has(o));
  check(
    `every commitCard site sits in a decision point or an explicit user choice (${owners.length} sites)`,
    rogue.length === 0,
    `unaccounted: ${JSON.stringify(rogue)} — a new commit path must go through handleRecognized`,
  );
  console.log(`  … commitCard owners: ${JSON.stringify(owners)}`);
}

// ── 4. The SEC protection reviewed earlier is still in force ────────────────
{
  const src = read('api/recognize-card.ts');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('SEC Math.max rewrite has not crept back into the API',
    !/rarity\s*===\s*'SEC'[\s\S]{0,200}Math\.max/.test(code));
  const sec = shippedDb.cards['hBP03-003_ent07'];
  check('hBP03-003 still canonically JPY 1,280 with a JPY 128,000 sibling',
    sec?.sellPrice === 1280 && sec.prices.some((p) => p.sellPrice === 128000));
}

// ── 5. ScanScreen's guard — asserted statically, see the header note ────────
{
  const screen = read('src/screens/ScanScreen.tsx');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('handleRecognized takes an ambiguousPrinting flag', /ambiguousPrinting = false,/.test(code));
  check('and returns to the picker BEFORE the auto-add threshold',
    code.indexOf('if (ambiguousPrinting)') !== -1
      && code.indexOf('if (ambiguousPrinting)') < code.indexOf('confidence >= CONFIDENCE_AUTO_ADD'),
    'the ambiguity branch must precede the auto-add branch');
  const directCalls = code.match(/handleRecognized\([^)]*\)/g) ?? [];
  const flowCalls = directCalls.filter((c) => c.includes('Result.card'));
  check('every direct handleRecognized call classifies its result',
    flowCalls.length > 0 && flowCalls.every((c) => c.includes('isAmbiguousPrinting(')),
    `unclassified: ${JSON.stringify(flowCalls.filter((c) => !c.includes('isAmbiguousPrinting(')))}`);
}

// ── 6. Discrimination: the old ordering really would have committed ─────────
{
  const r = await recognizeCardFromOcr(AMBIGUOUS);
  // Replay the removed ordering: success && card wins before lowConfidence.
  const wouldCommit = r.success === true && !!r.card;
  check('the removed ordering would have committed this result',
    wouldCommit === true,
    'if this goes false the fixture no longer reproduces the defect');
  check('and the committed card would have had no price (the reported placeholder)',
    r.card?.sellPrice == null);
}

// ── 7. CI runs this ────────────────────────────────────────────────────────
check('CI executes the ambiguous-printing flow regression',
  read('.github/workflows/ci.yml').includes('test:scan-ambiguous-printing-flow'));
check('package.json defines test:scan-ambiguous-printing-flow',
  !!JSON.parse(read('package.json')).scripts['test:scan-ambiguous-printing-flow']);

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Ambiguous-printing scan flow regression: ${passed} checks passed`);
} else {
  console.error('\n❌ Ambiguous-printing scan flow regression failed');
}
