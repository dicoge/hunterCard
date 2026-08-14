// Tournament deck → editor deck import (DIC-1000). Pure and framework-free so
// the mapping can be regression-tested without React or the store.
//
// Fail-closed contract, inherited from the exact-version price rules
// (DIC-952 / DIC-978) and restated by DIC-1000 #5:
//   • A source slot is matched to a local catalog entry ONLY by the exact
//     printing path both sides publish. No same-name match, no same-cardNumber
//     match, no highest-price / "best" printing pick, no cross-version
//     substitution — ever.
//   • When the exact printing has no local entry, or the source published no
//     version at all, the slot is kept with the source's own cardNumber and
//     version and flagged `unresolvedPrinting`. The deck stays complete and
//     editable; price and catalog lookups return nothing rather than a guess,
//     and the UI states the limitation.
//   • Zones and quantities are copied exactly as the source published them. A
//     source deck that breaks a construction rule is imported as-is so the
//     editor's rule checker reports the real errors.

import type { DeckEntry, DeckCardRef, TournamentEvent } from '../types/tournament';
import { normalizeVersion, type DeckCard, type DeckSlot, type DeckZone } from './deckRules';

export type ImportZones = Record<DeckZone, DeckSlot[]>;

export interface ImportedDeckDraft {
  name: string;
  zones: ImportZones;
  /** slots whose exact printing could not be matched to a local catalog entry */
  unresolved: DeckCardRef[];
}

/** printingPath → catalog entries serving that exact printing. */
export function buildPrintingIndex(cards: DeckCard[]): Map<string, DeckCard[]> {
  const index = new Map<string, DeckCard[]>();
  for (const card of cards) {
    if (!card.printingPath) continue;
    const bucket = index.get(card.printingPath);
    if (bucket) bucket.push(card);
    else index.set(card.printingPath, [card]);
  }
  return index;
}

/** Resolve one source slot to the local catalog entry for that exact printing,
 *  or null when there is none. The printing path alone is not proof of identity:
 *  it is a string two unrelated catalog entries can carry, so the match is only
 *  accepted when the candidate ALSO agrees on the source's exact cardNumber and
 *  version. Without that check a source slot resolves to a different card that
 *  happens to share a path, which is precisely the substitution this module
 *  exists to prevent.
 *
 *  The same printing is often listed once per product it was reprinted in
 *  (identical art, identical rarity) — those are one version, so a deterministic
 *  pick among them substitutes nothing. If the bucket disagrees with itself on
 *  cardNumber or rarity the printing is ambiguous and we resolve nothing rather
 *  than choose one of two mutually inconsistent entries. */
export function resolvePrinting(
  ref: DeckCardRef,
  index: Map<string, DeckCard[]>,
): DeckCard | null {
  if (!ref.imagePath || !ref.version) return null;
  const candidates = index.get(ref.imagePath);
  if (!candidates || candidates.length === 0) return null;

  const numbers = new Set(candidates.map((c) => c.cardNumber));
  const versions = new Set(candidates.map((c) => normalizeVersion(c.rarity)));
  if (numbers.size > 1 || versions.size > 1) return null;

  const [candidate] = candidates;
  if (candidate.cardNumber !== ref.cardNumber) return null;
  if (normalizeVersion(candidate.rarity) !== normalizeVersion(ref.version)) return null;

  return candidates.slice().sort((a, b) => a.id.localeCompare(b.id))[0];
}

/** Build the deck card for a slot with no local catalog entry, from source data
 *  only. The source's cardNumber and version are preserved verbatim; the
 *  source's card type drives zone/legality checks so the rule checker stays
 *  honest instead of silently passing an unknown card. */
export function unresolvedDeckCard(ref: DeckCardRef): DeckCard {
  return {
    id: `unresolved:${ref.cardNumber}|${ref.version ?? ''}|${ref.imagePath ?? ''}`,
    cardNumber: ref.cardNumber,
    name: ref.name || ref.cardNumber,
    rarity: ref.version ?? '',
    series: ref.imagePath ? ref.imagePath.split('/')[0] : '',
    cardTypeJp: ref.cardKind ?? '',
    printingPath: ref.imagePath ?? undefined,
    unresolvedPrinting: true,
  };
}

function emptyZones(): ImportZones {
  return { oshi: [], main: [], yell: [] };
}

/** Merge slots that resolve to the same card within a zone, so a source list
 *  that splits one printing across two entries imports as one slot with the
 *  summed quantity. */
function pushSlot(slots: DeckSlot[], card: DeckCard, qty: number): void {
  const existing = slots.find((s) => s.card.id === card.id);
  if (existing) existing.qty += qty;
  else slots.push({ card, qty });
}

export function buildImportZones(
  cards: DeckCardRef[],
  index: Map<string, DeckCard[]>,
): { zones: ImportZones; unresolved: DeckCardRef[] } {
  const zones = emptyZones();
  const unresolved: DeckCardRef[] = [];
  for (const ref of cards) {
    const match = resolvePrinting(ref, index);
    if (!match) unresolved.push(ref);
    pushSlot(zones[ref.zone], match ?? unresolvedDeckCard(ref), ref.count);
  }
  return { zones, unresolved };
}

/** Human-readable name built only from values the source actually published.
 *  Unknown parts are omitted, never filled with a placeholder rank or player. */
export function importedDeckName(event: TournamentEvent, deck: DeckEntry): string {
  const eventName = event.nameZh || event.name;
  const details = [
    deck.archetypeLabel || deck.oshi,
    deck.rankLabel,
    deck.playerName,
  ].filter((part): part is string => !!part && part.trim().length > 0);

  if (eventName && details.length > 0) return `${eventName}｜${details.join('·')}`;
  if (eventName) return eventName;
  if (details.length > 0) return details.join('·');
  return deck.decklogCode ? `賽事牌組 ${deck.decklogCode}` : '賽事牌組';
}

/** Deterministic de-collision for repeated imports of the same deck: the first
 *  copy keeps the plain name, later copies get an ascending numeric suffix. The
 *  copies are independent decks; nothing is ever overwritten. */
export function uniqueDeckName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** True when the source published a card list for this deck. A deck without one
 *  must not offer an import CTA — the UI states why instead. */
export function isImportable(deck: DeckEntry): boolean {
  return deck.cardsVerified && deck.cards.length > 0;
}

export function buildImportedDeck(
  event: TournamentEvent,
  deck: DeckEntry,
  catalog: DeckCard[],
  existingNames: string[],
): ImportedDeckDraft {
  const { zones, unresolved } = buildImportZones(deck.cards, buildPrintingIndex(catalog));
  return {
    name: uniqueDeckName(importedDeckName(event, deck), existingNames),
    zones,
    unresolved,
  };
}
