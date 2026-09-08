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

// Extracts EXPECTED_VERCEL_BRANCH ONLY if it is bound as a literal shell
// env-prefix directly attached to the `vercel-branch-guard.sh` invocation
// itself, e.g. `EXPECTED_VERCEL_BRANCH=main bash scripts/ci/vercel-branch-guard.sh`.
// POSIX shell scopes a leading `VAR=val` assignment to the single command it
// prefixes, so an assignment anywhere else in the `&&`-chained buildCommand
// (a preceding unrelated value, or one in a later link) never reaches the
// branch-guard script and therefore never gates the deploy. Returns null if
// the branch is missing OR not actually bound to the guard invocation.
//
// Regression coverage (DIC-1401 CR round 2, Mac-Codex): the previous
// position-agnostic extraction returned a false "ok: true" for:
//   - "EXPECTED_VERCEL_BRANCH=main true && EXPECTED_VERCEL_BRANCH=staging
//      bash scripts/ci/vercel-branch-guard.sh && EXPO_PUBLIC_STORE_MVP=1
//      expo export --platform web"
// The earlier `main` assignment never reaches the guard's environment (it is
// scoped to `true`), so the runtime deploys under the staging policy while
// the static guard claimed `main` — the exact "main 才能部署 Web Production"
// contract violation this binding now makes fail closed.
export function extractBranchGuardAssignment(buildCommand) {
  if (typeof buildCommand !== 'string') return null;
  const segments = buildCommand.split('&&').map((segment) => segment.trim());
  const guardSegment = segments.find((segment) => /\bvercel-branch-guard\.sh(?:\s|$)/.test(segment));
  if (!guardSegment) return null;

  // The only place the branch assignment can legally appear is a contiguous
  // run of `NAME=value` tokens at the very start of this segment, immediately
  // followed by the `bash|sh|./ scripts/.../vercel-branch-guard.sh` command.
  const prefixMatch = guardSegment.match(
    /^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*(?:bash|sh)\s+.*\bvercel-branch-guard\.sh\b)/,
  );
  if (!prefixMatch) return null;

  const branchMatch = prefixMatch[1].match(/(?:^|\s)EXPECTED_VERCEL_BRANCH=(\S+)/);
  return branchMatch ? branchMatch[1] : null;
}

// Extracts EXPO_PUBLIC_STORE_MVP's value ONLY if it is bound as a literal
// shell env-prefix directly attached to the `expo export` invocation itself,
// i.e. `VAR=val [VAR2=val2 ...] expo export ...`. POSIX shell scopes a
// leading `VAR=val` assignment to the single command it prefixes — an
// assignment anywhere else in the `&&`-chained buildCommand (before an
// unrelated command, or after `expo export` already ran) never reaches the
// `expo export` process's environment and therefore never reaches the
// bundled web output. Returns null if the define is missing OR present but
// not actually bound to `expo export` (both must fail closed identically —
// a config author cannot satisfy this guard by placing the assignment
// anywhere convenient in the command chain).
//
// Regression coverage (DIC-1401 exact-head CR, Mac-Codex): this function
// exists because the previous position-agnostic extraction returned a false
// "ok: true" for both:
//   - "expo export --platform web && EXPO_PUBLIC_STORE_MVP=1 true"
//   - "EXPO_PUBLIC_STORE_MVP=1 npm run unrelated && expo export --platform web"
// Neither actually injects the define into the web bundle.
function extractStoreMvpBoundToExpoExport(buildCommand) {
  if (typeof buildCommand !== 'string') return null;
  const segments = buildCommand.split('&&').map((segment) => segment.trim());
  const exportSegment = segments.find((segment) => /(?:^|\s)expo\s+export(?:\s|$)/.test(segment));
  if (!exportSegment) return null;

  // The only place a shell env-prefix can legally appear is a contiguous run
  // of `NAME=value` tokens at the very start of this segment, immediately
  // followed by the `expo export` command itself.
  const prefixMatch = exportSegment.match(/^((?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*)expo\s+export\b/);
  if (!prefixMatch) return null;

  const varMatch = prefixMatch[1].match(/(?:^|\s)EXPO_PUBLIC_STORE_MVP=(\S+)/);
  return varMatch ? varMatch[1] : null;
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
  const value = extractStoreMvpBoundToExpoExport(buildCommand);
  const declaredBranch = extractBranchGuardAssignment(buildCommand);

  if (!VALID_STORE_MVP_VALUES.has(value)) {
    return {
      ok: false,
      value,
      declaredBranch,
      reason: value === null
        ? 'EXPO_PUBLIC_STORE_MVP is not explicitly set as a shell-env prefix directly attached to the `expo export` invocation — either it is entirely missing, or it is assigned elsewhere in the buildCommand chain where POSIX shell scoping means it never reaches `expo export`\'s environment. This is exactly the "missing define" case that must fail closed, not fall through to the web-fail-open runtime default.'
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
