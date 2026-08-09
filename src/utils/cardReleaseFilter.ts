/**
 * Store MVP fail-closed field filter (DIC-908 / QA DIC-915).
 *
 * The data layer (database.json / recognize-card response) intentionally still
 * carries the advanced fields — buy-back price, price history, YouTube stats —
 * because full web / non-MVP builds render them. But those fields must NEVER
 * cross the mapping boundary into a Store MVP session, search result, or export:
 * hiding them at render time is not enough (QA flagged the field passthrough).
 *
 * This is the single choke point every card mapper routes through. It is kept
 * free of react-native / expo imports so it can be unit-verified in plain Node
 * (see scripts/test-store-mvp-field-strip.mjs); callers pass the resolved flags.
 */
export interface ReleaseCardFlags {
  /** 店家收購價 / buyPrice — includes per-version prices[].buyPrice and buyPriceHistory. */
  buyPrice: boolean;
  /** 價格歷史（漲跌判斷來源）— priceHistory. */
  trendPrediction: boolean;
  /** YouTube 成員數據 — ytStats. */
  ytStats: boolean;
}

/**
 * Return a shallow clone of `card` with every disabled advanced field removed.
 * Fail-closed: the keys are deleted (not nulled) so a Store MVP object genuinely
 * does not retain them. Sale reference price (sellPrice / prices[].sellPrice) is
 * always preserved — it is a must-show field.
 */
export function stripDisabledCardFields<T extends Record<string, any>>(
  card: T,
  flags: ReleaseCardFlags,
): T {
  const out: Record<string, any> = { ...card };

  if (!flags.buyPrice) {
    delete out.buyPrice;
    // buyPriceHistory is buy-back history — same feature group as buyPrice.
    delete out.buyPriceHistory;
    if (Array.isArray(out.prices)) {
      out.prices = out.prices.map((p: any) => {
        if (p && typeof p === 'object' && 'buyPrice' in p) {
          const { buyPrice: _drop, ...rest } = p;
          return rest;
        }
        return p;
      });
    }
  }

  if (!flags.trendPrediction) {
    delete out.priceHistory;
  }

  if (!flags.ytStats) {
    delete out.ytStats;
  }

  return out as T;
}
