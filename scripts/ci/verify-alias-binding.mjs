#!/usr/bin/env node
/**
 * DIC-1430 — canonical alias binding validator.
 *
 * This is the PRODUCTION decision procedure for the last authoritative step of
 * `.github/workflows/holohunter-exact-sha-deploy.yml`: given the body of a
 * `GET /v4/aliases/{idOrAlias}` 200 response, decide whether the canonical host
 * is bound to the deployment THIS run created.
 *
 * It lives in a committed file rather than inside a `node -e '…'` heredoc for
 * one reason: a heredoc cannot be executed by a test. The previous inline
 * version accepted an alias record with NO top-level `deploymentId` as long as
 * the optional nested `deployment.id` matched — a documented-required field had
 * become optional — and every one of the 89 string/regex checks in the
 * companion suite passed anyway, because none of them ran the code. The
 * workflow now invokes this file and the tests execute this same file.
 *
 * Contract for a 200 alias response
 * ---------------------------------
 *   fatal (1)    malformed JSON; an explicit `error` object; a missing, empty,
 *                or non-string top-level `deploymentId`; a nested
 *                `deployment.id` that is present but not a non-empty string;
 *                a nested id that contradicts the top-level id; a `deployment`
 *                value that is present but not an object.
 *   retryable(2) a well-formed record whose ids agree with each other but name
 *                a DIFFERENT deployment — ordinary alias propagation lag, or
 *                the alias genuinely sitting on somebody else's deployment.
 *                Bounded retries in the workflow decide when that runs out.
 *   success (0)  top-level `deploymentId` equals the expected deployment id,
 *                and the optional nested mirror, if present, equals it too.
 *
 * A missing top-level id is deliberately FATAL and not retryable: the alias API
 * documents it as required on a 200, so its absence means the response is not
 * the shape this gate knows how to reason about. Waiting cannot repair that,
 * and a nested-only match must never stand in for it.
 *
 * Diagnostics are FIXED STRINGS — why
 * -----------------------------------
 * Every input to this module is attacker-reachable in the threat model that
 * matters here: the alias response body is whatever the Vercel API (or anything
 * able to answer for it) hands back, and it lands verbatim in a GitHub Actions
 * log. An earlier revision of this file interpolated the JSON parse exception,
 * `error.code`, and both deployment ids into its messages. A record carrying
 * `"\u001b[2J::error::INJECTED"` therefore emitted ANSI control sequences and a
 * forged workflow command into the log — log forgery and terminal manipulation
 * driven entirely by a remote response body.
 *
 * So no diagnostic is built from response data any more. Every message this
 * module can emit is a compile-time constant in `ALIAS_BINDING_MESSAGES`, the
 * table is frozen, and `sanitizeDiagnostic` is a belt-and-braces final pass
 * that would strip control characters and bound the length even if a future
 * edit reintroduced interpolation. The response body, the caller-supplied host,
 * the response path, and the expected deployment id are all used for DECISIONS
 * and never for OUTPUT. The workflow already knows the host and the deployment
 * id it asked about, so the reason code alone is what a reader needs.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unambiguous outcomes, mapped 1:1 onto the process exit codes. */
export const ALIAS_BINDING_SUCCESS = 0;
export const ALIAS_BINDING_FATAL = 1;
export const ALIAS_BINDING_RETRY = 2;

/**
 * The COMPLETE set of strings this module can print. Nothing outside this
 * table ever reaches stdout or stderr, so no response byte can either.
 * Keyed by reason code so the workflow log and the tests can name an outcome
 * without quoting any payload.
 */
export const ALIAS_BINDING_MESSAGES = Object.freeze({
  NO_EXPECTED_ID:
    'No expected deployment id was supplied to the alias binding check.',
  UNREADABLE_RESPONSE:
    'Could not read the alias response file supplied to the alias binding check.',
  USAGE:
    'usage: verify-alias-binding.mjs <aliasJsonPath> <host> <expectedDeploymentId>',
  NOT_JSON:
    'The alias response body was not valid JSON.',
  NOT_OBJECT:
    'The alias response body was not a JSON object.',
  API_ERROR:
    'The alias API returned an explicit error object instead of an alias record.',
  MISSING_TOP_LEVEL:
    'The alias record has no usable top-level deploymentId. The alias API '
    + 'documents it as required on a 200, so a nested deployment.id cannot '
    + 'stand in for it.',
  DEPLOYMENT_NOT_OBJECT:
    'The alias record carries a deployment field that is not an object.',
  NESTED_ID_INVALID:
    'The alias record carries a deployment.id that is not a non-empty string.',
  NESTED_ID_CONFLICT:
    'The alias record contradicts itself: its top-level deploymentId and its '
    + 'nested deployment.id name different deployments.',
  BOUND_ELSEWHERE:
    'The canonical alias is bound to a different deployment than the one this '
    + 'run created.',
  BOUND_TO_THIS_RUN:
    'The canonical alias is bound to exactly the deployment this run created.',
});

/** Longest diagnostic this module will ever emit. */
export const ALIAS_BINDING_MAX_DIAGNOSTIC = 240;

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/**
 * Final guard on anything headed for a log. The table above is already made of
 * constants, so in a correct build this is a no-op — it exists so that a future
 * edit that reintroduces interpolation still cannot emit an escape sequence, a
 * forged `::workflow command::` line break, or an unbounded dump.
 *
 * Removing control bytes and bounding the length is not sufficient on its own.
 * A runner reads a line beginning `::name::value` as a COMMAND rather than as
 * text, so `::add-mask::x` is an injection even though every byte in it is
 * printable and the line is short. The guard therefore also breaks up any
 * colon run that could form such a marker.
 *
 * Two ordering details carry the correctness, and fixtures in
 * scripts/test-alias-binding-validator.mjs pin both:
 *
 *   * control bytes are replaced by a SPACE, never deleted, and that happens
 *     BEFORE the colon pass. Deleting them — or spacing them afterwards —
 *     could pull two separated colons together and manufacture the very
 *     marker this step exists to remove;
 *   * a colon run is split as a WHOLE. Rewriting each `::` pair on its own
 *     turns `:::` into `: ::` and leaves a live marker behind.
 *
 * Single colons are left alone, so the fixed diagnostics — the usage line in
 * particular — still read normally.
 */
export function sanitizeDiagnostic(text) {
  return String(text)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/:{2,}/g, (run) => run.split('').join(' '))
    .slice(0, ALIAS_BINDING_MAX_DIAGNOSTIC);
}

/**
 * Decide a 200 alias response.
 *
 * `host` is accepted so the CLI contract matches what the workflow passes, and
 * because a caller must name what it is asking about; it is never printed.
 *
 * @param {object}  args
 * @param {string}  args.raw          Raw response body.
 * @param {string}  args.host         Canonical host the alias record is for.
 * @param {string}  args.expectedDeploymentId  This run's deployment id.
 * @returns {{ code: number, status: 'success'|'retry'|'fatal', reason: string, message: string }}
 */
export function evaluateAliasBinding({ raw, host, expectedDeploymentId }) {
  const outcome = (code, status, reason) => ({
    code,
    status,
    reason,
    message: ALIAS_BINDING_MESSAGES[reason],
  });
  const fatal = (reason) => outcome(ALIAS_BINDING_FATAL, 'fatal', reason);
  const retry = (reason) => outcome(ALIAS_BINDING_RETRY, 'retry', reason);

  // The caller must name the deployment it is asking about; an empty expected
  // id would otherwise make "bound to nothing" look like agreement.
  if (!isNonEmptyString(expectedDeploymentId)) {
    return fatal('NO_EXPECTED_ID');
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch {
    // The exception is deliberately NOT inspected: V8 quotes a slice of the
    // offending input back inside `err.message`, which would put attacker
    // bytes straight into the Actions log.
    return fatal('NOT_JSON');
  }

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return fatal('NOT_OBJECT');
  }

  if (record.error !== undefined && record.error !== null) {
    // Neither `error.code` nor `error.message` is reported: both are remote
    // strings. The HTTP status the workflow already logged is the bounded,
    // locally-derived signal a reader needs.
    return fatal('API_ERROR');
  }

  // ── Required top-level id ────────────────────────────────────────────────
  // Checked BEFORE the nested mirror and independently of it. This is the
  // exact regression the inline validator carried: it collected whichever ids
  // happened to be well-formed and was satisfied by a nested-only match.
  const topLevel = record.deploymentId;
  if (!isNonEmptyString(topLevel)) {
    return fatal('MISSING_TOP_LEVEL');
  }

  // ── Optional nested mirror ───────────────────────────────────────────────
  const deployment = record.deployment;
  if (deployment !== undefined && deployment !== null) {
    if (typeof deployment !== 'object' || Array.isArray(deployment)) {
      return fatal('DEPLOYMENT_NOT_OBJECT');
    }
    if (Object.prototype.hasOwnProperty.call(deployment, 'id')) {
      const nested = deployment.id;
      if (!isNonEmptyString(nested)) {
        return fatal('NESTED_ID_INVALID');
      }
      if (nested !== topLevel) {
        return fatal('NESTED_ID_CONFLICT');
      }
    }
  }

  // ── Agreement with this run ──────────────────────────────────────────────
  // Well-formed and self-consistent, but naming another deployment: that is
  // propagation state, not a broken contract, so the workflow may wait.
  if (topLevel !== expectedDeploymentId) {
    return retry('BOUND_ELSEWHERE');
  }

  return outcome(ALIAS_BINDING_SUCCESS, 'success', 'BOUND_TO_THIS_RUN');
}

/**
 * CLI: verify-alias-binding.mjs <aliasJsonPath> <host> <expectedDeploymentId>
 * Exits 0 (bound to this run), 2 (retryable), or 1 (fatal).
 */
export function main(argv) {
  const [jsonPath, host, expectedDeploymentId] = argv;

  // The path is validated but never echoed: it arrives from the caller and has
  // no place in a log line the caller already knows the content of.
  if (!isNonEmptyString(jsonPath) || !isNonEmptyString(host)) {
    console.error(`::error::${sanitizeDiagnostic(ALIAS_BINDING_MESSAGES.USAGE)}`);
    return ALIAS_BINDING_FATAL;
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch {
    // `err.message` carries the full filesystem path and the OS error text;
    // neither is needed to act on this and both are caller-controlled.
    console.error(
      `::error::${sanitizeDiagnostic(ALIAS_BINDING_MESSAGES.UNREADABLE_RESPONSE)}`,
    );
    return ALIAS_BINDING_FATAL;
  }

  const result = evaluateAliasBinding({ raw, host, expectedDeploymentId });
  const line = sanitizeDiagnostic(result.message);

  if (result.status === 'fatal') {
    console.error(`::error::${line}`);
  } else {
    // Retryable and success are both ordinary progress reporting; the workflow
    // decides what to do with the exit code.
    console.log(line);
  }
  return result.code;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
