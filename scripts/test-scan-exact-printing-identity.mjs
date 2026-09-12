#!/usr/bin/env node
/**
 * DIC-1325 re-review regression: the client scan recovery path never presents a
 * sibling printing's price as the scanned card's exact price.
 *
 * `loadAllCards()` set `CardInfo.id = cardNumber`, discarding the compound
 * catalog key that IS the printing's identity. `hBP01-024` has 8 rows, so all 8
 * collapsed to one `id` and every recovery lookup — `find(c => c.id === n)` —
 * returned whichever row the catalog listed first. A cardNumber-only OCR read of
 * hBP01-024 returned the ent07/HR row at JPY 50 with confidence 0.9, while the
 * same number also has hBP01/C at JPY 120 and hPR/P with no proven price.
 *
 * A cardNumber is not an identity. With no printing evidence there is no basis
 * for choosing, so the paths now return the card WITHOUT a price plus the
 * printings as candidates for the user to resolve.
 *
 * Coverage, and what is honestly executed:
 *   • OCR-text path      — recognizeCardFromOcr, executed end to end.
 *   • API fallback       — recognizeCardFromImage with the recognition endpoint
 *                          stubbed to return a bare cardNumber, executed end to
 *                          end through the real recognizeViaApi local lookup.
 *   • manual/per-line    — recognizeCard, executed end to end.
 *   • local-image OCR leg— its OCR seam needs a real decoded image, which this
 *                          harness cannot produce. Its resolver call is covered
 *                          directly plus a source guard asserting the leg holds
 *                          no first-match lookup. Stated, not glossed.
 *
 * Run: node --import ./scripts/register-web-render.mjs \
 *        scripts/test-scan-exact-printing-identity.mjs
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf-8');

// The shipped native asset is what the recovery path reads at runtime.
const shippedDb = JSON.parse(read('public/data/database.json'));

// Stub the two network calls the module makes: the catalog fetch, and the
// recognition endpoint. `apiResponse` is swapped per-case so the same real code
// path can be driven into its different branches.
let apiResponse = { success: false };
let apiCallCount = 0;
globalThis.fetch = async (url) => {
  const u = String(url);
  if (u.includes('/data/database.json')) {
    return { ok: true, status: 200, json: async () => shippedDb };
  }
  apiCallCount += 1;
  return { ok: true, status: 200, json: async () => apiResponse };
};

const {
  recognizeCardFromOcr,
  recognizeCardFromImage,
  recognizeCard,
  loadAllCards,
  resolvePrintingByCardNumber,
} = await import('../src/services/cardRecognition.ts');

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

const AMBIGUOUS = 'hBP01-024';
const rows = Object.values(shippedDb.cards).filter((c) => c.cardNumber === AMBIGUOUS);
const pricesForNumber = rows.map((r) => r.sellPrice).filter((p) => typeof p === 'number' && p > 0);
const FIRST_SIBLING_PRICE = rows.find((r) => typeof r.sellPrice === 'number' && r.sellPrice > 0)?.sellPrice;

// ── 0. The fixture still has the divergence the CR describes ────────────────
check(
  `${AMBIGUOUS} still has multiple printings in the shipped catalog`,
  rows.length > 1,
  `got ${rows.length}`,
);
check(
  `${AMBIGUOUS} printings still disagree on price (the reason first-match was unsafe)`,
  new Set(pricesForNumber).size > 1,
  `prices=${JSON.stringify(pricesForNumber)}`,
);
console.log(`  … ${AMBIGUOUS}: ${rows.length} printings, prices ${JSON.stringify(pricesForNumber)}`);

// A cardNumber with exactly one printing — proves the fix blocks ambiguity
// rather than blocking everything.
const uniqueRow = Object.values(shippedDb.cards).find((c) => {
  const siblings = Object.values(shippedDb.cards).filter((o) => o.cardNumber === c.cardNumber);
  return siblings.length === 1 && typeof c.sellPrice === 'number' && c.sellPrice > 0;
});
check('found a single-printing control card with a price', !!uniqueRow, 'needed to prove the fix is not a blanket block');

function assertAmbiguous(label, result) {
  check(`${label}: still returns the card (scan UX preserved, not an error)`, result?.success === true, JSON.stringify(result?.error));
  check(`${label}: carries NO price`, result?.card?.sellPrice == null, `got ${result?.card?.sellPrice}`);
  check(
    `${label}: does NOT quote the first sibling's price`,
    result?.card?.sellPrice !== FIRST_SIBLING_PRICE,
    `got ${result?.card?.sellPrice}`,
  );
  check(`${label}: exposes no printing rows to price from`, (result?.card?.prices ?? []).length === 0);
  check(`${label}: offers every printing as a candidate to resolve`, result?.candidates?.length === rows.length,
    `got ${result?.candidates?.length}, expected ${rows.length}`);
  check(`${label}: is flagged low-confidence so the UI asks rather than asserts`, result?.confidence === undefined || result?.lowConfidence === true);
  // Each candidate is a real printing carrying ITS OWN price — that is the
  // resolution step, not a guess.
  const candidatePrices = (result?.candidates ?? []).map((c) => c.card.sellPrice);
  check(`${label}: candidates keep their own individual prices`,
    candidatePrices.some((p) => p === 50) && candidatePrices.some((p) => p === 120),
    `got ${JSON.stringify(candidatePrices)}`);
}

// ── 1. OCR-text path (the CR's named probe) ─────────────────────────────────
{
  apiResponse = { success: false };
  const result = await recognizeCardFromOcr(AMBIGUOUS);
  assertAmbiguous('OCR-text', result);
}

// ── 2. API cardNumber-only fallback, executed end to end ────────────────────
{
  apiCallCount = 0;
  apiResponse = { success: true, cardNumber: AMBIGUOUS };
  const result = await recognizeCardFromImage('data:image/png;base64,iVBORw0KGgo=');
  check('API fallback: the recognition endpoint was really called', apiCallCount > 0, `calls=${apiCallCount}`);
  assertAmbiguous('API fallback', result);
}

// ── 3. Manual / per-line path (reached from OCR Step 2) ─────────────────────
{
  apiResponse = { success: false };
  const result = await recognizeCard(AMBIGUOUS);
  assertAmbiguous('recognizeCard', result);
}

// ── 4. Printing identity survives the catalog mapping ───────────────────────
{
  const all = await loadAllCards();
  const mapped = all.filter((c) => c.cardNumber === AMBIGUOUS);
  check('every printing survives as its own CardInfo', mapped.length === rows.length, `got ${mapped.length}`);
  check(
    'printing ids are unique — the compound catalog key is preserved',
    new Set(mapped.map((c) => c.id)).size === mapped.length,
    `ids=${JSON.stringify(mapped.map((c) => c.id))}`,
  );
  check(
    'printing ids are NOT flattened to the bare cardNumber',
    mapped.every((c) => c.id !== c.cardNumber),
    `ids=${JSON.stringify(mapped.map((c) => c.id))}`,
  );
}

// ── 5. Controls: unique / promo / parallel ──────────────────────────────────
{
  // Unique printing → still resolves WITH its price. Without this the fix could
  // be "never return a price", which would pass every assertion above.
  const res = resolvePrintingByCardNumber(await loadAllCards(), uniqueRow.cardNumber);
  check(`unique control ${uniqueRow.cardNumber} resolves to exactly one printing`, res.status === 'unique', `status=${res.status}`);
  check(`unique control keeps its own price ${uniqueRow.sellPrice}`, res.status === 'unique' && res.card.sellPrice === uniqueRow.sellPrice,
    `got ${res.status === 'unique' ? res.card.sellPrice : 'n/a'}`);

  const ocr = await recognizeCardFromOcr(uniqueRow.cardNumber);
  check(`unique control still scans to a priced result (${uniqueRow.cardNumber})`,
    ocr.success === true && ocr.card?.sellPrice === uniqueRow.sellPrice,
    `got ${ocr.card?.sellPrice}`);

  // Promo control: hPR/P is one of the hBP01-024 printings and has NO proven
  // price. It must be offered as a candidate, and must not be silently dropped
  // or given a sibling's number.
  const promo = rows.find((r) => r.series === 'hPR');
  check('promo control hPR printing exists for the ambiguous number', !!promo);
  const promoCandidate = (await recognizeCardFromOcr(AMBIGUOUS)).candidates
    ?.find((c) => c.card.series === 'hPR');
  check('promo printing is offered as a candidate', !!promoCandidate);
  check('promo printing keeps its unproven (null) price — no sibling number borrowed',
    promoCandidate?.card.sellPrice == null, `got ${promoCandidate?.card.sellPrice}`);

  // Parallel/ordinary control: the two differently-priced printings both appear
  // with their own numbers.
  const cands = (await recognizeCardFromOcr(AMBIGUOUS)).candidates ?? [];
  const c50 = cands.find((c) => c.card.sellPrice === 50);
  const c120 = cands.find((c) => c.card.sellPrice === 120);
  check('ordinary/parallel controls: both divergent printings are offered separately',
    !!c50 && !!c120 && c50.card.id !== c120.card.id);
}

// ── 6. The catalog-wide invariant, not just one fixture ─────────────────────
{
  const all = await loadAllCards();
  const byNumber = new Map();
  for (const c of all) {
    if (!byNumber.has(c.cardNumber)) byNumber.set(c.cardNumber, []);
    byNumber.get(c.cardNumber).push(c);
  }
  const divergent = [...byNumber.entries()].filter(([, list]) => {
    const priced = list.map((c) => c.sellPrice).filter((p) => typeof p === 'number' && p > 0);
    return list.length > 1 && new Set(priced).size > 1;
  });
  check('the catalog has many divergent-price card numbers to cover', divergent.length >= 20, `got ${divergent.length}`);

  const leaked = [];
  for (const [cardNumber] of divergent) {
    const res = resolvePrintingByCardNumber(all, cardNumber);
    if (res.status !== 'ambiguous') leaked.push({ cardNumber, status: res.status });
  }
  check(
    `every one of the ${divergent.length} divergent-price numbers resolves as ambiguous, never first-match`,
    leaked.length === 0,
    `${leaked.length} leaked, e.g. ${JSON.stringify(leaked[0])}`,
  );
}

// ── 7. Source guards, including the leg this harness cannot execute ─────────
{
  const src = read('src/services/cardRecognition.ts');
  const stripComments = (t) => t.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/[^\n]*/g, '$1');
  const code = stripComments(src);
  check(
    'no recovery lookup matches a bare cardNumber against c.id any more',
    !/find\(\s*c\s*=>\s*c\.id\.toLowerCase\(\)\s*===\s*card(Number|Id)\s*\)/.test(code),
  );
  check(
    'the local-image OCR leg resolves through resolvePrintingByCardNumber',
    /const exact = resolvePrintingByCardNumber\(allCards, cardId\)/.test(code),
    'this leg cannot be executed here — its OCR seam needs a decoded image, so it is pinned statically',
  );
  check(
    'the catalog mapping keeps entry.id ahead of cardNumber',
    /id:\s*entry\.id\s*\|\|\s*\(entry as any\)\.cardNumber/.test(code),
  );
}

// ── 8. Discrimination: the fixture can tell the two behaviours apart ────────
{
  const all = await loadAllCards();
  // The removed behaviour, re-implemented: first row whose cardNumber matches.
  const firstMatch = all.find((c) => c.cardNumber.toLowerCase() === AMBIGUOUS.toLowerCase());
  check(
    'the removed first-match behaviour would still produce a PRICED result here',
    typeof firstMatch?.sellPrice === 'number' && firstMatch.sellPrice > 0,
    `first-match price=${firstMatch?.sellPrice} — if this goes null the fixture stopped discriminating`,
  );
  const nowResult = await recognizeCardFromOcr(AMBIGUOUS);
  check(
    'and the current behaviour returns no price for the same input',
    nowResult.card?.sellPrice == null,
  );
}

// ── 9. CI runs this ────────────────────────────────────────────────────────
{
  check('CI executes the exact-printing identity regression',
    read('.github/workflows/ci.yml').includes('test:scan-exact-printing-identity'));
  check('package.json defines test:scan-exact-printing-identity',
    !!JSON.parse(read('package.json')).scripts['test:scan-exact-printing-identity']);
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ Scan exact-printing identity regression: ${passed} checks passed`);
} else {
  console.error('\n❌ Scan exact-printing identity regression failed');
}
