/**
 * Account remote-sync foundation (DIC-1156 Phase 1).
 *
 * Server-authoritative user ownership: every key is derived from the validated
 * internal user id in the session. Client-supplied user ids/emails are ignored.
 * This module stores one versioned per-user snapshot in Vercel KV and applies
 * optimistic-concurrency updates with an idempotency fence.
 */
import { kv } from '@vercel/kv';
import type { PriceAlert } from '../../src/utils/priceAlerts';
import type { CurrencyCode, LanguageCode } from '../../src/store/settingsStore';
import type { Deck, DeckCard, DeckOrigin, DeckSlot, DeckZone } from '../../src/utils/deckRules';
// DIC-1189: every KV key here must be namespaced per APP_ENV so a staging
// account-sync write can never leak into a production user's snapshot.
// nsKey() throws on missing/unknown APP_ENV — fail closed.
import { nsKey } from './kv-namespace';

// Defense-in-depth upper bound on a stored alert price. Kept in sync with the
// client's MAX_ALERT_PRICE (src/utils/priceAlerts.ts) but declared locally so
// this server module stays a pure Node dependency without pulling any RN code.
const SERVER_MAX_ALERT_PRICE = 100_000_000;

export const ACCOUNT_SYNC_SCHEMA_VERSION = 1;
export const MAX_SYNC_PAYLOAD_BYTES = 256_000;
export const MAX_FAVORITES = 2_000;
export const MAX_DECKS = 200;
export const MAX_COLLECTION_ENTRIES = 10_000;
export const MAX_PRICE_ALERTS = 500;
export const MAX_DECK_ZONE_SLOTS = 200;
export const MAX_DECK_SLOT_QTY = 500;
export const MAX_COLLECTION_QTY = 100_000;

const DECK_CURRENCY_CODES = ['TWD', 'JPY', 'USD'] as const;
type DeckCurrencyCode = typeof DECK_CURRENCY_CODES[number];

export interface AccountFavorite {
  cardNumber: string;
  printing: string;
  cardId?: string;
  addedAt: string;
}

export type AccountCollection = Record<string, number>;

export interface AccountSettings {
  preferredCurrency: CurrencyCode;
  preferredLanguage: LanguageCode;
}

export interface AccountSyncSnapshot {
  schemaVersion: typeof ACCOUNT_SYNC_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  deviceId: string | null;
  favorites: AccountFavorite[];
  decks: Deck[];
  collection: AccountCollection;
  priceAlerts: PriceAlert[];
  settings: AccountSettings;
}

export interface AccountSyncPatch {
  favorites?: AccountFavorite[];
  decks?: Deck[];
  collection?: AccountCollection;
  priceAlerts?: PriceAlert[];
  settings?: Partial<AccountSettings>;
}

export interface SaveAccountSyncInput {
  userId: string;
  baseRevision: number;
  idempotencyKey: string;
  deviceId?: string;
  patch: AccountSyncPatch;
}

export class AccountSyncError extends Error {
  code: 'invalid_request' | 'payload_too_large' | 'revision_conflict' | 'account_deleted';
  status: number;
  extra?: Record<string, unknown>;

  constructor(
    code: AccountSyncError['code'],
    message: string,
    status: number,
    extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AccountSyncError';
    this.code = code;
    this.status = status;
    this.extra = extra;
  }
}

const SYNC_KEY = (userId: string) => nsKey(`account-sync:user:${userId}`);
const IDEMPOTENCY_KEY = (userId: string, key: string) => nsKey(`account-sync:idempotency:${userId}:${key}`);
const IDEMPOTENCY_INDEX_KEY = (userId: string) => nsKey(`account-sync:idempotency-index:${userId}`);
const DELETION_FENCE_KEY = (userId: string) => nsKey(`account-sync:deleted:${userId}`);
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24;

const SAVE_SNAPSHOT = `-- ACCOUNT_SYNC_SAVE
if redis.call('EXISTS', KEYS[4]) == 1 then
  return { 'DELETED', '0', '' }
end
local currentRaw = redis.call('GET', KEYS[1])
local currentRevision = 0
if currentRaw then
  local decoded = cjson.decode(currentRaw)
  currentRevision = tonumber(decoded.revision) or 0
end
local idemRaw = redis.call('GET', KEYS[2])
if idemRaw then
  return { 'IDEMPOTENT', tostring(currentRevision), idemRaw }
end
if currentRevision ~= tonumber(ARGV[1]) then
  return { 'CONFLICT', tostring(currentRevision), currentRaw or '' }
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[2], ARGV[2], 'EX', ARGV[3])
redis.call('SADD', KEYS[3], KEYS[2])
redis.call('EXPIRE', KEYS[3], ARGV[3])
return { 'OK', tostring(currentRevision + 1), ARGV[2] }
`;

const START_DELETION = `-- ACCOUNT_SYNC_DELETE_BEGIN
redis.call('SET', KEYS[1], ARGV[1])
return 'OK'
`;

function defaultSnapshot(): AccountSyncSnapshot {
  return {
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    revision: 0,
    updatedAt: '',
    deviceId: null,
    favorites: [],
    decks: [],
    collection: {},
    priceAlerts: [],
    settings: { preferredCurrency: 'TWD', preferredLanguage: 'zh' },
  };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}

function assertPayloadSize(value: unknown): void {
  if (byteLength(value) > MAX_SYNC_PAYLOAD_BYTES) {
    throw new AccountSyncError('payload_too_large', 'sync payload is too large', 413);
  }
}

function cleanString(value: unknown, field: string, required = true): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new AccountSyncError('invalid_request', `${field} is required`, 400);
    return undefined;
  }
  if (typeof value !== 'string') throw new AccountSyncError('invalid_request', `${field} must be a string`, 400);
  const s = value.trim();
  if (required && !s) throw new AccountSyncError('invalid_request', `${field} is required`, 400);
  return s || undefined;
}

function cleanOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function cleanIso(value: unknown, field: string): string {
  const s = cleanString(value, field, true)!;
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new AccountSyncError('invalid_request', `${field} must be ISO timestamp`, 400);
  return new Date(t).toISOString();
}

function cleanFavorite(value: unknown): AccountFavorite {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', 'favorite must be an object', 400);
  }
  const v = value as Record<string, unknown>;
  return {
    cardNumber: cleanString(v.cardNumber, 'favorite.cardNumber', true)!,
    printing: cleanString(v.printing, 'favorite.printing', true)!,
    cardId: cleanOptionalString(v.cardId),
    addedAt: cleanIso(v.addedAt, 'favorite.addedAt'),
  };
}

function cleanFavorites(value: unknown): AccountFavorite[] {
  if (!Array.isArray(value)) throw new AccountSyncError('invalid_request', 'favorites must be an array', 400);
  if (value.length > MAX_FAVORITES) throw new AccountSyncError('payload_too_large', 'too many favorites', 413);
  const byKey = new Map<string, AccountFavorite>();
  for (const item of value) {
    const fav = cleanFavorite(item);
    byKey.set(`${fav.cardNumber}|${fav.printing}`, fav);
  }
  return [...byKey.values()].sort((a, b) => a.cardNumber.localeCompare(b.cardNumber) || a.printing.localeCompare(b.printing));
}

function cleanCollection(value: unknown): AccountCollection {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', 'collection must be an object', 400);
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > MAX_COLLECTION_ENTRIES) throw new AccountSyncError('payload_too_large', 'too many collection entries', 413);
  const out: AccountCollection = {};
  for (const [key, rawQty] of entries) {
    const cleanKey = key.trim();
    if (!cleanKey || !cleanKey.includes('|')) throw new AccountSyncError('invalid_request', 'collection keys must be cardNumber|printing', 400);
    // Reject any non-number, fractional, unsafe-magnitude, or negative value
    // WITHOUT coercing — `Number(x)` would smuggle in `"7"`, `null`, `false`,
    // `""` (all → 0), and `Math.floor` would silently truncate `1.9` → 1.
    if (typeof rawQty !== 'number' || !Number.isSafeInteger(rawQty)) {
      throw new AccountSyncError('invalid_request', `collection[${cleanKey}] quantity must be a safe integer`, 400);
    }
    if (rawQty < 0 || rawQty > MAX_COLLECTION_QTY) {
      throw new AccountSyncError('invalid_request', `collection[${cleanKey}] quantity must be between 0 and ${MAX_COLLECTION_QTY}`, 400);
    }
    if (rawQty > 0) out[cleanKey] = rawQty;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function cleanRequiredString(value: unknown, field: string): string {
  if (value === undefined || value === null) {
    throw new AccountSyncError('invalid_request', `${field} is required`, 400);
  }
  if (typeof value !== 'string') {
    throw new AccountSyncError('invalid_request', `${field} must be a string`, 400);
  }
  return value;
}

function cleanNonEmptyString(value: unknown, field: string): string {
  const s = cleanRequiredString(value, field);
  if (!s.trim()) throw new AccountSyncError('invalid_request', `${field} is required`, 400);
  return s;
}

function cleanIntegerInRange(value: unknown, field: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AccountSyncError('invalid_request', `${field} must be a safe integer`, 400);
  }
  if (value < min || value > max) {
    throw new AccountSyncError('invalid_request', `${field} must be between ${min} and ${max}`, 400);
  }
  return value;
}

function cleanDeckCard(value: unknown, ctx: string): DeckCard {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${ctx} must be an object`, 400);
  }
  const v = value as Record<string, unknown>;
  const card: DeckCard = {
    id: cleanNonEmptyString(v.id, `${ctx}.id`),
    cardNumber: cleanNonEmptyString(v.cardNumber, `${ctx}.cardNumber`),
    name: cleanRequiredString(v.name, `${ctx}.name`),
    printing: cleanNonEmptyString(v.printing, `${ctx}.printing`),
    printingLabel: cleanRequiredString(v.printingLabel, `${ctx}.printingLabel`),
    series: cleanRequiredString(v.series, `${ctx}.series`),
  };
  if (v.nameZh !== undefined && v.nameZh !== null) card.nameZh = cleanRequiredString(v.nameZh, `${ctx}.nameZh`);
  if (v.nameJa !== undefined && v.nameJa !== null) card.nameJa = cleanRequiredString(v.nameJa, `${ctx}.nameJa`);
  if (v.type !== undefined && v.type !== null) card.type = cleanRequiredString(v.type, `${ctx}.type`);
  if (v.cardTypeJp !== undefined && v.cardTypeJp !== null) card.cardTypeJp = cleanRequiredString(v.cardTypeJp, `${ctx}.cardTypeJp`);
  if (v.exactImageUrl !== undefined && v.exactImageUrl !== null) card.exactImageUrl = cleanRequiredString(v.exactImageUrl, `${ctx}.exactImageUrl`);
  if (v.imageUrl !== undefined && v.imageUrl !== null) card.imageUrl = cleanRequiredString(v.imageUrl, `${ctx}.imageUrl`);
  if (v.unresolvedPrinting !== undefined && v.unresolvedPrinting !== null) {
    if (typeof v.unresolvedPrinting !== 'boolean') {
      throw new AccountSyncError('invalid_request', `${ctx}.unresolvedPrinting must be a boolean`, 400);
    }
    card.unresolvedPrinting = v.unresolvedPrinting;
  }
  if (v.defaultedPrinting !== undefined && v.defaultedPrinting !== null) {
    if (typeof v.defaultedPrinting !== 'boolean') {
      throw new AccountSyncError('invalid_request', `${ctx}.defaultedPrinting must be a boolean`, 400);
    }
    card.defaultedPrinting = v.defaultedPrinting;
  }
  if (v.sourceVersion !== undefined && v.sourceVersion !== null) card.sourceVersion = cleanRequiredString(v.sourceVersion, `${ctx}.sourceVersion`);
  return card;
}

function cleanDeckSlot(value: unknown, ctx: string): DeckSlot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${ctx} must be an object`, 400);
  }
  const v = value as Record<string, unknown>;
  return {
    card: cleanDeckCard(v.card, `${ctx}.card`),
    qty: cleanIntegerInRange(v.qty, `${ctx}.qty`, 1, MAX_DECK_SLOT_QTY),
  };
}

function cleanDeckZone(value: unknown, zone: DeckZone, deckCtx: string): DeckSlot[] {
  if (!Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${deckCtx}.${zone} must be an array`, 400);
  }
  if (value.length > MAX_DECK_ZONE_SLOTS) {
    throw new AccountSyncError('payload_too_large', `${deckCtx}.${zone} has too many slots`, 413);
  }
  return value.map((slot, i) => cleanDeckSlot(slot, `${deckCtx}.${zone}[${i}]`));
}

function cleanDeckOrigin(value: unknown, ctx: string): DeckOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${ctx} must be an object`, 400);
  }
  const v = value as Record<string, unknown>;
  if (v.kind !== 'tournament') {
    throw new AccountSyncError('invalid_request', `${ctx}.kind must be "tournament"`, 400);
  }
  let decklogCode: string | null;
  if (v.decklogCode === null) decklogCode = null;
  else if (typeof v.decklogCode === 'string') decklogCode = v.decklogCode;
  else throw new AccountSyncError('invalid_request', `${ctx}.decklogCode must be a string or null`, 400);
  return {
    kind: 'tournament',
    eventId: cleanNonEmptyString(v.eventId, `${ctx}.eventId`),
    eventName: cleanRequiredString(v.eventName, `${ctx}.eventName`),
    sourceDeckId: cleanNonEmptyString(v.sourceDeckId, `${ctx}.sourceDeckId`),
    decklogCode,
    sourceUrl: cleanNonEmptyString(v.sourceUrl, `${ctx}.sourceUrl`),
    importedAt: cleanIso(v.importedAt, `${ctx}.importedAt`),
  };
}

function cleanDeck(value: unknown, ctx: string): Deck {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${ctx} must be an object`, 400);
  }
  const v = value as Record<string, unknown>;
  const deck: Deck = {
    id: cleanNonEmptyString(v.id, `${ctx}.id`),
    name: cleanRequiredString(v.name, `${ctx}.name`),
    oshi: cleanDeckZone(v.oshi, 'oshi', ctx),
    main: cleanDeckZone(v.main, 'main', ctx),
    yell: cleanDeckZone(v.yell, 'yell', ctx),
    updatedAt: cleanIso(v.updatedAt, `${ctx}.updatedAt`),
  };
  if (v.origin !== undefined && v.origin !== null) {
    deck.origin = cleanDeckOrigin(v.origin, `${ctx}.origin`);
  }
  return deck;
}

function cleanDecks(value: unknown): Deck[] {
  if (!Array.isArray(value)) throw new AccountSyncError('invalid_request', 'decks must be an array', 400);
  if (value.length > MAX_DECKS) throw new AccountSyncError('payload_too_large', 'too many decks', 413);
  assertPayloadSize(value);
  return value.map((deck, i) => cleanDeck(deck, `decks[${i}]`));
}

function isDeckCurrency(value: unknown): value is DeckCurrencyCode {
  return typeof value === 'string' && (DECK_CURRENCY_CODES as readonly string[]).includes(value);
}

function cleanPriceAlertPriceBound(value: unknown, field: string, allowNull: boolean): number | null {
  if (value === null) {
    if (!allowNull) throw new AccountSyncError('invalid_request', `${field} is required`, 400);
    return null;
  }
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new AccountSyncError('invalid_request', `${field} must be a safe integer`, 400);
  }
  if (value < 0 || value > SERVER_MAX_ALERT_PRICE) {
    throw new AccountSyncError('invalid_request', `${field} must be between 0 and ${SERVER_MAX_ALERT_PRICE}`, 400);
  }
  return value;
}

function cleanPriceAlert(value: unknown, ctx: string): PriceAlert {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', `${ctx} must be an object`, 400);
  }
  const v = value as Record<string, unknown>;
  if (!isDeckCurrency(v.currency)) {
    throw new AccountSyncError('invalid_request', `${ctx}.currency must be TWD, JPY, or USD`, 400);
  }
  const upperPrice = cleanPriceAlertPriceBound(v.upperPrice, `${ctx}.upperPrice`, false)!;
  const lowerRaw = v.lowerPrice === undefined ? null : v.lowerPrice;
  const lowerPrice = cleanPriceAlertPriceBound(lowerRaw, `${ctx}.lowerPrice`, true);
  if (lowerPrice !== null && lowerPrice > upperPrice) {
    throw new AccountSyncError('invalid_request', `${ctx}.lowerPrice must not exceed ${ctx}.upperPrice`, 400);
  }
  const alert: PriceAlert = {
    cardNumber: cleanNonEmptyString(v.cardNumber, `${ctx}.cardNumber`),
    printing: cleanNonEmptyString(v.printing, `${ctx}.printing`),
    printingLabel: cleanRequiredString(v.printingLabel, `${ctx}.printingLabel`),
    name: cleanRequiredString(v.name, `${ctx}.name`),
    currency: v.currency,
    lowerPrice,
    upperPrice,
    createdAt: cleanIso(v.createdAt, `${ctx}.createdAt`),
    updatedAt: cleanIso(v.updatedAt, `${ctx}.updatedAt`),
  };
  if (v.imageUrl !== undefined && v.imageUrl !== null) {
    alert.imageUrl = cleanRequiredString(v.imageUrl, `${ctx}.imageUrl`);
  }
  return alert;
}

function cleanPriceAlerts(value: unknown): PriceAlert[] {
  if (!Array.isArray(value)) throw new AccountSyncError('invalid_request', 'priceAlerts must be an array', 400);
  if (value.length > MAX_PRICE_ALERTS) throw new AccountSyncError('payload_too_large', 'too many price alerts', 413);
  assertPayloadSize(value);
  return value.map((alert, i) => cleanPriceAlert(alert, `priceAlerts[${i}]`));
}

function cleanSettings(value: unknown): Partial<AccountSettings> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', 'settings must be an object', 400);
  }
  const v = value as Record<string, unknown>;
  const settings: Partial<AccountSettings> = {};
  if (v.preferredCurrency !== undefined) {
    if (v.preferredCurrency !== 'TWD' && v.preferredCurrency !== 'JPY' && v.preferredCurrency !== 'USD') {
      throw new AccountSyncError('invalid_request', 'settings.preferredCurrency is invalid', 400);
    }
    settings.preferredCurrency = v.preferredCurrency;
  }
  if (v.preferredLanguage !== undefined) {
    if (v.preferredLanguage !== 'zh' && v.preferredLanguage !== 'ja') {
      throw new AccountSyncError('invalid_request', 'settings.preferredLanguage is invalid', 400);
    }
    settings.preferredLanguage = v.preferredLanguage;
  }
  return settings;
}

export function parseAccountSyncPatch(value: unknown): AccountSyncPatch {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AccountSyncError('invalid_request', 'patch must be an object', 400);
  }
  assertPayloadSize(value);
  const v = value as Record<string, unknown>;
  const patch: AccountSyncPatch = {};
  if (v.favorites !== undefined) patch.favorites = cleanFavorites(v.favorites);
  if (v.decks !== undefined) patch.decks = cleanDecks(v.decks);
  if (v.collection !== undefined) patch.collection = cleanCollection(v.collection);
  if (v.priceAlerts !== undefined) patch.priceAlerts = cleanPriceAlerts(v.priceAlerts);
  if (v.settings !== undefined) patch.settings = cleanSettings(v.settings);
  return patch;
}

export function parseBaseRevision(value: unknown): number {
  // No coercion — `Number(null|false|"")` all silently become 0 and would let a
  // caller commit as if baseRevision=0 without ever sending the field.
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new AccountSyncError('invalid_request', 'baseRevision must be a non-negative safe integer', 400);
  }
  return value;
}

export function parseIdempotencyKey(value: unknown): string {
  const key = cleanString(value, 'idempotencyKey', true)!;
  if (!/^[A-Za-z0-9._:-]{8,128}$/.test(key)) {
    throw new AccountSyncError('invalid_request', 'idempotencyKey format is invalid', 400);
  }
  return key;
}

export function parseDeviceId(value: unknown): string | undefined {
  const deviceId = cleanString(value, 'deviceId', false);
  if (deviceId && !/^[A-Za-z0-9._:-]{1,128}$/.test(deviceId)) {
    throw new AccountSyncError('invalid_request', 'deviceId format is invalid', 400);
  }
  return deviceId;
}

function normalizeSnapshot(raw: Partial<AccountSyncSnapshot> | null | undefined): AccountSyncSnapshot {
  const base = defaultSnapshot();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    ...raw,
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    revision: Number.isInteger(raw.revision) && raw.revision! >= 0 ? raw.revision! : 0,
    settings: { ...base.settings, ...(raw.settings ?? {}) },
    favorites: Array.isArray(raw.favorites) ? raw.favorites : [],
    decks: Array.isArray(raw.decks) ? raw.decks : [],
    collection: raw.collection && typeof raw.collection === 'object' && !Array.isArray(raw.collection) ? raw.collection : {},
    priceAlerts: Array.isArray(raw.priceAlerts) ? raw.priceAlerts : [],
  };
}

function applyPatch(current: AccountSyncSnapshot, patch: AccountSyncPatch, deviceId?: string): AccountSyncSnapshot {
  return {
    ...current,
    schemaVersion: ACCOUNT_SYNC_SCHEMA_VERSION,
    revision: current.revision + 1,
    updatedAt: new Date().toISOString(),
    deviceId: deviceId ?? current.deviceId,
    favorites: patch.favorites ?? current.favorites,
    decks: patch.decks ?? current.decks,
    collection: patch.collection ?? current.collection,
    priceAlerts: patch.priceAlerts ?? current.priceAlerts,
    settings: patch.settings ? { ...current.settings, ...patch.settings } : current.settings,
  };
}

function parseEvalResult(value: unknown): [string, string, string] {
  if (!Array.isArray(value) || value.length < 3) {
    throw new Error('unexpected account sync KV response');
  }
  return [String(value[0]), String(value[1]), String(value[2] ?? '')];
}

function decodeSnapshot(raw: string): AccountSyncSnapshot {
  return normalizeSnapshot(JSON.parse(raw) as AccountSyncSnapshot);
}

export async function getAccountSyncSnapshot(userId: string): Promise<AccountSyncSnapshot> {
  return normalizeSnapshot(await kv.get<AccountSyncSnapshot>(SYNC_KEY(userId)));
}

export async function saveAccountSyncSnapshot(input: SaveAccountSyncInput): Promise<AccountSyncSnapshot> {
  const current = await getAccountSyncSnapshot(input.userId);
  const next = applyPatch(current, input.patch, input.deviceId);
  const encoded = JSON.stringify(next);
  assertPayloadSize(next);
  const [status, revisionRaw, bodyRaw] = parseEvalResult(await kv.eval(
    SAVE_SNAPSHOT,
    [
      SYNC_KEY(input.userId),
      IDEMPOTENCY_KEY(input.userId, input.idempotencyKey),
      IDEMPOTENCY_INDEX_KEY(input.userId),
      DELETION_FENCE_KEY(input.userId),
    ],
    [String(input.baseRevision), encoded, String(IDEMPOTENCY_TTL_SECONDS)],
  ));
  if (status === 'CONFLICT') {
    throw new AccountSyncError('revision_conflict', 'baseRevision does not match server revision', 409, {
      currentRevision: Number(revisionRaw),
      snapshot: bodyRaw ? decodeSnapshot(bodyRaw) : defaultSnapshot(),
    });
  }
  if (status === 'DELETED') {
    throw new AccountSyncError('account_deleted', 'account deletion is in progress or complete', 410);
  }
  if (status === 'OK' || status === 'IDEMPOTENT') return decodeSnapshot(bodyRaw);
  throw new Error(`unexpected account sync status: ${status}`);
}

async function accountSyncIdempotencyKeys(userId: string, indexKey: string): Promise<string[]> {
  const keys = new Set((await kv.smembers(indexKey)).map(String));
  for await (const key of kv.scanIterator({ match: `account-sync:idempotency:${userId}:*`, count: 100 })) {
    keys.add(String(key));
  }
  return [...keys];
}

export async function deleteAccountSyncData(userId: string): Promise<void> {
  await kv.eval(START_DELETION, [DELETION_FENCE_KEY(userId)], [new Date().toISOString()]);
  const indexKey = IDEMPOTENCY_INDEX_KEY(userId);
  const idempotencyKeys = await accountSyncIdempotencyKeys(userId, indexKey);
  await kv.del(SYNC_KEY(userId), ...idempotencyKeys, indexKey);
}
