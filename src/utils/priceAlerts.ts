// Desired-purchase-price interval alerts for a deck's missing cards (DIC-1023).
//
// Framework-free on purpose: the same module backs the editor UI, the local
// status display, the serverless alert evaluator and the Node regressions, so
// the client and the push pipeline can never disagree about what "in range"
// means.
//
// Identity is the SAME source-proven (cardNumber, printing) pair the deck editor,
// ownership and the gap estimate already use (DIC-1013). A card-number-only
// alert is not representable here — `printing` is required — so a legacy
// watchlist entry can never be silently promoted into an exact-version alert.
//
// The price compared is always the player's reference SELL price of that exact
// printing. A store's buy (acquisition) price is a different commercial quantity
// and never reaches this module.

import { normalizePrinting } from './printingIdentity';

/** Upper bound on a desired price. Guards the input and the API against
 * absurd/overflow values while staying far above any real listing. */
export const MAX_ALERT_PRICE = 100_000_000;

/** A user's desired purchase interval for one exact printing. */
export interface PriceAlert {
  cardNumber: string;
  /** normalized source-proven printing token — never empty */
  printing: string;
  /** the source's own listing label for that printing (display/provenance) */
  printingLabel: string;
  name: string;
  /** currency of BOTH bounds; compared only against a price in this currency */
  currency: string;
  /** optional lower bound; null means "any price at or below the upper bound" */
  lowerPrice: number | null;
  /** required upper bound — the most the user is willing to pay */
  upperPrice: number;
  createdAt: string;
  updatedAt: string;
}

/** `cardNumber|NORMALIZED-PRINTING` — same shape as the ownership key so an
 * alert, a deck slot and a collection entry all address the same printing. */
export function priceAlertKey(cardNumber: string, printing: string): string {
  return `${(cardNumber ?? '').trim()}|${normalizePrinting(printing)}`;
}

// ── Input validation ────────────────────────────────────────────────────────

export type PriceFieldError = 'NOT_INTEGER' | 'TOO_LARGE';
export type IntervalError = PriceFieldError | 'UPPER_REQUIRED' | 'LOWER_ABOVE_UPPER';

export const INTERVAL_ERROR_MESSAGES: Record<IntervalError, string> = {
  NOT_INTEGER: '請輸入 0 或以上的整數金額（不接受負數或小數）。',
  TOO_LARGE: `金額過大，請輸入 ${MAX_ALERT_PRICE.toLocaleString('en-US')} 以下的整數。`,
  UPPER_REQUIRED: '請填寫期望入手價「上限」。',
  LOWER_ABOVE_UPPER: '下限不可高於上限。',
};

export type PriceFieldResult =
  | { ok: true; value: number | null }
  | { ok: false; code: PriceFieldError };

/** Parse one desired-price field. Empty → null (field omitted). Full-width
 * digits and thousands separators are folded first so a pasted `１,２００`
 * is not rejected as garbage; everything else must be a plain non-negative
 * integer. */
export function parsePriceField(raw: string | number | null | undefined): PriceFieldResult {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  const text = String(raw).normalize('NFKC').replace(/[\s,]/g, '');
  if (text === '') return { ok: true, value: null };
  if (!/^\d+$/.test(text)) return { ok: false, code: 'NOT_INTEGER' };
  const value = Number(text);
  if (!Number.isSafeInteger(value)) return { ok: false, code: 'TOO_LARGE' };
  if (value > MAX_ALERT_PRICE) return { ok: false, code: 'TOO_LARGE' };
  return { ok: true, value };
}

export type IntervalResult =
  | { ok: true; lowerPrice: number | null; upperPrice: number }
  | { ok: false; code: IntervalError; message: string };

function intervalError(code: IntervalError): IntervalResult {
  return { ok: false, code, message: INTERVAL_ERROR_MESSAGES[code] };
}

/** The one interval rule: upper required, both non-negative integers,
 * lower <= upper. Shared by the editor and the API so a payload the UI would
 * have rejected cannot be smuggled in over HTTP. */
export function validateInterval(
  lowerRaw: string | number | null | undefined,
  upperRaw: string | number | null | undefined,
): IntervalResult {
  const lower = parsePriceField(lowerRaw);
  if (!lower.ok) return intervalError(lower.code);
  const upper = parsePriceField(upperRaw);
  if (!upper.ok) return intervalError(upper.code);
  if (upper.value === null) return intervalError('UPPER_REQUIRED');
  if (lower.value !== null && lower.value > upper.value) return intervalError('LOWER_ABOVE_UPPER');
  return { ok: true, lowerPrice: lower.value, upperPrice: upper.value };
}

// ── Interval evaluation ─────────────────────────────────────────────────────

/** Inclusive on both ends. An omitted lower bound means "no floor", so any
 * price at or below the upper bound qualifies. */
export function isPriceInInterval(
  price: number | null | undefined,
  lowerPrice: number | null,
  upperPrice: number,
): boolean {
  if (typeof price !== 'number' || !Number.isFinite(price)) return false;
  if (price > upperPrice) return false;
  if (lowerPrice !== null && price < lowerPrice) return false;
  return true;
}

/** Exact reference SELL price of one printing, in one currency. */
export interface AlertPrice {
  price: number;
  currency: string;
}

export type AlertStatus =
  /** no exact-version sell price for this printing → nothing to compare */
  | 'UNPRICED'
  /** the only price we have is in another currency → never compared */
  | 'CURRENCY_MISMATCH'
  | 'IN_RANGE'
  /** below the user's lower bound — outside the interval, does NOT fire */
  | 'BELOW_RANGE'
  | 'ABOVE_RANGE';

export function evaluateAlertStatus(
  alert: Pick<PriceAlert, 'currency' | 'lowerPrice' | 'upperPrice'>,
  price: AlertPrice | null | undefined,
): AlertStatus {
  if (!price || typeof price.price !== 'number') return 'UNPRICED';
  if (price.currency !== alert.currency) return 'CURRENCY_MISMATCH';
  if (isPriceInInterval(price.price, alert.lowerPrice, alert.upperPrice)) return 'IN_RANGE';
  return price.price > alert.upperPrice ? 'ABOVE_RANGE' : 'BELOW_RANGE';
}

export const ALERT_STATUS_LABELS: Record<AlertStatus, string> = {
  UNPRICED: '無精確版本價格',
  CURRENCY_MISMATCH: '幣別不符，未比對',
  IN_RANGE: '已進入期望區間',
  BELOW_RANGE: '低於期望下限',
  ABOVE_RANGE: '高於期望上限',
};

// ── Dedupe / re-arm ─────────────────────────────────────────────────────────
//
// An alert is "armed" while it is waiting to fire. Entering the interval fires
// once and disarms it; the alert only re-arms when the price LEAVES the interval
// again, or when the user explicitly edits it (the editor drops the state
// record). Without this a card sitting inside the interval would notify on every
// scheduler run.

export interface AlertArmState {
  armed: boolean;
  /** epoch ms of the last confirmed send */
  lastNotifiedAt?: number;
  /** the price that triggered the last confirmed send */
  lastPrice?: number;
}

export const ARMED: AlertArmState = { armed: true };

/** `<token>|<cardNumber>|<PRINTING>` — an Expo push token never contains '|'. */
export function armStateKey(token: string, cardNumber: string, printing: string): string {
  return `${token}|${priceAlertKey(cardNumber, printing)}`;
}

export interface AlertRecipient {
  token: string;
  alert: PriceAlert;
}

export interface AlertSend {
  token: string;
  alert: PriceAlert;
  price: number;
  currency: string;
  stateKey: string;
}

export interface AlertEvaluation {
  /** recipients whose exact printing just entered their interval */
  sends: AlertSend[];
  /** state keys whose price left the interval → re-arm now, regardless of any
   * send outcome, so the next entry fires again */
  rearm: string[];
  /** in range but already notified and not yet re-armed */
  skipped: number;
  /** alerts with no comparable exact-version price this run */
  unpriced: number;
}

/**
 * Decide who to notify this run. Pure: the caller supplies the exact-version
 * price lookup and the persisted arm state, and applies the returned
 * transitions (re-arms unconditionally, disarms only for confirmed sends).
 *
 * A missing or currency-mismatched price is NOT treated as "left the interval":
 * a scrape gap must not silently re-arm an alert that never left range.
 */
export function evaluatePriceAlerts(
  recipients: readonly AlertRecipient[],
  priceOf: (cardNumber: string, printing: string) => AlertPrice | null | undefined,
  states: Readonly<Record<string, AlertArmState>>,
): AlertEvaluation {
  const sends: AlertSend[] = [];
  const rearm: string[] = [];
  let skipped = 0;
  let unpriced = 0;

  for (const { token, alert } of recipients) {
    const stateKey = armStateKey(token, alert.cardNumber, alert.printing);
    const status = evaluateAlertStatus(alert, priceOf(alert.cardNumber, alert.printing));
    if (status === 'UNPRICED' || status === 'CURRENCY_MISMATCH') {
      unpriced += 1;
      continue;
    }
    const armed = states[stateKey]?.armed ?? true;
    if (status !== 'IN_RANGE') {
      if (!armed) rearm.push(stateKey);
      continue;
    }
    if (!armed) {
      skipped += 1;
      continue;
    }
    const price = priceOf(alert.cardNumber, alert.printing) as AlertPrice;
    sends.push({ token, alert, price: price.price, currency: price.currency, stateKey });
  }

  return { sends, rearm, skipped, unpriced };
}

// ── Notification copy ───────────────────────────────────────────────────────

export function formatAlertAmount(value: number, currency: string): string {
  const amount = value.toLocaleString('en-US');
  return currency === 'JPY' ? `¥${amount}` : `${amount} ${currency}`;
}

export function formatInterval(alert: Pick<PriceAlert, 'lowerPrice' | 'upperPrice' | 'currency'>): string {
  const upper = formatAlertAmount(alert.upperPrice, alert.currency);
  if (alert.lowerPrice === null) return `≤ ${upper}`;
  return `${formatAlertAmount(alert.lowerPrice, alert.currency)} – ${upper}`;
}

export function buildAlertMessage(send: AlertSend): { title: string; body: string } {
  const label = send.alert.printingLabel?.trim() || send.alert.printing;
  return {
    title: `到價提醒：${send.alert.name}`,
    body: `${send.alert.cardNumber}・${label} 參考售價 ${formatAlertAmount(send.price, send.currency)}，已進入你的期望區間 ${formatInterval(send.alert)}。`,
  };
}
