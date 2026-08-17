#!/usr/bin/env node
/**
 * DIC-1064 — the defaulted-printing banner must actually REACH THE SCREEN.
 *
 * DIC-1060 shipped with only `source.includes('DEFAULTED_PRINTING_NOTE')` as its
 * UI guard. That string is satisfied by the file's import line and by the
 * per-card printing label, so deleting the whole tournament banner block — or
 * breaking the `defaultedPrintings > 0` / `origin.kind === 'tournament'`
 * conditions that gate it — left the suite green while the player saw nothing
 * explaining why their imported deck was priced off a printing the source never
 * named.
 *
 * So this file renders the real DeckEditorScreen through react-native-web (the
 * exact component tree holohunter.dicoge.com ships, `testID` → `data-testid`)
 * against a store seeded by the real tournament importer, and asserts on the
 * resulting DOM:
 *
 *   • a tournament deck with defaulted printings renders
 *     `deck-defaulted-printings-note` carrying the exact user-facing wording;
 *   • a deck that is NOT tournament-imported renders no origin banner at all,
 *     even though its slots still carry the defaulted flag;
 *   • a tournament deck whose source PROVED every printing renders the origin
 *     banner but no defaulted note.
 *
 * The last two are what make the first trustworthy: an always-true render
 * condition fails them. Nothing here restates the resolver's logic — the oracle
 * is "what the player can read on screen".
 *
 * Run: npm run test:tournament-banner-render
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { JSDOM } from 'jsdom';

// ── The DOM must exist before react-native-web is imported: its StyleSheet
//    installs a real style element at module-evaluation time. ────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', {
  url: 'https://holohunter.dicoge.com/',
  pretendToBeVisual: true,
});
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try {
    globalThis[key] = dom.window[key];
  } catch {
    // read-only globals (e.g. `location`) are already usable via `window`
  }
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
// jsdom ships no ResizeObserver; react-native-web's onLayout only reports element
// sizes, which nothing asserted here depends on.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver = NoopResizeObserver;
dom.window.ResizeObserver = NoopResizeObserver;

const rawDb = JSON.parse(fs.readFileSync('public/data/database.json', 'utf8'));
const august = JSON.parse(fs.readFileSync('data/tournaments/2026-08.json', 'utf8'));

// The screen loads its catalog over fetch(); serve the shipped file instead of
// the network so the render path itself is unchanged.
globalThis.fetch = async (input) => {
  const url = typeof input === 'string' ? input : String(input?.url ?? input);
  assert.equal(url, '/data/database.json', `unexpected fetch during render: ${url}`);
  return { ok: true, json: async () => rawDb };
};

const React = (await import('react')).default;
const { createRoot } = await import('react-dom/client');
const { act } = await import('react');
const DeckEditorScreen = (await import('../src/screens/DeckEditorScreen.tsx')).default;
const { adaptDatabase } = await import('../src/utils/deckCardData.ts');
const {
  DEFAULTED_PRINTING_NOTE,
  buildCatalogIndex,
  buildImportedDeck,
} = await import('../src/utils/tournamentDeckImport.ts');
const { useDeckStore } = await import('../src/store/deckStore.ts');
const platformStorage = (await import('../src/stores/storage.ts')).default;

/** The wording is pinned as a literal, not read from the module, so renaming or
 *  rewording the constant cannot quietly rename what the player reads. */
const EXPECTED_NOTE = '來源未指定版本，已使用最低普通版本估價';
const DEFAULTED_NOTE_TESTID = 'deck-defaulted-printings-note';
const ORIGIN_BANNER_TESTID = 'deck-origin-banner';

let passed = 0;
async function test(name, fn) {
  await fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// ── Real shipped artefacts, imported by the real importer ────────────────────
const db = adaptDatabase(Object.values(rawDb.cards || {}));
const catalog = buildCatalogIndex(db.cards);
const event = august.events[0];
const sourceDeck = event.decks.find((d) => d.decklogCode === 'DUKHN');
assert.ok(sourceDeck, 'the real August DUKHN deck must be present in the shipped report');

const IMPORTED_AT = '2026-08-17T00:00:00.000Z';
const importDraft = (deck) =>
  buildImportedDeck(event, deck, catalog, db.priceRecords, [], IMPORTED_AT);

const draftToDeck = (draft, id) => ({
  id,
  name: draft.name,
  oshi: draft.oshi,
  main: draft.main,
  yell: draft.yell,
  updatedAt: IMPORTED_AT,
  origin: draft.origin,
});

const slotsOf = (deck) => [...deck.oshi, ...deck.main, ...deck.yell];
const countDefaulted = (deck) => slotsOf(deck).filter((s) => s.card.defaultedPrinting === true).length;

const defaultedDraft = importDraft(sourceDeck);
assert.ok(
  defaultedDraft.defaultedPrintings > 0,
  'precondition: the real DUKHN import must produce defaulted printings',
);

/**
 * A tournament deck the source fully PROVED: every slot names the exact printing
 * the default would otherwise have picked, with `printingProven`, so the
 * importer preserves it and marks nothing defaulted. Built through the real
 * importer rather than by clearing flags on the deck above.
 */
const provenSourceDeck = {
  ...sourceDeck,
  cards: sourceDeck.cards.map((ref) => {
    const slot = slotsOf(defaultedDraft).find((s) => s.card.cardNumber === ref.cardNumber);
    assert.ok(slot, `precondition: ${ref.cardNumber} must resolve in the real import`);
    return { ...ref, version: slot.card.printing, printingProven: true };
  }),
};
const provenDraft = importDraft(provenSourceDeck);
assert.equal(
  provenDraft.defaultedPrintings, 0,
  'precondition: a fully source-proven tournament deck defaults nothing',
);

// ── Render harness ───────────────────────────────────────────────────────────
function seedActiveDeck(deck) {
  platformStorage.removeItem('hunterCard-decks');
  useDeckStore.setState({ decks: [deck], activeDeckId: deck.id, collection: {} });
}

async function renderDeckEditor(deck) {
  seedActiveDeck(deck);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () => {
    root.render(React.createElement(DeckEditorScreen));
  });
  const cleanup = async () => {
    await act(async () => root.unmount());
    container.remove();
  };
  return { container, cleanup };
}

const byTestId = (container, testID) => container.querySelector(`[data-testid="${testID}"]`);

// ── 1. The banner the CR could not see ───────────────────────────────────────
await test('a tournament deck with defaulted printings renders the note on screen', async () => {
  const deck = draftToDeck(defaultedDraft, 'render-defaulted');
  const { container, cleanup } = await renderDeckEditor(deck);
  try {
    const note = byTestId(container, DEFAULTED_NOTE_TESTID);
    assert.ok(note, `the rendered deck editor must contain testID ${DEFAULTED_NOTE_TESTID}`);
    assert.ok(
      note.textContent.includes(EXPECTED_NOTE),
      `the note must read "${EXPECTED_NOTE}", got: ${note.textContent}`,
    );
    assert.equal(DEFAULTED_PRINTING_NOTE, EXPECTED_NOTE);
    // The count is the player's only signal of how much of the deck is a
    // planning default rather than the source's own choice.
    assert.ok(
      note.textContent.includes(String(countDefaulted(deck))),
      `the note must state the ${countDefaulted(deck)} defaulted slots, got: ${note.textContent}`,
    );
  } finally {
    await cleanup();
  }
});

// ── 2. Absent for a deck that was never imported from a tournament ───────────
// Only the BANNER is asserted absent: an individual defaulted card still labels
// itself with the same wording, which is correct and independent of the origin.
await test('a non-tournament deck renders no origin banner and no note', async () => {
  const deck = { ...draftToDeck(defaultedDraft, 'render-manual'), origin: undefined };
  assert.ok(countDefaulted(deck) > 0, 'precondition: the slots still carry the defaulted flag');
  const { container, cleanup } = await renderDeckEditor(deck);
  try {
    assert.equal(byTestId(container, ORIGIN_BANNER_TESTID), null,
      'the origin banner belongs to tournament-imported decks only');
    assert.equal(byTestId(container, DEFAULTED_NOTE_TESTID), null,
      'the defaulted note must not render outside the tournament origin banner');
  } finally {
    await cleanup();
  }
});

// ── 3. Absent when the source proved every printing ──────────────────────────
await test('a fully source-proven tournament deck renders the banner without the note', async () => {
  const deck = draftToDeck(provenDraft, 'render-proven');
  const { container, cleanup } = await renderDeckEditor(deck);
  try {
    assert.ok(byTestId(container, ORIGIN_BANNER_TESTID),
      'a tournament deck still announces where it came from');
    assert.equal(byTestId(container, DEFAULTED_NOTE_TESTID), null,
      'nothing was defaulted, so the note must not claim otherwise');
    assert.ok(
      !container.textContent.includes(EXPECTED_NOTE),
      'the defaulted wording must not appear when the source proved every printing',
    );
  } finally {
    await cleanup();
  }
});

console.log(`\nDIC-1064 defaulted-printing banner render path: ${passed} tests passed`);
