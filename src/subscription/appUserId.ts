// App User ID contract (DIC-1149 Phase 1a).
//
// The App User ID is the identity a subscription provider stores against a
// paid entitlement. Getting it wrong is expensive and irreversible: change
// the id later and every existing subscriber becomes an unrecognised new
// user, and every provider webhook fires against a dead handle. This module
// exists so the choice is made in exactly one place.
//
// Chosen contract:
//   - The App User ID is the backend user UUID (`HoloUser.internalId`).
//   - It is INJECTED into the subscription layer, never derived here from
//     the auth store, so tests and future backends can swap implementations
//     without editing this file.
//   - Everything is a branded {@link AppUserIdentity}, so adapters cannot
//     accept a bare string by mistake.
//
// Explicitly REJECTED sources — do not add these without a design review:
//
//   - Email                  — mutable, users change it; some providers store
//                              subscriptions permanently against whatever they
//                              first saw, so an email swap orphans the entitlement.
//   - Apple OAuth subject    — Apple `sub` is unique per (bundle-id, user);
//                              the app already spans a web bundle and a native
//                              bundle, so the same human has two subs.
//   - Google OAuth token     — access tokens rotate; id token `sub` is stable
//                              per project but Google Sign-In will happily
//                              hand out different projects across web / iOS /
//                              Android build variants (see .env.example).
//   - Device id              — a paid entitlement must survive a factory
//                              reset and follow the user across devices.
//   - Ephemeral session id   — restart loses the entitlement.
//
// The backend `HoloUser.internalId` (see src/types/auth.ts) is the only
// value that already spans every login surface and survives an email
// change / device swap / OAuth provider swap.

import type { AppUserIdentity } from './providers/types';

/**
 * A resolver the subscription layer calls to obtain the current user's
 * backend UUID. Returning `null` means "no signed-in user right now" —
 * guests cannot purchase, and this is the layer that enforces that.
 *
 * Injection point: the app wires one of these at composition time from the
 * auth store; tests wire a fake.
 */
export type AppUserIdentityResolver = () => string | null;

/**
 * Errors {@link resolveAppUserId} can raise. Distinct kinds so the caller
 * can route them differently in UI copy without inspecting messages.
 */
export type AppUserIdError =
  | 'no_signed_in_user'
  | 'malformed_backend_uuid';

export class AppUserIdResolutionError extends Error {
  readonly kind: AppUserIdError;
  constructor(kind: AppUserIdError) {
    super(kind);
    this.name = 'AppUserIdResolutionError';
    this.kind = kind;
  }
}

/**
 * Validate that a raw id looks like a backend user id, then brand it. The
 * backend today issues ids in the shape `holo_<hex>` (see
 * api/_lib/identity-store.ts) — we accept that shape AND standard UUIDs so
 * that a future backend rewrite that switches to UUIDs does not require
 * changing this validator in lockstep.
 *
 * The validator is deliberately permissive on charset (URL-safe printable
 * ASCII, length 8..128) so that a real backend rename is a config change,
 * not a code change. It is deliberately strict on structure (no whitespace,
 * no `@`, no separators that would be misread as an email or a JWT) so that
 * an email accidentally passed here is rejected loudly.
 */
export function brandAppUserId(raw: string): AppUserIdentity {
  if (!isPlausibleBackendUuid(raw)) {
    throw new AppUserIdResolutionError('malformed_backend_uuid');
  }
  return Object.freeze({
    __brand: 'AppUserIdentity',
    value: raw,
  }) as AppUserIdentity;
}

/**
 * The primary entry point. Given an injected resolver, produce a branded
 * identity or throw a typed error. Adapters MUST use this rather than
 * fabricating an identity themselves.
 */
export function resolveAppUserId(
  resolver: AppUserIdentityResolver,
): AppUserIdentity {
  const raw = resolver();
  if (raw === null || raw === '') {
    throw new AppUserIdResolutionError('no_signed_in_user');
  }
  return brandAppUserId(raw);
}

/**
 * Non-throwing companion — for gating UI paths that must not raise (e.g.,
 * hiding a paywall CTA when there is no user). Returns `null` for both
 * failure kinds; callers that need to distinguish should use
 * {@link resolveAppUserId} and catch.
 */
export function tryResolveAppUserId(
  resolver: AppUserIdentityResolver,
): AppUserIdentity | null {
  try {
    return resolveAppUserId(resolver);
  } catch {
    return null;
  }
}

// ── validators ────────────────────────────────────────────────────────────

const BACKEND_ID_MIN = 8;
const BACKEND_ID_MAX = 128;
// URL-safe printable ASCII, minus the characters that would suggest email
// (`@`), JWT (`.` at any position between segments), whitespace, or slash.
// `-` and `_` are allowed because they appear in both `holo_<hex>` and in
// base32/base62-encoded UUIDs.
const BACKEND_ID_RE = /^[A-Za-z0-9_-]+$/;

function isPlausibleBackendUuid(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  if (raw.length < BACKEND_ID_MIN || raw.length > BACKEND_ID_MAX) return false;
  if (!BACKEND_ID_RE.test(raw)) return false;
  return true;
}
