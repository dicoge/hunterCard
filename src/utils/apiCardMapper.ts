import type { CardInfo } from '../services/cardRecognition';

/**
 * Pure mapper: raw API card payload (recognize-card `fmt()` shape) → CardInfo.
 *
 * This is the SINGLE mapper used by every live scan call site (candidates list
 * and API-success), so the scan → CardDetail path always carries the market
 * fields MarketDataPanel needs.
 *
 * buyPrice / priceHistory / ytStats are透傳（pass-through）of the already
 * version-aligned values the API produced. `?? null` preserves a real 0 buy
 * price (nullish only catches null/undefined). 對不到 → null. 嚴禁在此做
 * 卡號 fallback / 跨版本 Math.max（DIC-361 / DIC-856）。
 *
 * Kept free of React / react-native / browser imports (the CardInfo import is
 * type-only and stripped at runtime) so it can be unit-verified in plain Node.
 */
export function mapApiCardToCardInfo(raw: any): CardInfo {
  return {
    id: raw.cardNumber,
    name: raw.name || '',
    cardNumber: raw.cardNumber,
    type: '',
    rarity: raw.rarity || '',
    series: raw.series || '',
    sellPrice: raw.sellPrice != null ? raw.sellPrice : null,
    buyPrice: raw.buyPrice ?? null,
    yuyuName: '',
    color: '',
    imageUrl: raw.imageUrl || '',
    prices: raw.prices || [],
    priceHistory: raw.priceHistory || {},
    ytStats: raw.ytStats ?? null,
  };
}
