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
import type { Deck } from '../../src/utils/deckRules';

export const ACCOUNT_SYNC_SCHEMA_VERSION = 1;
export const MAX_SYNC_PAYLOAD_BYTES = 256_000;
export const MAX_FAVORITES = 2_000;
export const MAX_DECKS = 200;
export const MAX_COLLECTION_ENTRIES = 10_000;
export const MAX_PRICE_ALERTS = 500;

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
  code: 'invalid_request' | 'payload_too_large' | 'revision_conflict';
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

const SYNC_KEY = (userId: string) => `account-sync:user:${userId}`;
const IDEMPOTENCY_KEY = (userId: string, key: string) => `account-sync:idempotency:${userId}:${key}`;
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24;

const SAVE_SNAPSHOT = `-- ACCOUNT_SYNC_SAVE
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
return { 'OK', tostring(currentRevision + 1), ARGV[2] }
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
    const qty = Math.floor(Number(rawQty));
    if (!Number.isFinite(qty) || qty < 0) throw new AccountSyncError('invalid_request', 'collection quantities must be non-negative integers', 400);
    if (qty > 0) out[cleanKey] = qty;
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

function cleanDecks(value: unknown): Deck[] {
  if (!Array.isArray(value)) throw new AccountSyncError('invalid_request', 'decks must be an array', 400);
  if (value.length > MAX_DECKS) throw new AccountSyncError('payload_too_large', 'too many decks', 413);
  assertPayloadSize(value);
  return value as Deck[];
}

function cleanPriceAlerts(value: unknown): PriceAlert[] {
  if (!Array.isArray(value)) throw new AccountSyncError('invalid_request', 'priceAlerts must be an array', 400);
  if (value.length > MAX_PRICE_ALERTS) throw new AccountSyncError('payload_too_large', 'too many price alerts', 413);
  assertPayloadSize(value);
  return value as PriceAlert[];
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
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) {
    throw new AccountSyncError('invalid_request', 'baseRevision must be a non-negative integer', 400);
  }
  return n;
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
    [SYNC_KEY(input.userId), IDEMPOTENCY_KEY(input.userId, input.idempotencyKey)],
    [String(input.baseRevision), encoded, String(IDEMPOTENCY_TTL_SECONDS)],
  ));
  if (status === 'CONFLICT') {
    throw new AccountSyncError('revision_conflict', 'baseRevision does not match server revision', 409, {
      currentRevision: Number(revisionRaw),
      snapshot: bodyRaw ? decodeSnapshot(bodyRaw) : defaultSnapshot(),
    });
  }
  if (status === 'OK' || status === 'IDEMPOTENT') return decodeSnapshot(bodyRaw);
  throw new Error(`unexpected account sync status: ${status}`);
}

export async function deleteAccountSyncData(userId: string): Promise<void> {
  await kv.del(SYNC_KEY(userId));
}
