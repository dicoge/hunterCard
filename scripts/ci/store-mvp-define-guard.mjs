/**
 * EXPO_PUBLIC_STORE_MVP per-deploy-profile define guard (DIC-1401 correction).
 *
 * The user correction this backs: there is ONE codebase / ONE new UI shared
 * by Web, Android, and iOS. `EXPO_PUBLIC_STORE_MVP` only gates which
 * not-yet-released feature surfaces/routes/deep-links/API effects/copy are
 * visible — it must NEVER be left unset and delegated to
 * `src/config/releaseFlags.ts`'s runtime fallback, which (pre-fix)
 * resolves asymmetrically: fail-closed (Store MVP ON) on native, fail-OPEN
 * (full app) on web. Every deploy profile that reaches a real audience must
 * inject the define explicitly:
 *   - Web Develop/Staging  → EXPO_PUBLIC_STORE_MVP=0
 *   - Web Production       → EXPO_PUBLIC_STORE_MVP=1
 *   - Android/iOS `production` / `production-apk` → EXPO_PUBLIC_STORE_MVP=1
 *
 * These helpers are pure (string/object in, result out) so they are testable
 * without touching a real Vercel/EAS build. `evaluateVercelBuildCommand`
 * additionally cross-checks against this repo's EXPECTED_VERCEL_BRANCH →
 * required STORE_MVP value policy so the two guards can never silently
 * drift apart.
 */

// Extracts `NAME=value` set as a literal shell-env prefix anywhere in a
// buildCommand string (e.g. "FOO=bar npm run x && BAZ=1 expo export ...").
// Returns null if the var is not assigned a literal value at all (missing).
function extractShellEnvAssignment(buildCommand, varName) {
  if (typeof buildCommand !== 'string') return null;
  const match = buildCommand.match(new RegExp(`(?:^|[\\s&;])${varName}=(\\S+)`));
  return match ? match[1] : null;
}

const VALID_STORE_MVP_VALUES = new Set(['0', '1']);

// Policy: for a vercel.json that self-declares which branch it belongs to
// via EXPECTED_VERCEL_BRANCH (see scripts/ci/vercel-branch-guard.sh), this is
// the STORE_MVP value that branch's Production build must use. A branch not
// listed here (any non-main/staging branch) has no defined policy — the
// caller should only require SOME valid literal, not a specific one.
export const BRANCH_STORE_MVP_POLICY = {
  main: '1',
  staging: '0',
};

/**
 * @param {string} buildCommand the vercel.json `buildCommand` string
 * @returns {{ ok: boolean, value: string|null, declaredBranch: string|null, reason: string }}
 */
export function evaluateVercelBuildCommand(buildCommand) {
  const value = extractShellEnvAssignment(buildCommand, 'EXPO_PUBLIC_STORE_MVP');
  const declaredBranch = extractShellEnvAssignment(buildCommand, 'EXPECTED_VERCEL_BRANCH');

  if (!VALID_STORE_MVP_VALUES.has(value)) {
    return {
      ok: false,
      value,
      declaredBranch,
      reason: value === null
        ? 'EXPO_PUBLIC_STORE_MVP is not explicitly set in buildCommand — this is exactly the "missing define" case that must fail closed, not fall through to the web-fail-open runtime default.'
        : `EXPO_PUBLIC_STORE_MVP is set to ${JSON.stringify(value)}, which is neither "0" nor "1".`,
    };
  }

  if (declaredBranch && Object.prototype.hasOwnProperty.call(BRANCH_STORE_MVP_POLICY, declaredBranch)) {
    const required = BRANCH_STORE_MVP_POLICY[declaredBranch];
    if (value !== required) {
      return {
        ok: false,
        value,
        declaredBranch,
        reason: `This vercel.json declares EXPECTED_VERCEL_BRANCH=${declaredBranch}, which requires EXPO_PUBLIC_STORE_MVP=${required}, but found ${JSON.stringify(value)}.`,
      };
    }
  }

  return { ok: true, value, declaredBranch, reason: 'explicit and policy-consistent' };
}

/**
 * @param {Record<string, string>} resolvedEnv output of resolveEasProfileEnv()
 * @param {string} profileName for error messages only
 * @returns {{ ok: boolean, value: string|null, reason: string }}
 */
export function evaluateEasProductionProfile(resolvedEnv, profileName) {
  const value = resolvedEnv?.EXPO_PUBLIC_STORE_MVP ?? null;
  if (value !== '1') {
    return {
      ok: false,
      value,
      reason: `eas.json build.${profileName} (after resolving extends) must set EXPO_PUBLIC_STORE_MVP="1" — got ${JSON.stringify(value)}.`,
    };
  }
  return { ok: true, value, reason: 'explicit and correct' };
}
