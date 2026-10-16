#!/usr/bin/env node
/**
 * Scan regression 2026-10-16: v38 app × v37 production backend.
 *
 * The v37 recognize-card backend has no `match` verdict; it answers every card whose
 * number has several printings as `lowConfidence` + its top-5, where printings are
 * followed by same-character filler of OTHER numbers. The v38 client's legacy path
 * (presentCandidates) treated any mixed list as "no match", so a correctly read card
 * showed 證據不足 (offline scope over the catalog: 875 of 1,387 numbers).
 *
 * Fixtures in scripts/fixtures/v37-wire/ are real v37 handler responses (api/
 * recognize-card.ts @ ec8447dc, mocked Gemini reading; raw/debug dropped). Each is run
 * through the REAL v38 client entry (recognizeCardFromImage → runNativeCameraScan, and
 * runWebCameraScan) and the resulting presentation is asserted. No provider, image,
 * camera or quota is used.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';

const { recognizeCardFromImage, candidateEvidence } = await import('../src/services/cardRecognition.ts');
const { runNativeCameraScan, runWebCameraScan } = await import('../src/services/scanRecognitionFlow.ts');
const { presentCandidates } = await import('../src/services/scanPresentation.ts');
const fixture = (n) => JSON.parse(fs.readFileSync(new URL(`./fixtures/v37-wire/${n}.json`, import.meta.url), 'utf8'));

let passed = 0;
async function test(label, fn) {
  try { await fn(); passed += 1; console.log(`  ✓ ${label}`); }
  catch (err) { process.exitCode = 1; console.error(`  ✗ ${label} — ${err.message}`); }
}

let current = null;
globalThis.fetch = async (url) => {
  if (String(url).includes('/api/recognize-card')) {
    const f = current;
    return { ok: f.status < 400, status: f.status, json: async () => JSON.parse(JSON.stringify(f.body)) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};
const JPEG = `data:image/jpeg;base64,${Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(600, 7)]).toString('base64')}`;
const mapCard = (c) => ({ ...c });
const mapCands = (raw) => (Array.isArray(raw) && raw.length ? raw.map((c) => ({ card: mapCard(c), confidence: c.confidence ?? 0, evidence: candidateEvidence(c.reason) })) : undefined);

async function run(name, kind = 'native') {
  current = fixture(name);
  const seen = { presentation: null, committed: [], ocr: 0 };
  const noop = () => {};
  const io = {
    callRecognitionApi: async () => ({ status: current.status, body: JSON.parse(JSON.stringify(current.body)) }),
    recognizeFromImage: (u) => recognizeCardFromImage(u),
    ocrText: async () => { seen.ocr += 1; return ''; },
    recognizeFromOcr: async () => ({ success: false }), searchCards: async () => [], mapApiCard: mapCard, mapApiCandidates: mapCands,
  };
  const ui = {
    setStatus: noop, setBusy: noop, setScanError: noop, setSearchError: noop, setSearchResults: noop, setSuggestions: noop,
    setRecognizedText: noop, setCandidateReason: noop,
    // Same adapter ScanScreen wires (buildScanFlowUi): the web flow hands lowConfidence
    // candidates here, and the screen presents them through presentCandidates.
    showLowConfidenceCandidates: (c) => ui.showPresentation(presentCandidates(c)),
    onRecognized: (c) => seen.committed.push(c.id), onVisionRecognized: (c) => seen.committed.push(c.id),
    showPresentation: (p) => { seen.presentation = p; },
  };
  if (kind === 'native') await runNativeCameraScan(JPEG, io, ui);
  else await runWebCameraScan(JPEG, io, ui);
  return seen;
}

for (const flow of ['native', 'web']) {
  console.log(`\n${flow} flow × v37 wire`);
  await test(`${flow}: 2 printings + rarity read → best-match PREVIEW of that printing (not 證據不足), filler dropped`, async () => {
    const { presentation: p, committed } = await run('two-printings-rarity-read', flow);
    assert.equal(p.kind, 'best');
    assert.equal(p.card.id, 'hBP01-001_hBP01_OUR_hBP01-001_OUR');
    assert.deepEqual(p.alternatives.map((c) => c.card.cardNumber), ['hBP01-001'], 'only the other printing, no filler');
    assert.ok(p.evidence.includes('cardNumber exact'));
    assert.deepEqual(committed, [], 'previewed, never auto-committed');
  });
  await test(`${flow}: 2 printings, rarity not read → identity WITHOUT price, both printings offered`, async () => {
    const { presentation: p } = await run('two-printings-no-rarity', flow);
    assert.equal(p.kind, 'identity');
    assert.equal(p.card.sellPrice, null);
    assert.deepEqual(p.card.prices, []);
    assert.deepEqual(p.printings.map((c) => c.card.rarity).sort(), ['OSR', 'OUR']);
  });
  await test(`${flow}: 4 printings, no name read → identity with exactly those 4 printings`, async () => {
    const { presentation: p } = await run('four-printings', flow);
    assert.equal(p.kind, 'identity');
    assert.equal(p.printings.length, 4);
    assert.ok(p.printings.every((c) => c.card.cardNumber === 'hBP07-023'));
  });
  await test(`${flow}: number read but the name belongs to other cards → explicit no-match (conflict), no identity`, async () => {
    const { presentation: p } = await run('number-name-conflict', flow);
    assert.equal(p.kind, 'none');
    assert.equal(p.reason, 'number_name_conflict');
  });
  await test(`${flow}: number not in the catalog → still an explicit no-match, filler never promoted`, async () => {
    const { presentation: p } = await run('number-not-in-catalog', flow);
    assert.equal(p.kind, 'none');
  });
  await test(`${flow}: no number read (name only) → still an explicit no-match`, async () => {
    const { presentation: p } = await run('name-only', flow);
    assert.equal(p.kind, 'none');
  });
}

console.log('\nEvidence parsing');
await test('only allowlisted ranker tokens are kept from a wire reason', () => {
  assert.deepEqual(candidateEvidence('cardNumber exact, character exact/contains, rarity'), ['cardNumber exact', 'character exact/contains', 'rarity']);
  assert.equal(candidateEvidence('cardNumber exact<script>, free text'), undefined);
  assert.equal(candidateEvidence(undefined), undefined);
});
await test('a candidate list without evidence (local OCR) keeps the previous rules', async () => {
  const { presentCandidates } = await import('../src/services/scanPresentation.ts');
  const same = [{ card: { cardNumber: 'hBP01-001', id: 'a' }, confidence: 0.5 }, { card: { cardNumber: 'hBP01-001', id: 'b' }, confidence: 0.5 }];
  assert.equal(presentCandidates(same).kind, 'identity');
  assert.equal(presentCandidates([...same, { card: { cardNumber: 'hBP01-009', id: 'c' }, confidence: 0.4 }]).kind, 'none');
});

if ((process.exitCode ?? 0) === 0) console.log(`\n✅ scan-legacy-backend: ${passed} checks passed`);
else console.error('\n❌ scan-legacy-backend failed');
