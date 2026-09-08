/**
 * Account remote-sync client (DIC-1380 W3, Phase-2 wiring for DIC-1156).
 *
 * The Phase-1 server (`api/auth/[action].ts`) already exposes a versioned,
 * server-authoritative snapshot behind `GET/POST /api/auth/sync`, guarded by
 * the session bearer. The client side has been missing — Web / Android / iOS
 * cannot round-trip favorites / decks / collection / price-alerts / settings
 * to the server without it, so cross-device state never leaves the device.
 *
 * This module is the small, dependency-free client that Phase-2 wiring
 * (favorites/watchlist/decks stores) will call. It intentionally does NOT
 * touch any store — the caller decides when to pull and what to push, so the
 * client stays a pure I/O boundary that can be unit-verified with a fetch
 * stub. Retention rules, merge policy, and store-level triggers live with the
 * stores that own the data.
 *
 * Contract:
 *   • `pullAccountSnapshot(session)` — GET the current per-user snapshot.
 *     Returns `null` on 401 / 404 / account-deleted so callers stop wiring
 *     into a session that can't own state.
 *   • `pushAccountSnapshot(session, input)` — POST an optimistic-concurrency
 *     patch. `baseRevision` MUST match what the client last observed; a
 *     mismatch surfaces as `AccountSyncConflictError` carrying the server's
 *     current snapshot so the caller can re-plan the patch and retry.
 *   • Both functions guard against unauthenticated / guest calls by refusing
 *     an empty `session`. Store MVP surfaces (favorites / watchlist / etc.)
 *     already gate their own render + fetch paths, so wiring code that only
 *     runs when `FEATURES.favorites || FEATURES.watchlist` is true is enough
 *     to keep this client silent under the fail-closed profile.
 *
 * The types here are deliberately loose (`unknown` payload passthrough) so
 * the server-side schema in `api/_lib/account-sync-store.ts` stays the sole
 * source of truth for shape validation. Pinning them here would let a
 * client-side type drift silently loosen a server-side gate.
 */
import { PRODUCTION_ORIGIN } from '../config/apiOrigin';

// Same resolution rule as `getApiBase` in `pushNotificationService.ts`, but
// re-declared here so this module stays free of `react-native` imports and can
// be exercised under `--experimental-strip-types` without pulling in RN. Web
// prefers `window.location.origin` (matches the current deploy target and
// keeps every request same-origin); anywhere without a `window` (native
// runtime, Node test harness) falls through to the canonical production
// host.
function getSyncApiBase(): string {
  if (typeof window !== 'undefined' && window?.location?.origin) {
    return window.location.origin;
  }
  return PRODUCTION_ORIGIN;
}

export const ACCOUNT_SYNC_CLIENT_SCHEMA_VERSION = 1;

export interface AccountSyncFavorite {
  cardNumber: string;
  printing: string;
  cardId?: string;
  addedAt: string;
}

export type AccountSyncCollection = Record<string, number>;

export interface AccountSyncSettings {
  preferredCurrency: string;
  preferredLanguage: string;
}

export interface AccountSyncSnapshot {
  schemaVersion: typeof ACCOUNT_SYNC_CLIENT_SCHEMA_VERSION;
  revision: number;
  updatedAt: string;
  deviceId: string | null;
  favorites: AccountSyncFavorite[];
  decks: unknown[];
  collection: AccountSyncCollection;
  priceAlerts: unknown[];
  settings: AccountSyncSettings;
}

export interface AccountSyncPatch {
  favorites?: AccountSyncFavorite[];
  decks?: unknown[];
  collection?: AccountSyncCollection;
  priceAlerts?: unknown[];
  settings?: Partial<AccountSyncSettings>;
}

export interface PushSnapshotInput {
  baseRevision: number;
  idempotencyKey: string;
  deviceId?: string;
  patch: AccountSyncPatch;
}

export class AccountSyncClientError extends Error {
  status: number;
  code?: string;

  constructor(message: string, status: number, code?: string) {
    super(message);
    this.name = 'AccountSyncClientError';
    this.status = status;
    this.code = code;
  }
}

export class AccountSyncConflictError extends AccountSyncClientError {
  serverRevision: number;
  serverSnapshot: AccountSyncSnapshot | null;

  constructor(serverRevision: number, serverSnapshot: AccountSyncSnapshot | null) {
    super('account-sync revision conflict', 409, 'revision_conflict');
    this.name = 'AccountSyncConflictError';
    this.serverRevision = serverRevision;
    this.serverSnapshot = serverSnapshot;
  }
}

// Uniform "not signed in" surface so callers do not have to distinguish 401
// (session invalidated / bearer rejected) from an empty session (guest / not
// yet rehydrated). Both mean "there is nothing to sync against"; the caller
// stops rather than retrying against a doomed request.
function isEmptySession(session: string | null | undefined): boolean {
  return typeof session !== 'string' || session.length === 0;
}

function syncUrl(): string {
  return `${getSyncApiBase()}/api/auth/sync`;
}

// Same idempotency-key format the server accepts (per-user snapshot writes are
// keyed by (userId, idempotencyKey)). Random + timestamp keeps two devices
// writing concurrently from colliding.
export function newIdempotencyKey(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${rand}`;
}

async function parseJsonSafe(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function snapshotFromBody(body: Record<string, unknown>): AccountSyncSnapshot | null {
  const raw = body.snapshot;
  if (!raw || typeof raw !== 'object') return null;
  return raw as AccountSyncSnapshot;
}

/**
 * GET `/api/auth/sync` with the bearer session. Returns the current snapshot
 * or `null` when the caller has no state to pull (empty session, 401, 404,
 * account_deleted). Other failures throw `AccountSyncClientError` so the
 * caller can decide whether to retry or fall back to local-only.
 */
export async function pullAccountSnapshot(
  session: string | null | undefined,
): Promise<AccountSyncSnapshot | null> {
  if (isEmptySession(session)) return null;

  let res: Response;
  try {
    res = await fetch(syncUrl(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${session}`,
      },
    });
  } catch (err) {
    throw new AccountSyncClientError((err as Error)?.message || 'network error', 0);
  }

  if (res.status === 401 || res.status === 404) return null;
  const body = await parseJsonSafe(res);
  if (res.status === 410 || body.error === 'account_deleted') return null;
  if (!res.ok) {
    throw new AccountSyncClientError(
      typeof body.error === 'string' ? body.error : `status ${res.status}`,
      res.status,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return snapshotFromBody(body);
}

/**
 * POST `/api/auth/sync` with an optimistic-concurrency patch. On 409 raises
 * `AccountSyncConflictError` with the server snapshot so the caller can
 * re-plan the patch and retry. On any other failure raises
 * `AccountSyncClientError`. Returns the server's confirmed snapshot on
 * success.
 */
export async function pushAccountSnapshot(
  session: string | null | undefined,
  input: PushSnapshotInput,
): Promise<AccountSyncSnapshot | null> {
  if (isEmptySession(session)) return null;

  let res: Response;
  try {
    res = await fetch(syncUrl(), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        'Idempotency-Key': input.idempotencyKey,
        Authorization: `Bearer ${session}`,
      },
      body: JSON.stringify({
        baseRevision: input.baseRevision,
        idempotencyKey: input.idempotencyKey,
        deviceId: input.deviceId,
        patch: input.patch,
      }),
    });
  } catch (err) {
    throw new AccountSyncClientError((err as Error)?.message || 'network error', 0);
  }

  const body = await parseJsonSafe(res);
  if (res.status === 409 && body.error === 'revision_conflict') {
    const serverRevision = typeof body.serverRevision === 'number' ? body.serverRevision : 0;
    throw new AccountSyncConflictError(serverRevision, snapshotFromBody(body));
  }
  if (res.status === 410 || body.error === 'account_deleted') return null;
  if (res.status === 401 || res.status === 404) return null;
  if (!res.ok) {
    throw new AccountSyncClientError(
      typeof body.error === 'string' ? body.error : `status ${res.status}`,
      res.status,
      typeof body.error === 'string' ? body.error : undefined,
    );
  }
  return snapshotFromBody(body);
}
