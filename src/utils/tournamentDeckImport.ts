// Verified tournament deck → deck-planner import (DIC-1033). Pure and
// framework-free so the whole mapping and its fail-closed gate can be regression
// tested with plain node, without React or the store.
//
// What the source actually proves, and what it does not
// -----------------------------------------------------
// The DIC-1024 collector reads Deck Log's public view API, which publishes each
// slot's exact cardNumber, its deck zone and its quantity — those three are
// source-proven and are copied verbatim.
//
// The `version` it publishes alongside them is Deck Log's RARITY GRADE (OSR, RR,
// SR, S, R, U, C, …). The local catalog's printing identity is a different
// vocabulary entirely: it is derived from the yuyu-tei listing label and spells
// out physical printings (BASE, PARALLEL, PARALLEL/SIGN, PARALLEL/hBP07, …).
// A rarity grade therefore does NOT name a collectible printing — hBP07-006 is
// "OSR" at Deck Log while its listings are a ¥1,280 plain copy, a ¥29,800
// parallel and a ¥148,000 signed parallel.
//
// So this module takes the only honest position available (issue §6):
//   • a printing is preserved only when the source EXPLICITLY claims its token
//     names one (`printingProven`) and that token identifies exactly one local
//     printing. Matching alone is not proof — a grade can spell the same string
//     as a printing token by coincidence, and promoting it would turn a grade
//     into a priced physical printing (DIC-1036);
//   • otherwise the slot keeps its exact cardNumber, zone and count but its
//     printing is marked UNRESOLVED. It never borrows a sibling printing's price
//     — the existing resolver returns NO_EXACT_PRICE for it — and it is never
//     silently rewritten onto the cheapest or the most expensive version.
// Every deck the shipped collectors produce therefore lands fully unresolved:
// nothing sets `printingProven`, because Deck Log never proves a printing.
// No same-name, same-number cross-version, highest-price, SEC/signed or
// cross-printing fallback is used anywhere in this file.
//
// The printing token is deliberately a non-empty sentinel: `printing: ''` is the
// pre-DIC-1013 legacy marker that migrateLegacyPrintings rewrites onto the
// low-cost default, which would silently alter a published printing on reload.

import type { DeckEntry, TournamentEvent, DeckCardRef } from '../types/tournament';
import { duplicateSlotsWithinZone } from './tournamentReport';
import {
  RULES,
  normalizeVersion,
  type DeckCard,
  type DeckOrigin,
  type DeckSlot,
  type DeckZone,
} from './deckRules';

/** Printing identity for a slot whose collectible printing the source did not
 *  prove. No price record can ever carry it, so it prices NO_EXACT_PRICE. */
export const UNRESOLVED_PRINTING = 'UNRESOLVED';

export const ZONES: DeckZone[] = ['oshi', 'main', 'yell'];

export interface ImportedDeckDraft {
  name: string;
  oshi: DeckSlot[];
  main: DeckSlot[];
  yell: DeckSlot[];
  origin: DeckOrigin;
  /** how many slots carry an unresolved printing — surfaced verbatim in the UI */
  unresolvedPrintings: number;
}

export type ImportGate =
  | { importable: true }
  | { importable: false; code: ImportBlockCode; reason: string };

export type ImportBlockCode =
  | 'NOT_VERIFIED'
  | 'NO_CARDS'
  | 'BAD_ZONE'
  | 'BAD_CARD_NUMBER'
  | 'BAD_COUNT'
  | 'DUPLICATE_SLOT'
  | 'ZONE_TOTAL'
  | 'CATALOG_LOADING'
  | 'UNKNOWN_CARD';

function blocked(code: ImportBlockCode, reason: string): ImportGate {
  return { importable: false, code, reason };
}

function isPositiveInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n > 0;
}

function zoneTargets(): Record<DeckZone, number> {
  return {
    oshi: RULES.zones.oshi.exactCount,
    main: RULES.zones.main.exactCount,
    yell: RULES.zones.yell.exactCount,
  };
}

/** cardNumber → every local catalog entry for that number (one per printing). */
export function buildCatalogIndex(cards: DeckCard[]): Map<string, DeckCard[]> {
  const index = new Map<string, DeckCard[]>();
  for (const card of cards) {
    const bucket = index.get(card.cardNumber);
    if (bucket) bucket.push(card);
    else index.set(card.cardNumber, [card]);
  }
  return index;
}

/**
 * The fail-closed gate (issue §5). Everything the button needs to know before it
 * may be enabled — an unverified card list, a malformed slot, a duplicate slot,
 * a zone total that is not exactly 1 / 50 / 20, or a card number the local
 * catalog cannot identify all block the import outright with their own reason.
 *
 * A slot whose PRINTING is unresolved does not block: the card's local identity
 * is known, so the deck imports complete and the unresolved printing is stated.
 *
 * `index` is null while the card database is still loading.
 */
export function evaluateImport(
  deck: DeckEntry,
  index: Map<string, DeckCard[]> | null,
): ImportGate {
  // Strictly `true`, not merely truthy: a report that ever carried the string
  // "false" or a 1/0 flag must read as unverified rather than as permission.
  if (deck?.cardsVerified !== true) return blocked('NOT_VERIFIED', '卡表尚未取得，無法匯入');

  const cards = Array.isArray(deck.cards) ? deck.cards : [];
  if (cards.length === 0) return blocked('NO_CARDS', '卡表尚未取得，無法匯入');

  const totals: Record<DeckZone, number> = { oshi: 0, main: 0, yell: 0 };

  for (const ref of cards) {
    if (!ref || !ZONES.includes(ref.zone)) {
      return blocked('BAD_ZONE', '卡表區域資料異常，無法匯入');
    }
    if (typeof ref.cardNumber !== 'string' || ref.cardNumber.trim() === '') {
      return blocked('BAD_CARD_NUMBER', '卡表卡號資料異常，無法匯入');
    }
    if (!isPositiveInt(ref.count)) {
      return blocked('BAD_COUNT', '卡表張數資料異常，無法匯入');
    }
    totals[ref.zone] += ref.count;
  }

  // A slot's identity is (zone, cardNumber) and nothing else. The rarity grade
  // the source publishes alongside the number is not part of it, so two rows
  // for one number inside one zone are a duplicate even when their grades read
  // differently — that pair used to slip through and land as one silently
  // doubled slot (DIC-1036). This is the collector's own revalidation rule,
  // shared rather than restated so the runtime gate cannot drift from it again.
  if (duplicateSlotsWithinZone(cards).length > 0) {
    return blocked('DUPLICATE_SLOT', '卡表有重複項目，無法匯入');
  }

  const want = zoneTargets();
  if (totals.oshi !== want.oshi || totals.main !== want.main || totals.yell !== want.yell) {
    return blocked(
      'ZONE_TOTAL',
      `卡表張數不符（推し ${totals.oshi}/${want.oshi}、主牌組 ${totals.main}/${want.main}、`
      + `エール ${totals.yell}/${want.yell}），無法匯入`,
    );
  }

  if (!index) return blocked('CATALOG_LOADING', '卡片資料庫載入中，請稍候');

  const missing: string[] = [];
  for (const ref of cards) {
    const bucket = index.get(ref.cardNumber);
    if ((!bucket || bucket.length === 0) && !missing.includes(ref.cardNumber)) {
      missing.push(ref.cardNumber);
    }
  }
  if (missing.length > 0) {
    const suffix = missing.length > 1 ? ` 等 ${missing.length} 張卡` : '';
    return blocked('UNKNOWN_CARD', `本地卡片資料庫缺少 ${missing[0]}${suffix}，無法匯入`);
  }

  return { importable: true };
}

/** Deterministic representative among a card number's printings. Compared by
 *  code units rather than localeCompare so V8, Hermes and JSC agree. */
function firstById(entries: DeckCard[]): DeckCard {
  return entries.slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))[0];
}

function unresolvedCard(entries: DeckCard[], sourceVersion: string | null): DeckCard {
  const rep = firstById(entries);
  const card: DeckCard = {
    ...rep,
    id: `${rep.cardNumber}#${UNRESOLVED_PRINTING}`,
    printing: UNRESOLVED_PRINTING,
    printingLabel: '',
    unresolvedPrinting: true,
  };
  const version = (sourceVersion ?? '').trim();
  if (version) card.sourceVersion = version;
  return card;
}

/**
 * Resolve one source slot to a local card.
 *
 * Returns null only when the card NUMBER itself is unknown locally — the gate
 * rejects that case, so a null here never reaches a deck.
 *
 * A printing is preserved only when the source EXPLICITLY claims its token names
 * a collectible printing (`printingProven === true`) and that token identifies
 * exactly one of this card number's local printings. A token alone is not proof:
 * Deck Log publishes a rarity grade, and a grade that happens to spell the same
 * string as a local printing token — `SR`, or a set-code token the yuyu-tei
 * label produced — matches by coincidence, which would promote a grade into a
 * priced physical printing (DIC-1036). Everything short of explicit proof keeps
 * the exact cardNumber, zone and count and marks the printing unresolved rather
 * than substituting a version.
 */
export function resolveSlotCard(
  ref: DeckCardRef,
  index: Map<string, DeckCard[]>,
): DeckCard | null {
  const entries = index.get(ref.cardNumber);
  if (!entries || entries.length === 0) return null;

  if (ref.printingProven === true) {
    const wanted = normalizeVersion(ref.version ?? '');
    if (wanted) {
      const exact = entries.filter((e) => normalizeVersion(e.printing) === wanted);
      if (exact.length === 1) return exact[0];
    }
  }
  return unresolvedCard(entries, ref.version);
}

/** Add `qty` of `card` to a zone, or refuse. The gate has already rejected two
 *  rows for one cardNumber in one zone, so a collision here means two source
 *  rows the report presented as distinct collapsed onto ONE local card. Summing
 *  them would hide that behind a slot whose quantity still looks legal, which is
 *  how a duplicate previously became invisible — so it fails closed instead. */
function pushSlot(slots: DeckSlot[], card: DeckCard, qty: number): boolean {
  if (slots.some((s) => s.card.id === card.id || s.card.cardNumber === card.cardNumber)) {
    return false;
  }
  slots.push({ card, qty });
  return true;
}

/** Name built only from values the source published: event, then block, rank and
 *  player/oshi. Unknown parts are omitted, never replaced by a placeholder. */
export function importedDeckName(event: TournamentEvent, deck: DeckEntry): string {
  const eventName = (event?.nameZh || event?.name || '').trim();
  const player = (deck.playerName ?? '').trim();
  const oshi = (deck.oshi ?? '').trim();
  const who = player && oshi ? `${player}（${oshi}）` : player || oshi;

  const details = [
    deck.block ? `${deck.block} 組` : '',
    (deck.rankLabel ?? '').trim(),
    who,
  ].filter((part) => part.length > 0);

  if (eventName && details.length > 0) return `${eventName}｜${details.join('·')}`;
  if (eventName) return eventName;
  if (details.length > 0) return details.join('·');
  return deck.decklogCode ? `賽事牌組 ${deck.decklogCode}` : '賽事牌組';
}

/** Deterministic de-collision for repeat imports: the first copy keeps the plain
 *  name, later copies get an ascending suffix. The copies are independent decks;
 *  nothing is ever overwritten or merged. */
export function uniqueDeckName(base: string, existingNames: string[]): string {
  const taken = new Set(existingNames);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Build the draft for a NEW deck from a verified tournament deck.
 *
 * Returns null when the fail-closed gate rejects the deck, so a blocked deck can
 * never be imported even if a caller skipped the gate. Zones, card numbers and
 * quantities are copied exactly as the source published them; the editor's own
 * centralized rule validation is what judges the result.
 */
export function buildImportedDeck(
  event: TournamentEvent,
  deck: DeckEntry,
  catalog: DeckCard[] | Map<string, DeckCard[]>,
  existingNames: string[],
  importedAt: string,
): ImportedDeckDraft | null {
  const index = catalog instanceof Map ? catalog : buildCatalogIndex(catalog);
  if (!evaluateImport(deck, index).importable) return null;

  const zones: Record<DeckZone, DeckSlot[]> = { oshi: [], main: [], yell: [] };
  let unresolvedPrintings = 0;

  for (const ref of deck.cards) {
    const card = resolveSlotCard(ref, index);
    if (!card) return null;
    if (!pushSlot(zones[ref.zone], card, ref.count)) return null;
  }
  for (const zone of ZONES) {
    unresolvedPrintings += zones[zone].filter((s) => s.card.unresolvedPrinting).length;
  }

  return {
    name: uniqueDeckName(importedDeckName(event, deck), existingNames),
    oshi: zones.oshi,
    main: zones.main,
    yell: zones.yell,
    unresolvedPrintings,
    origin: {
      kind: 'tournament',
      eventId: event.eventId,
      eventName: event.nameZh || event.name,
      sourceDeckId: deck.deckId,
      decklogCode: deck.decklogCode ?? null,
      sourceUrl: deck.sourceUrl,
      importedAt,
    },
  };
}
