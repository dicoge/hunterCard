// hOCG deck-construction rules engine — pure, framework-free so it can be unit
// tested with plain node. The concrete rule numbers are NOT hardcoded here: they
// are loaded from data/deck-rules.json (the single authoritative source) below.
// Anything the current card dataset cannot verify (e.g. Bloom/Debut warnings,
// which need Bloom-level data the dataset does not carry) is intentionally NOT
// emitted, rather than guessed — an unconfirmed rule must not fire a false
// Error/Warning.

import rawRules from '../../data/deck-rules.json';

export type DeckZone = 'oshi' | 'main' | 'yell';

// A card as the editor needs it. Kept minimal on purpose — this mirrors the
// fields actually present in data/database.json entries.
export interface DeckCard {
  id: string;
  cardNumber: string;
  name: string;
  /** printing/version identity — the card's rarity string acts as the version key */
  rarity: string;
  series: string;
  /** raw card-type string as stored (JP or EN); classification handles both */
  type?: string;
  cardTypeJp?: string;
  imageUrl?: string;
  /** official card-list printing path (`<folder>/<file>.png`) — the exact
   *  printing identity, used to match an imported source slot to this entry */
  printingPath?: string;
  /** set when the slot came from an import whose exact printing has no entry in
   *  the local card catalog. The source-supplied cardNumber/version are kept
   *  verbatim; nothing is substituted, so price and catalog lookups fail closed. */
  unresolvedPrinting?: boolean;
}

export interface DeckSlot {
  card: DeckCard;
  qty: number;
}

export interface Deck {
  id: string;
  name: string;
  oshi: DeckSlot[];
  main: DeckSlot[];
  yell: DeckSlot[];
  updatedAt: string;
}

export interface DeckRulesConfig {
  version: string;
  source: string;
  zones: Record<DeckZone, { label: string; exactCount: number }>;
  totalCards: number;
  identity: { field: string };
  copyLimits: { mainDefault: number; yellUnlimited: boolean };
  restrictedCards: Record<string, number>;
  unlimitedCopyCards: { cardNumbers: string[] };
}

// Recursively drop the human-readable `_comment` annotations the JSON spec file
// carries, so the loaded config matches DeckRulesConfig exactly.
function stripComments<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => stripComments(v)) as unknown as T;
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key === '_comment') continue;
      out[key] = stripComments(v);
    }
    return out as T;
  }
  return value;
}

// Data-driven rule configuration. Single source of truth: data/deck-rules.json
// (DIC-943 official rule matrix). The engine below reads ONLY from RULES, and
// RULES is loaded from the JSON file at import time — the numbers are never
// hardcoded in this module. Only rules the current card dataset can actually
// verify are enabled in that file; unconfirmed rules (e.g. Bloom/Debut warnings
// that need Bloom-level data the dataset does not carry) are intentionally
// omitted there so they are NOT baked in as false positives.
export const RULES: DeckRulesConfig = stripComments(
  rawRules as unknown as DeckRulesConfig,
);

export type ValidationLevel = 'error' | 'warning';

export interface ValidationIssue {
  code: string;
  level: ValidationLevel;
  zone?: DeckZone;
  cardNumber?: string;
  message: string;
}

// ── Card classification ───────────────────────────────────────────────────
// The dataset stores card types in several shapes: top-level `type` and
// `skillsJp.cardType`, in both Japanese and English variants. We normalise into
// the three zone-eligibility buckets the rules care about. We deliberately do
// NOT attempt Bloom/Debut sub-classification here because the dataset does not
// carry Bloom-level data (see deck-rules.json note).

function normType(card: DeckCard): string {
  return `${card.cardTypeJp || ''} ${card.type || ''}`.toLowerCase();
}

export function isOshiCard(card: DeckCard): boolean {
  const t = normType(card);
  // 推しホロメン / OshiHolomen. Must check before plain holomen since it is a
  // superstring of "ホロメン".
  return t.includes('推し') || t.includes('oshi');
}

export function isYellCard(card: DeckCard): boolean {
  const t = normType(card);
  return t.includes('エール') || t.includes('yell') || t.includes('cheer');
}

export function isMainDeckCard(card: DeckCard): boolean {
  // Main deck holds Holomen (non-oshi) and Support cards.
  if (isOshiCard(card) || isYellCard(card)) return false;
  const t = normType(card);
  const isHolomen = t.includes('ホロメン') || t.includes('holomen') || t.includes('buzz');
  const isSupport = t.includes('サポート') || t.includes('support');
  return isHolomen || isSupport;
}

export function eligibleZone(card: DeckCard): DeckZone | null {
  if (isOshiCard(card)) return 'oshi';
  if (isYellCard(card)) return 'yell';
  if (isMainDeckCard(card)) return 'main';
  return null;
}

// ── Aggregation helpers ────────────────────────────────────────────────────

export function zoneCount(slots: DeckSlot[]): number {
  return slots.reduce((sum, s) => sum + s.qty, 0);
}

/** Copies per cardNumber within a zone (versions of the same number combine). */
export function copiesByCardNumber(slots: DeckSlot[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const s of slots) {
    out[s.card.cardNumber] = (out[s.card.cardNumber] || 0) + s.qty;
  }
  return out;
}

function copyLimitFor(cardNumber: string): number {
  if (cardNumber in RULES.restrictedCards) return RULES.restrictedCards[cardNumber];
  if (RULES.unlimitedCopyCards.cardNumbers.includes(cardNumber)) return Infinity;
  return RULES.copyLimits.mainDefault;
}

// ── Validation matrix (DIC-943 §四) ────────────────────────────────────────

export function validateDeck(deck: Deck): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const oshiN = zoneCount(deck.oshi);
  const mainN = zoneCount(deck.main);
  const yellN = zoneCount(deck.yell);

  // ERR_OSHI_QTY — oshi zone must hold exactly 1 card.
  if (oshiN !== RULES.zones.oshi.exactCount) {
    issues.push({
      code: 'ERR_OSHI_QTY', level: 'error', zone: 'oshi',
      message: `推しホロメン牌組必須恰好為 ${RULES.zones.oshi.exactCount} 張（目前：${oshiN} 張）。`,
    });
  }
  // ERR_OSHI_TYPE — oshi zone accepts only 推しホロメン cards.
  for (const s of deck.oshi) {
    if (!isOshiCard(s.card)) {
      issues.push({
        code: 'ERR_OSHI_TYPE', level: 'error', zone: 'oshi', cardNumber: s.card.cardNumber,
        message: `推し區域僅能放置「推しホロメン」卡片（${s.card.cardNumber}）。`,
      });
    }
  }
  // ERR_MAIN_QTY — main deck must be exactly 50.
  if (mainN !== RULES.zones.main.exactCount) {
    issues.push({
      code: 'ERR_MAIN_QTY', level: 'error', zone: 'main',
      message: `主牌組張數必須恰好為 ${RULES.zones.main.exactCount} 張（目前：${mainN} 張）。`,
    });
  }
  // ERR_MAIN_TYPE — main deck holds only Holomen / Support.
  for (const s of deck.main) {
    if (!isMainDeckCard(s.card)) {
      issues.push({
        code: 'ERR_MAIN_TYPE', level: 'error', zone: 'main', cardNumber: s.card.cardNumber,
        message: `主牌組僅能包含 Holomen 與 Support 卡片（${s.card.cardNumber}）。`,
      });
    }
  }
  // ERR_CHEER_QTY — yell deck must be exactly 20.
  if (yellN !== RULES.zones.yell.exactCount) {
    issues.push({
      code: 'ERR_CHEER_QTY', level: 'error', zone: 'yell',
      message: `エール牌組張數必須恰好為 ${RULES.zones.yell.exactCount} 張（目前：${yellN} 張）。`,
    });
  }
  // ERR_CHEER_TYPE — yell deck accepts only エール cards.
  for (const s of deck.yell) {
    if (!isYellCard(s.card)) {
      issues.push({
        code: 'ERR_CHEER_TYPE', level: 'error', zone: 'yell', cardNumber: s.card.cardNumber,
        message: `エール牌組僅能包含 エール 卡片（${s.card.cardNumber}）。`,
      });
    }
  }
  // ERR_CARD_LIMIT — main deck same-number copy limit (default 4); yell is
  // unlimited per rules. Restricted / unlimited cards use their override limit.
  const mainCopies = copiesByCardNumber(deck.main);
  for (const [cardNumber, count] of Object.entries(mainCopies)) {
    const limit = copyLimitFor(cardNumber);
    if (count > limit) {
      const code = cardNumber in RULES.restrictedCards ? 'ERR_RESTRICTED' : 'ERR_CARD_LIMIT';
      const message = cardNumber in RULES.restrictedCards
        ? `[${cardNumber}] 為官方限制卡，牌組內最多只能放置 ${limit} 張（目前 ${count} 張）。`
        : `卡號 [${cardNumber}] 超過張數限制（上限 ${limit} 張，目前 ${count} 張）。`;
      issues.push({ code, level: 'error', zone: 'main', cardNumber, message });
    }
  }
  // Restricted cards may also appear in the oshi zone — enforce there too.
  const oshiCopies = copiesByCardNumber(deck.oshi);
  for (const [cardNumber, count] of Object.entries(oshiCopies)) {
    if (cardNumber in RULES.restrictedCards && count > RULES.restrictedCards[cardNumber]) {
      issues.push({
        code: 'ERR_RESTRICTED', level: 'error', zone: 'oshi', cardNumber,
        message: `[${cardNumber}] 為官方限制卡，牌組內最多只能放置 ${RULES.restrictedCards[cardNumber]} 張（目前 ${count} 張）。`,
      });
    }
  }

  return issues;
}

export function isDeckLegal(deck: Deck): boolean {
  return validateDeck(deck).every((i) => i.level !== 'error');
}

// ── Live stats for the editor header ───────────────────────────────────────

export interface DeckStats {
  oshi: number; main: number; yell: number; total: number;
  oshiTarget: number; mainTarget: number; yellTarget: number; totalTarget: number;
}

export function deckStats(deck: Deck): DeckStats {
  const oshi = zoneCount(deck.oshi);
  const main = zoneCount(deck.main);
  const yell = zoneCount(deck.yell);
  return {
    oshi, main, yell, total: oshi + main + yell,
    oshiTarget: RULES.zones.oshi.exactCount,
    mainTarget: RULES.zones.main.exactCount,
    yellTarget: RULES.zones.yell.exactCount,
    totalTarget: RULES.totalCards,
  };
}

// ── Version-precise price resolution (DIC-945 #6, DIC-944 §C) ───────────────
// A price counts ONLY when it matches the same cardNumber AND the same version
// (rarity). No cross-version, no highest-price, no same-name fallback — ever.
// When no exact match exists the resolver returns NO_EXACT_PRICE, and callers
// must display "無精確版本價格" and exclude the item from any total.

export interface PriceRecord {
  cardNumber: string;
  /** version/rarity this price applies to; empty string means "version unknown" */
  version: string;
  price: number;
  currency: string;
  source: string;
  timestamp: string;
}

export type PriceResolution =
  | { status: 'ok'; price: number; currency: string; source: string; timestamp: string }
  | { status: 'NO_EXACT_PRICE' };

export function resolveExactPrice(
  cardNumber: string,
  version: string,
  records: PriceRecord[],
): PriceResolution {
  const match = records.find(
    (r) => r.cardNumber === cardNumber && r.version === version && r.version !== '',
  );
  if (!match || typeof match.price !== 'number') return { status: 'NO_EXACT_PRICE' };
  return {
    status: 'ok', price: match.price, currency: match.currency,
    source: match.source, timestamp: match.timestamp,
  };
}

// ── Collection gap analysis (DIC-945 #5/#6, DIC-944 §C) ─────────────────────

export interface GapRow {
  cardNumber: string;
  version: string;
  name: string;
  required: number;
  owned: number;
  missing: number;
  price: PriceResolution;
  /** missing * unit price when an exact price exists; undefined otherwise */
  subtotal?: number;
}

/** One currency's isolated subtotal. Prices in different currencies are NEVER
 * added together (DIC-978 #5/#8 currency separation) — each currency keeps its
 * own running subtotal and "data as of" marker. */
export interface CurrencySubtotal {
  currency: string;
  total: number;
  /** oldest price timestamp among this currency's priced rows */
  dataAsOf: string | null;
}

export interface GapSummary {
  rows: GapRow[];
  /** primary currency = the first priced row's currency; null when nothing priced */
  currency: string | null;
  /** subtotal for the PRIMARY currency only — never a cross-currency sum */
  total: number;
  /** per-currency isolated subtotals, in first-seen order */
  subtotals: CurrencySubtotal[];
  /** rows with missing>0 that have no exact-version price → excluded from total */
  unpriced: GapRow[];
  /** oldest price timestamp among PRIMARY-currency priced rows — the "data as of" marker */
  dataAsOf: string | null;
}

// Normalize a printing/version identity so the global collection inventory and
// the deck requirement collapse to the SAME key when they mean the same
// printing (DIC-978 #2). Rarity codes reach us from several surfaces (deck
// slots, hand entry, a future scanner) with incidental case / width / spacing
// differences — ' sr ', 'Sr', full-width 'ＳＲ' all denote the R-parallel SR.
// NFKC folds full-width forms, whitespace is collapsed, and the code is
// upper-cased so those variants share one owned bucket. This never crosses two
// genuinely distinct rarities (they differ by more than case/spacing), so it
// stays faithful to the "exact version" contract.
export function normalizeVersion(version: string): string {
  return (version ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}

/** ownershipKey = cardNumber|normalizedVersion (DIC-978 #2). cardNumber is
 * kept exact (identity is case-sensitive) but stray surrounding whitespace is
 * trimmed so a hand-typed entry keys the same bucket as the dataset value. */
export function ownershipKey(cardNumber: string, version: string): string {
  return `${(cardNumber ?? '').trim()}|${normalizeVersion(version)}`;
}

export function computeGap(
  deck: Deck,
  owned: Record<string, number>,
  priceRecords: PriceRecord[],
): GapSummary {
  // Requirements combine oshi + main + yell per (cardNumber, version).
  const req: Record<string, { card: DeckCard; qty: number }> = {};
  for (const slots of [deck.oshi, deck.main, deck.yell]) {
    for (const s of slots) {
      const key = ownershipKey(s.card.cardNumber, s.card.rarity);
      if (!req[key]) req[key] = { card: s.card, qty: 0 };
      req[key].qty += s.qty;
    }
  }

  const rows: GapRow[] = [];
  const unpriced: GapRow[] = [];
  // Currency separation: each currency accumulates in its own bucket so a
  // JPY price is never summed into a USD (or any other) total.
  const byCurrency = new Map<string, { total: number; dataAsOf: string | null }>();
  let currency: string | null = null;

  for (const [key, { card, qty }] of Object.entries(req)) {
    // `key` is already the normalized ownershipKey; the collection is stored
    // under the same normalized key, so a direct lookup matches (DIC-978 #3).
    const have = owned[key] ?? 0;
    const missing = Math.max(0, qty - have);
    const price = resolveExactPrice(card.cardNumber, card.rarity, priceRecords);
    const row: GapRow = {
      cardNumber: card.cardNumber, version: card.rarity, name: card.name,
      required: qty, owned: have, missing, price,
    };
    if (missing > 0) {
      if (price.status === 'ok') {
        row.subtotal = price.price * missing;
        currency = currency ?? price.currency;
        const bucket = byCurrency.get(price.currency) ?? { total: 0, dataAsOf: null };
        bucket.total += row.subtotal;
        if (!bucket.dataAsOf || price.timestamp < bucket.dataAsOf) bucket.dataAsOf = price.timestamp;
        byCurrency.set(price.currency, bucket);
      } else {
        unpriced.push(row);
      }
    }
    rows.push(row);
  }

  const subtotals: CurrencySubtotal[] = Array.from(byCurrency.entries()).map(
    ([cur, b]) => ({ currency: cur, total: b.total, dataAsOf: b.dataAsOf }),
  );
  const primary = currency ? byCurrency.get(currency) : undefined;

  return {
    rows,
    currency,
    total: primary?.total ?? 0,
    subtotals,
    unpriced,
    dataAsOf: primary?.dataAsOf ?? null,
  };
}
