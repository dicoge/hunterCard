export type ValidatedPriceDirection = 'up' | 'down' | 'flat';

export interface PriceHistoryMeta {
  cardNumber?: string;
  printing?: string;
  currency?: string;
}

export interface ValidatedPriceTrend {
  direction: ValidatedPriceDirection;
  percentage: number;
  priorAverage: number;
  recentAverage: number;
  pointCount: number;
}

interface ValidatedPriceTrendInput {
  priceHistory: Record<string, number> | null | undefined;
  meta: PriceHistoryMeta | null | undefined;
  cardNumber: string;
  printing: string;
  currency: string;
}

const DAY_MS = 86_400_000;

export function computeValidatedPriceTrend(input: ValidatedPriceTrendInput): ValidatedPriceTrend | null {
  if (input.meta?.cardNumber !== input.cardNumber
    || input.meta?.printing !== input.printing
    || input.meta?.currency !== input.currency) return null;

  const points = Object.entries(input.priceHistory || {})
    .map(([timestamp, rawPrice]) => ({ timestamp, time: Date.parse(timestamp), price: Number(rawPrice) }))
    .filter((point) => Number.isFinite(point.time) && Number.isFinite(point.price) && point.price > 0)
    .sort((a, b) => a.time - b.time);
  if (points.length < 3 || new Set(points.map((point) => point.time)).size < 3) return null;

  const latestTime = points[points.length - 1].time;
  const recent = points.filter((point) => {
    const offset = (latestTime - point.time) / DAY_MS;
    return offset >= 0 && offset < 7;
  });
  const prior = points.filter((point) => {
    const offset = (latestTime - point.time) / DAY_MS;
    return offset >= 7 && offset < 14;
  });
  if (recent.length === 0 || prior.length === 0) return null;

  const average = (values: typeof points) => values.reduce((sum, point) => sum + point.price, 0) / values.length;
  const recentAverage = average(recent);
  const priorAverage = average(prior);
  const percentage = ((recentAverage - priorAverage) / priorAverage) * 100;
  const direction = percentage >= 3 ? 'up' : percentage <= -3 ? 'down' : 'flat';

  return { direction, percentage, priorAverage, recentAverage, pointCount: points.length };
}
