// DIC-1189 rework-blocker #3c: push-notification synthetic-only guard for
// staging.
//
// On the staging deployment, the notify / price-alert-run paths MUST NOT
// send to production Expo push tokens — a real user device that had opted
// into notifications on production could otherwise be woken by a synthetic
// staging trigger, and any confusion between "test" and "real" push
// deliveries is a privacy / trust incident.
//
// Enforcement: staging accepts only Expo tokens listed in
// EXPO_STAGING_TEST_TOKENS (comma-separated allow-list). An empty allow-list
// means staging cannot send to ANYONE — the fail-closed default. Production
// applies no filter (its allow-list is the KV watchlist itself, which is
// keyed on production Expo tokens).
//
// filterStagingRecipients() returns:
//   - production: the input list unchanged.
//   - staging: input filtered to only tokens on the allow-list, and always
//     tagged with `environment: 'staging'` in a companion field the caller
//     stamps into the push message data payload.
//
// This is defence-in-depth on top of the independent staging KV instance
// (which by construction only contains staging-registered tokens). If for
// any reason a production token were ever written to the staging KV
// (recovery of a KV snapshot into the wrong lane, operator error), this
// filter still rejects it.

import { resolveAppEnvStrict } from '../../src/config/appEnv';

export const STAGING_EXPO_TOKENS_VAR = 'EXPO_STAGING_TEST_TOKENS';

function readStagingAllowList(): Set<string> {
  const raw = process.env[STAGING_EXPO_TOKENS_VAR];
  if (typeof raw !== 'string' || !raw.trim()) return new Set();
  return new Set(
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
  );
}

/**
 * Filter a list of Expo push tokens. On production returns the input
 * unchanged. On staging returns only tokens on the STAGING_EXPO_TOKENS_VAR
 * allow-list (empty by default — fail closed).
 */
export function filterPushRecipients<T extends { token: string }>(
  recipients: readonly T[],
): T[] {
  const appEnv = resolveAppEnvStrict();
  if (appEnv !== 'staging') return [...recipients];
  const allow = readStagingAllowList();
  if (allow.size === 0) return [];
  return recipients.filter((r) => allow.has(r.token));
}

/**
 * The `environment` field to stamp into push message payload data. Tags
 * every staging push so the receiving client (and any downstream analytics)
 * can distinguish synthetic from real. Returns undefined on production so
 * the wire payload stays byte-identical to pre-DIC-1189.
 */
export function pushEnvironmentTag(): 'staging' | undefined {
  const appEnv = resolveAppEnvStrict();
  return appEnv === 'staging' ? 'staging' : undefined;
}
