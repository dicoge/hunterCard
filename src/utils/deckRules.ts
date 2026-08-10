// hOCG deck-construction rules engine — pure, framework-free so it can be unit
// tested with plain node. Source of truth for the rules is DIC-943; the concrete
// numbers live in data/deck-rules.json, not hardcoded here. Anything the current
// card dataset cannot verify (e.g. Bloom/Debut warnings, which need Bloom-level
// data the dataset does not carry) is intentionally NOT emitted, rather than
// guessed — an unconfirmed rule must not fire a false Error/Warning.

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

// Data-driven rule configuration. Source of truth: DIC-943 official rule matrix.
// This is the ONE place to edit rule numbers — the engine below reads only from
// it, never hardcoding values inline. Only rules the current card dataset can
// actually verify are enabled; unconfirmed rules (e.g. Bloom/Debut warnings that
// need Bloom-level data the dataset does not carry) are intentionally omitted so
// they are NOT hardcoded as false positives. See data/deck-rules.json for the
// same values kept as a human-readable spec artifact.
export const RULES: DeckRulesConfig = {
  version: '2026-08-10',
  source: 'DIC-943',
  zones: {
    oshi: { label: '推しホロメン', exactCount: 1 },
    main: { label: '主牌組', exactCount: 50 },
    yell: { label: 'エール', exactCount: 20 },
  },
  totalCards: 71,
  identity: { field: 'cardNumber' },
  copyLimits: { mainDefault: 4, yellUnlimited: true },
  // cardNumber -> max copies. Official restricted cards (e.g. hBP07-101
  // restricted to 1 from 2026-06-19).
  restrictedCards: { 'hBP07-101': 1 },
  // Cards printed with 'このカードはデッキに何枚でも入れられる' — exempt from the
  // 4-copy limit. Populate cardNumbers as confirmed.
  unlimitedCopyCards: { cardNumbers: [] },
};

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

export interface GapSummary {
  rows: GapRow[];
  currency: string | null;
  total: number;
  /** rows with missing>0 that have no exact-version price → excluded from total */
  unpriced: GapRow[];
  /** oldest price timestamp across priced rows — the "data as of" marker */
  dataAsOf: string | null;
}

/** ownershipKey = cardNumber|version */
export function ownershipKey(cardNumber: string, version: string): string {
  return `${cardNumber}|${version}`;
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
  let total = 0;
  let currency: string | null = null;
  let dataAsOf: string | null = null;

  for (const [key, { card, qty }] of Object.entries(req)) {
    const have = owned[key] || 0;
    const missing = Math.max(0, qty - have);
    const price = resolveExactPrice(card.cardNumber, card.rarity, priceRecords);
    const row: GapRow = {
      cardNumber: card.cardNumber, version: card.rarity, name: card.name,
      required: qty, owned: have, missing, price,
    };
    if (missing > 0) {
      if (price.status === 'ok') {
        row.subtotal = price.price * missing;
        total += row.subtotal;
        currency = currency ?? price.currency;
        if (!dataAsOf || price.timestamp < dataAsOf) dataAsOf = price.timestamp;
      } else {
        unpriced.push(row);
      }
    }
    rows.push(row);
  }

  return { rows, currency, total, unpriced, dataAsOf };
}
