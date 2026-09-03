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
const { runNativeCameraScan, runWebCameraScan, isAmbiguousPrinting, decideRecognizedOutcome } =
  await import('../src/services/scanRecognitionFlow.ts');
// Real handler ranker — used to build a FAITHFUL low-confidence payload for
// the gallery regression instead of the impossible `{success:true,cardNumber:X}`
// shape the previous fixture used (DIC-1339 CR).
const { rankCandidates } = await import('../api/recognize-card.ts');

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

// ── 3b. Gallery low-confidence path (DIC-1339 CR) ──────────────────────────
// Mac-Codex rejected `38b008547` because the previous fixture posted a shape
// the handler NEVER returns: `{success:true, cardNumber:X}`. The real
// low-confidence response is `{success:false, lowConfidence:true, candidates:[...]}`,
// and the client used to degrade its `candidates` to `suggestions: CardInfo[]`,
// stripping the per-candidate confidence AND leaving the gallery decision path
// with nothing to hand the exact-printing picker. This section drives the REAL
// ranker → REAL recognizeCardFromImage → REAL decideRecognizedOutcome so a
// regression on any of those three legs shows up here.
{
  // 1. FAITHFUL handler payload. rankCandidates is the exact function
  //    `handler` calls; feeding it evidence that names only `hBP01-024`
  //    reproduces the "many printings, low confidence" case the CR flagged.
  const ranking = rankCandidates(shippedDb.cards, { cardNumberRaw: AMBIGUOUS });
  check('fixture: real ranker really produces low confidence for hBP01-024 alone',
    ranking.confidence < 0.82,
    `confidence=${ranking.confidence} — AUTO_ACCEPT is 0.82; if this crosses it the fixture no longer represents the low-confidence branch`);
  check('fixture: ranker returns at least two candidates so the picker is the right UX',
    ranking.candidates.length >= 2, `got ${ranking.candidates.length}`);
  check('fixture: every ranked candidate carries its compound printing id on the wire',
    ranking.candidates.every((c) => typeof c.id === 'string' && c.id.length > String(AMBIGUOUS).length
      && c.id.startsWith(AMBIGUOUS)),
    `ids=${JSON.stringify(ranking.candidates.map((c) => c.id))} — fmt() must serialize entry.id, not collapse to cardNumber`);
  check('fixture: those compound ids really are distinct across candidates',
    new Set(ranking.candidates.map((c) => c.id)).size === ranking.candidates.length,
    `ids=${JSON.stringify(ranking.candidates.map((c) => c.id))}`);

  // 2. REAL low-confidence wire response, exactly what the handler ships.
  apiResponse = {
    success: false,
    lowConfidence: true,
    error: '辨識信心不足，請從候選卡中選擇',
    candidates: ranking.candidates,
    confidence: ranking.confidence,
    reason: ranking.reason,
    raw: 'CARD_NUMBER: hBP01-024',
  };
  const galleryResult = await recognizeCardFromImage('data:image/png;base64,iVBORw0KGgo=');
  apiResponse = null;

  check('client: preserves success=false, lowConfidence=true for the real handler payload',
    galleryResult.success === false && galleryResult.lowConfidence === true,
    `got success=${galleryResult.success}, lowConfidence=${galleryResult.lowConfidence}`);
  check('client: retains TYPED candidates (RecognizedCandidate[]) — not only CardInfo[] suggestions',
    Array.isArray(galleryResult.candidates)
      && galleryResult.candidates.length === ranking.candidates.length
      && galleryResult.candidates.every((c) => c && typeof c === 'object' && !!c.card
        && typeof c.confidence === 'number'),
    `got ${JSON.stringify(galleryResult.candidates?.map((c) => ({hasCard: !!c?.card, conf: typeof c?.confidence})))}`);
  check('client: each candidate.card carries a distinct compound printing id (id !== cardNumber)',
    new Set(galleryResult.candidates.map((c) => c.card.id)).size === galleryResult.candidates.length
      && galleryResult.candidates.every((c) => c.card.id !== AMBIGUOUS),
    `ids=${JSON.stringify(galleryResult.candidates?.map((c) => c.card.id))} — if any id collapses to the bare cardNumber the apiCardMapper regressed`);
  check('client: candidates carry their own individual prices (the sibling-price protection)',
    galleryResult.candidates.some((c) => c.card.sellPrice === 50)
      && galleryResult.candidates.some((c) => c.card.sellPrice === 120),
    `prices=${JSON.stringify(galleryResult.candidates?.map((c) => c.card.sellPrice))}`);

  // 3. Gallery DECISION. Route through the SAME classifier ScanScreen calls
  //    (isAmbiguousPrinting + decideRecognizedOutcome). This is the tested
  //    part of handleRecognized; ScanScreen's wrapper adds only setState.
  const first = galleryResult.candidates[0];
  const decision = decideRecognizedOutcome(
    first.card,
    galleryResult.confidence ?? first.confidence,
    galleryResult.candidates,
    isAmbiguousPrinting(galleryResult),
  );
  check('gallery decision: NOT commit — never commit a low-confidence gallery result',
    decision.action !== 'commit',
    `got ${decision.action}${decision.action === 'commit' ? ` (committed ${decision.card?.id})` : ''}`);
  check('gallery decision: opens the exact-printing picker',
    decision.action === 'picker' || decision.action === 'ambiguous-picker',
    `got ${decision.action}`);
  check('gallery decision: picker candidates preserve distinct compound ids (up to 5)',
    new Set(decision.candidates.map((c) => c.card.id)).size === decision.candidates.length
      && decision.candidates.length <= 5,
    `ids=${JSON.stringify(decision.candidates.map((c) => c.card.id))}`);

  // 4. POST-selection commit: exactly one, with the exact compound id the
  //    user picked. Simulates handleConfirmCandidate + commitCard (the React
  //    closure the harness cannot invoke).
  const picked = decision.candidates[0].card;
  const commits = [];
  const commit = (card) => { commits.push(card); return true; };
  commit(picked);
  check('post-selection: exactly one commit fires',
    commits.length === 1, `commits=${commits.length}`);
  check('post-selection: commit carries the exact compound printing id the user picked',
    commits[0].id === picked.id && picked.id.startsWith(AMBIGUOUS) && picked.id !== AMBIGUOUS,
    `committed id=${commits[0].id}, picked id=${picked.id}`);

  // 5. Structural: the gallery code path still wires through handleRecognized
  //    with isAmbiguousPrinting classification (a React closure the harness
  //    cannot invoke).
  const screen = read('src/screens/ScanScreen.tsx');
  const code = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const successIdx = code.indexOf('galleryVisionResult.success');
  const lowConfIdx = code.indexOf('galleryVisionResult.lowConfidence');
  const successBranch = code.slice(successIdx, lowConfIdx);
  check('gallery success branch: no direct commitCard call (DIC-1325)',
    !successBranch.includes('commitCard('), successBranch.trim().slice(0, 160));
  check('gallery success branch: routes through handleRecognized',
    /handleRecognized\(/.test(successBranch));
  check('gallery success branch: classifies the result on the way',
    /isAmbiguousPrinting\(galleryVisionResult\)/.test(successBranch));

  // The lowConfidence branch is the one the CR ordered fixed — assert it
  // routes through handleRecognized with the classifier too, not into a raw
  // setSearchResults() write ahead of the safe decision point (DIC-1339).
  const rest = code.slice(lowConfIdx);
  const lowConfBranchEnd = rest.indexOf('const noTextError');
  const lowConfBranch = lowConfBranchEnd > -1 ? rest.slice(0, lowConfBranchEnd) : rest.slice(0, 2000);
  check('gallery lowConfidence branch: routes through handleRecognized when candidates exist (DIC-1339)',
    /handleRecognized\(/.test(lowConfBranch),
    `branch=${lowConfBranch.slice(0, 240)}`);
  check('gallery lowConfidence branch: classifies the result with isAmbiguousPrinting',
    /isAmbiguousPrinting\(galleryVisionResult\)/.test(lowConfBranch));
  check('gallery lowConfidence branch: no direct commitCard call',
    !lowConfBranch.includes('commitCard('));
}

// ── 3b². Mutation guards for the faithful gallery fixture ──────────────────
// Explicit assertions that a regression on any of the three fix legs would
// really flip the checks above (not silently keep them green).
{
  // Mutation: id collapsed back to cardNumber at the client boundary — the
  // very defect Mac-Codex reported. Distinct compound ids must fail.
  const collapsed = [
    { card: { id: 'hBP01-024', cardNumber: 'hBP01-024', sellPrice: 120 }, confidence: 0.4 },
    { card: { id: 'hBP01-024', cardNumber: 'hBP01-024', sellPrice: 50 }, confidence: 0.35 },
  ];
  check('mutation: collapsed ids fail the "distinct compound ids" check',
    new Set(collapsed.map((c) => c.card.id)).size !== collapsed.length);

  // Mutation: candidates degraded to CardInfo[] — the shape the old
  // recognizeViaApi produced. The "typed candidates" check must reject it.
  const degraded = [
    { id: 'hBP01-024_hBP01_C_hBP01-024_C', cardNumber: 'hBP01-024', sellPrice: 120 },
    { id: 'hBP01-024_ent07_HR_hBP01-024_HR', cardNumber: 'hBP01-024', sellPrice: 50 },
  ];
  check('mutation: CardInfo[]-shaped candidates fail the RecognizedCandidate typing check',
    !degraded.every((c) => c && !!c.card && typeof c.confidence === 'number'));

  // Mutation: the removed "commit at low confidence" rule flips the decision
  // to `commit`. decideRecognizedOutcome must NOT return commit for
  // confidence < AUTO_ADD.
  const mutantDecision = decideRecognizedOutcome(
    { id: 'x', cardNumber: 'x' },
    0.4, // well below AUTO_ADD (0.85)
    [{ card: { id: 'x_a', cardNumber: 'x' }, confidence: 0.4 }, { card: { id: 'x_b', cardNumber: 'x' }, confidence: 0.35 }],
    false,
  );
  check('mutation: decideRecognizedOutcome does not commit below AUTO_ADD even without ambiguous',
    mutantDecision.action === 'picker',
    `got ${mutantDecision.action}`);

  // Mutation: passing `ambiguousPrinting=true` at HIGH confidence must still
  // route to picker — auto-add can never overrule an unresolved printing.
  const ambiguousHigh = decideRecognizedOutcome(
    { id: 'x', cardNumber: 'x' },
    0.95,
    [{ card: { id: 'x_a', cardNumber: 'x' }, confidence: 0.95 }, { card: { id: 'x_b', cardNumber: 'x' }, confidence: 0.9 }],
    true,
  );
  check('mutation: ambiguousPrinting forces the picker even at high confidence',
    ambiguousHigh.action === 'ambiguous-picker', `got ${ambiguousHigh.action}`);
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
  // nearest declaration. Match FUNCTION-shaped declarations only — `function X(`
  // or `const X = (` / `const X = async (` — so a local `const decision = ...`
  // one line above a commit does not pass for its owner (DIC-1339 refactor:
  // handleRecognized now assigns a decision object right above the commit).
  const owners = commitLines.map(({ i }) => {
    for (let j = i; j >= 0; j--) {
      const m = lines[j].match(/(?:function\s+([A-Za-z0-9_]+)\s*\(|const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\()/);
      if (m) return m[1] || m[2];
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

// ── 5. Ordering invariant — the ambiguity branch precedes auto-add ─────────
// The rule that makes the picker safe: an unresolved printing must not commit
// at ANY confidence. Enforced in decideRecognizedOutcome (the pure classifier
// ScanScreen and the flow harness both call), so pin the invariant there.
{
  const flow = read('src/services/scanRecognitionFlow.ts');
  const code = flow.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('decideRecognizedOutcome exists in scanRecognitionFlow',
    /export function decideRecognizedOutcome\(/.test(code));
  check('decideRecognizedOutcome takes an ambiguousPrinting flag',
    /ambiguousPrinting:\s*boolean/.test(code));
  const ambIdx = code.indexOf('if (ambiguousPrinting)');
  const autoIdx = code.indexOf('confidence >= thresholds.autoAdd');
  check('and returns to the picker BEFORE the auto-add threshold',
    ambIdx !== -1 && autoIdx !== -1 && ambIdx < autoIdx,
    `ambiguousPrinting@${ambIdx}, autoAdd@${autoIdx} — the ambiguity branch must precede the auto-add branch`);

  const screen = read('src/screens/ScanScreen.tsx');
  const screenCode = screen.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  check('handleRecognized takes an ambiguousPrinting flag',
    /ambiguousPrinting = false,/.test(screenCode));
  check('handleRecognized routes through decideRecognizedOutcome (one classifier)',
    /decideRecognizedOutcome\(/.test(screenCode),
    'ScanScreen must delegate to the shared pure classifier so a Node harness covers the same rules');
  const directCalls = screenCode.match(/handleRecognized\([^)]*\)/g) ?? [];
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
