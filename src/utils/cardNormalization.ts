export type NormalizedCardCategory = 'oshi' | 'holomen' | 'support' | 'mascot' | 'yell';
export type NormalizedCardZone = 'oshi' | 'main' | 'yell';
export type NormalizedHolomenStage = 'debut' | '1st' | '2nd' | 'buzz' | 'spot';

export interface NormalizedCardIdentity {
  category: NormalizedCardCategory | null;
  zone: NormalizedCardZone | null;
  stage: NormalizedHolomenStage | null;
  categoryLabel: string | null;
  stageLabel: string | null;
  // Primary badge for compact UI slots (search list top-right corner). For
  // Holomen we prefer Bloom Level (Debut/1st/2nd/Buzz/Spot) because that's what
  // players actually distinguish — falling back to the "Holomen" category label
  // is what caused DIC-1141 (every hBP04 card looked identical). When the
  // canonical Bloom Level is missing, this stays null; the UI shows the
  // pending-data hint instead of an incorrect label.
  displayBadge: string | null;
  // True if the card is a Holomen whose Bloom Level we don't yet have. The UI
  // surfaces this as "Bloom 等級未取得" instead of collapsing to "Holomen".
  bloomLevelMissing: boolean;
  color: string | null;
  setCode: string | null;
  source: { cardType: string | null; stage: string | null; color: string | null };
}

const STAGE_LABELS: Record<NormalizedHolomenStage, string> = {
  debut: 'Debut', '1st': '1st', '2nd': '2nd', buzz: 'Buzz', spot: 'Spot',
};

// DIC-1141 CR follow-up: three colour palettes are painted on the card list
// and detail — Bloom Level, card category, and printing rarity. They MUST be
// mutually disjoint at the hex level so no colour ever silently means two
// different things (the original bug was rarity SR orange looking like a
// Bloom Level; the CR-blocker was category Holomen sharing rarity R blue).
// All three lists live here so the regression test can import a single source
// and prove the sets stay disjoint — a copy-paste in a screen file cannot
// drift them apart without the test flipping red.
export const BLOOM_LEVEL_COLORS: Record<NormalizedHolomenStage, string> = {
  debut: '#0ea5e9',
  '1st': '#22c55e',
  '2nd': '#a855f7',
  buzz: '#ef4444',
  spot: '#64748b',
};

export const CATEGORY_COLORS: Record<NormalizedCardCategory, string> = {
  oshi: '#f97316',
  // Was '#3b82f6' — collided with printing rarity R (see PRINTING_RARITY_COLORS
  // below). Moved to blue-800 so the Holomen category chip stays "Holomen-ish
  // blue" but is provably distinct from the rarity R palette entry.
  holomen: '#1e40af',
  support: '#14b8a6',
  mascot: '#eab308',
  yell: '#a3a3a3',
};

// Printing-rarity palette. Kept as the shared source of truth so the search
// list, the detail rarity chip and the DIC-1141 regression test all agree on
// the exact hex values, and any future edit is compared against the other two
// palettes automatically.
export const PRINTING_RARITY_COLORS: Record<string, string> = {
  N: '#8B4513',
  C: '#6b7280',
  U: '#10b981',
  R: '#3b82f6',
  SR: '#f59e0b',
};

function normalizeHex(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Assert that the three badge palettes (Bloom Level, category, printing rarity)
 * are pairwise disjoint by hex value. Called by the DIC-1141 regression test;
 * kept in this module so the palettes and the invariant travel together.
 */
export function findBadgePaletteCollisions(): Array<{ a: string; b: string; hex: string }> {
  const palettes: Array<{ name: string; values: string[] }> = [
    { name: 'BLOOM_LEVEL_COLORS', values: Object.values(BLOOM_LEVEL_COLORS).map(normalizeHex) },
    { name: 'CATEGORY_COLORS', values: Object.values(CATEGORY_COLORS).map(normalizeHex) },
    { name: 'PRINTING_RARITY_COLORS', values: Object.values(PRINTING_RARITY_COLORS).map(normalizeHex) },
  ];
  const collisions: Array<{ a: string; b: string; hex: string }> = [];
  for (let i = 0; i < palettes.length; i++) {
    for (let j = i + 1; j < palettes.length; j++) {
      const setA = new Set(palettes[i].values);
      for (const hex of palettes[j].values) {
        if (setA.has(hex)) collisions.push({ a: palettes[i].name, b: palettes[j].name, hex });
      }
    }
  }
  return collisions;
}

export function bloomLevelBadgeColor(stage: NormalizedHolomenStage | null): string | null {
  return stage ? BLOOM_LEVEL_COLORS[stage] : null;
}

export function categoryBadgeColor(category: NormalizedCardCategory | null): string | null {
  return category ? CATEGORY_COLORS[category] : null;
}

export function printingRarityColor(rarity: string | null | undefined): string | null {
  if (!rarity) return null;
  return PRINTING_RARITY_COLORS[rarity.toUpperCase()] ?? null;
}

// DIC-1192: card records reach the client with legacy or scraped colour
// tokens that were never added to i18n — the JP scraper writes '◇' for
// colourless (see cardCatalog.COLOR_TOKENS), and some cross-cost cards land
// as 'blue_red'. i18n.t() throws on missing keys (DIC-1085 intentionally
// keeps it strict so drift shows up in dev), so an unnormalised '◇' at
// SearchResultsScreen line 450 previously fail-closed the entire screen at
// 1440×900 / hBP04. Normalise here (never in the JSON — the scraper owns
// that pipeline) so the render only ever asks i18n for a whitelisted key.
// KNOWN_COLOR_KEYS is the source of truth both callers (searchCards and the
// defence-in-depth render guard in SearchResultsScreen) test against — the
// list must stay in sync with `color_*` keys in src/i18n/locales/{zh,ja}.
export const KNOWN_COLOR_KEYS: ReadonlySet<string> = new Set([
  'white', 'blue', 'green', 'red', 'purple', 'yellow', 'colorless', 'multicolor',
]);

// Normalise a raw color field into an array of whitelisted colour tokens.
// - `''` / null / undefined → `[]`
// - `'◇'` → `['colorless']`               (JP diamond marker)
// - `'blue_red'` → `['blue', 'red']`      (composite tokens split on _ / , / /)
// - `'PURPLE'` → `['purple']`             (case-insensitive)
// - anything unrecognised → dropped from the returned array AND emitted as a
//   `console.warn` so a real data-shape drift surfaces loudly instead of being
//   silently swallowed. PM ask for DIC-1192 QA rework was explicit about not
//   hiding data errors.
export function normalizeColorTokens(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed === '◇') return ['colorless'];
  const parts = trimmed.toLowerCase().split(/[_\/,\s]+/).filter(Boolean);
  const known: string[] = [];
  const unknown: string[] = [];
  for (const part of parts) {
    if (part === '◇') { if (!known.includes('colorless')) known.push('colorless'); continue; }
    if (KNOWN_COLOR_KEYS.has(part)) { if (!known.includes(part)) known.push(part); continue; }
    unknown.push(part);
  }
  if (unknown.length > 0 && typeof console !== 'undefined' && typeof console.warn === 'function') {
    console.warn(
      `[DIC-1192] Unknown color token(s) in card data — dropped from render: ${JSON.stringify(unknown)} (raw=${JSON.stringify(raw)}). ` +
      `Fix in the scraper / data pipeline; the render will not crash on this row.`,
    );
  }
  return known;
}

function clean(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function normalizeStage(value: unknown): NormalizedHolomenStage | null {
  const raw = clean(value)?.toLowerCase().replace(/\s+/g, '');
  if (!raw) return null;
  if (raw === 'debut' || raw === 'デビュー') return 'debut';
  if (raw === '1st' || raw === 'first' || raw === '１st') return '1st';
  if (raw === '2nd' || raw === 'second' || raw === '２nd') return '2nd';
  if (raw === 'buzz' || raw === 'buzzホロメン' || raw === 'buzzholomen') return 'buzz';
  if (raw === 'spot' || raw === 'スポット') return 'spot';
  return null;
}

function sourceStageOf(card: any): string | null {
  for (const source of [card?.skillsJp, card?.skillsZh, card]) {
    if (!source || typeof source !== 'object') continue;
    for (const key of ['bloomLevel', 'bloom_level', 'stage', 'grade']) {
      const value = clean(source[key]);
      if (value) return value;
    }
  }
  return null;
}

export function normalizeCardIdentity(card: any): NormalizedCardIdentity {
  const cardNumber = clean(card?.cardNumber ?? card?.id) || '';
  const sourceCardType = clean(card?.skillsJp?.cardType) ?? clean(card?.type) ?? clean(card?.skillsZh?.cardType);
  const sourceStage = sourceStageOf(card);
  const sourceColor = clean(card?.skillsJp?.color) ?? clean(card?.color) ?? clean(card?.skillsZh?.color);
  const type = sourceCardType?.toLowerCase() ?? '';

  let category: NormalizedCardCategory | null = null;
  if (/^hy\d/i.test(cardNumber) || type.includes('エール') || type.includes('yell') || type.includes('cheer') || type.includes('應援')) category = 'yell';
  else if (type.includes('推し') || type.includes('oshi') || type.includes('主推')) category = 'oshi';
  else if (type.includes('マスコット') || type.includes('mascot') || type.includes('吉祥物')) category = 'mascot';
  else if (type.includes('サポート') || type.includes('support') || type.includes('支援')) category = 'support';
  else if (type.includes('ホロメン') || type.includes('ホロ��ン') || type.includes('holomen') || type.includes('成員')) category = 'holomen';

  let stage = normalizeStage(sourceStage);
  if (category === 'holomen' && type.includes('buzz')) stage = 'buzz';
  if (category !== 'holomen') stage = null;

  const categoryLabel = category === 'oshi' ? 'Oshi'
    : category === 'holomen' ? 'Holomen'
      : category === 'support' ? 'Support'
        : category === 'mascot' ? 'Mascot'
          : category === 'yell' ? 'Yell' : null;
  const stageLabel = stage ? STAGE_LABELS[stage] : null;

  // DIC-1141: for Holomen, the primary badge MUST be the Bloom Level. Never
  // fall back to the category label — that's what caused every hBP04-026~029
  // card to display "Holomen" and hid Debut / 1st / 2nd from the player. Non-
  // holomen cards keep the category label as the primary badge since Bloom
  // Level does not apply to them.
  const displayBadge = category === 'holomen'
    ? stageLabel
    : categoryLabel;
  const bloomLevelMissing = category === 'holomen' && !stage;

  return {
    category,
    zone: category === 'oshi' ? 'oshi' : category === 'yell' ? 'yell' : category ? 'main' : null,
    stage,
    categoryLabel,
    stageLabel,
    displayBadge,
    bloomLevelMissing,
    color: sourceColor,
    setCode: cardNumber.includes('-') ? cardNumber.split('-')[0] : null,
    source: { cardType: sourceCardType, stage: sourceStage, color: sourceColor },
  };
}

export function hasDisplayableSubscriberStats(ytStats: any, now = Date.now()): boolean {
  if (!ytStats || typeof ytStats !== 'object') return false;
  if (!Number.isInteger(ytStats.subscriberCount) || ytStats.subscriberCount < 0) return false;
  if (!/^UC[\w-]{20,}$/.test(String(ytStats.channelId || ''))) return false;
  if (ytStats.source !== 'youtube_about_ssr') return false;
  if (ytStats.parser !== 'ytInitialData.aboutChannelViewModel/v1') return false;
  const fetchedAt = Date.parse(String(ytStats.fetchedAt || ''));
  if (!Number.isFinite(fetchedAt)) return false;
  return now - fetchedAt <= 72 * 60 * 60 * 1000 && fetchedAt <= now + 5 * 60 * 1000;
}

export function isValidatedTrendPrediction(trend: any, card: any): boolean {
  if (!trend || !card || !['up', 'down', 'stable'].includes(trend.trend)) return false;
  if (!Number.isFinite(trend.score) || !Number.isFinite(trend.confidence)) return false;
  if (trend.trend === 'up' && trend.score <= 0.15) return false;
  if (trend.trend === 'down' && trend.score >= -0.15) return false;
  if (trend.trend === 'stable' && Math.abs(trend.score) > 0.15) return false;
  if (!Number.isInteger(trend.dataPoints) || trend.dataPoints < 3) return false;
  if (!Array.isArray(trend.timestamps) || new Set(trend.timestamps).size < 3) return false;
  if (trend.cardNumber !== card.cardNumber || !trend.printing || trend.printing !== card.printing) return false;
  if (!trend.currency || trend.currency !== card.currency) return false;
  return trend.timestamps.every((value: unknown) => Number.isFinite(Date.parse(String(value))));
}
