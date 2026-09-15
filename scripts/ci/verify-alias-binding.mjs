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
 * Nothing here logs a secret: the only inputs are an alias response body, a
 * public hostname, and a Vercel deployment id. Raw response bodies are never
 * echoed — only bounded, specific diagnostics.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Unambiguous outcomes, mapped 1:1 onto the process exit codes. */
export const ALIAS_BINDING_SUCCESS = 0;
export const ALIAS_BINDING_FATAL = 1;
export const ALIAS_BINDING_RETRY = 2;

const isNonEmptyString = (v) => typeof v === 'string' && v.length > 0;

/** Describe a bad value without ever reproducing an arbitrary payload. */
function describe(value) {
  if (value === undefined) return 'absent';
  if (value === null) return 'null';
  if (typeof value === 'string') return value.length === 0 ? 'an empty string' : 'a string';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Decide a 200 alias response.
 *
 * @param {object}  args
 * @param {string}  args.raw          Raw response body.
 * @param {string}  args.host         Canonical host the alias record is for.
 * @param {string}  args.expectedDeploymentId  This run's deployment id.
 * @returns {{ code: number, status: 'success'|'retry'|'fatal', message: string }}
 */
export function evaluateAliasBinding({ raw, host, expectedDeploymentId }) {
  const fatal = (message) => ({ code: ALIAS_BINDING_FATAL, status: 'fatal', message });
  const retry = (message) => ({ code: ALIAS_BINDING_RETRY, status: 'retry', message });

  // The caller must name the deployment it is asking about; an empty expected
  // id would otherwise make "bound to nothing" look like agreement.
  if (!isNonEmptyString(expectedDeploymentId)) {
    return fatal('No expected deployment id was supplied to the alias binding check.');
  }

  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return fatal(`Alias record for ${host} was not valid JSON: ${err.message}`);
  }

  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return fatal(`Alias record for ${host} was ${describe(record)}, not an object.`);
  }

  if (record.error !== undefined && record.error !== null) {
    // Report the API's own error code/message only — never the whole body.
    const code = record.error?.code;
    return fatal(
      `Alias API returned an error for ${host}`
        + `${isNonEmptyString(code) ? ` (code=${code})` : ''}.`,
    );
  }

  // ── Required top-level id ────────────────────────────────────────────────
  // Checked BEFORE the nested mirror and independently of it. This is the
  // exact regression the inline validator carried: it collected whichever ids
  // happened to be well-formed and was satisfied by a nested-only match.
  const topLevel = record.deploymentId;
  if (!isNonEmptyString(topLevel)) {
    return fatal(
      `Alias record for ${host} has no usable top-level deploymentId `
        + `(${describe(topLevel)}); the alias API documents it as required on a 200, `
        + 'so a nested deployment.id cannot stand in for it.',
    );
  }

  // ── Optional nested mirror ───────────────────────────────────────────────
  const deployment = record.deployment;
  if (deployment !== undefined && deployment !== null) {
    if (typeof deployment !== 'object' || Array.isArray(deployment)) {
      return fatal(
        `Alias record for ${host} carries a deployment field that is ${describe(deployment)}, not an object.`,
      );
    }
    if (Object.prototype.hasOwnProperty.call(deployment, 'id')) {
      const nested = deployment.id;
      if (!isNonEmptyString(nested)) {
        return fatal(
          `Alias record for ${host} carries a deployment.id that is ${describe(nested)}, `
            + 'not a non-empty string.',
        );
      }
      if (nested !== topLevel) {
        return fatal(
          `Alias record for ${host} contradicts itself: deploymentId=${topLevel} `
            + `but deployment.id=${nested}.`,
        );
      }
    }
  }

  // ── Agreement with this run ──────────────────────────────────────────────
  // Well-formed and self-consistent, but naming another deployment: that is
  // propagation state, not a broken contract, so the workflow may wait.
  if (topLevel !== expectedDeploymentId) {
    return retry(
      `${host} is bound to ${topLevel}, not this run deployment ${expectedDeploymentId}.`,
    );
  }

  return {
    code: ALIAS_BINDING_SUCCESS,
    status: 'success',
    message: `${host} is bound to exactly this run deployment ${expectedDeploymentId}.`,
  };
}

/**
 * CLI: verify-alias-binding.mjs <aliasJsonPath> <host> <expectedDeploymentId>
 * Exits 0 (bound to this run), 2 (retryable), or 1 (fatal).
 */
export function main(argv) {
  const [jsonPath, host, expectedDeploymentId] = argv;

  if (!isNonEmptyString(jsonPath) || !isNonEmptyString(host)) {
    console.error(
      '::error::usage: verify-alias-binding.mjs <aliasJsonPath> <host> <expectedDeploymentId>',
    );
    return ALIAS_BINDING_FATAL;
  }

  let raw;
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch (err) {
    console.error(`::error::Could not read the alias response at ${jsonPath}: ${err.message}`);
    return ALIAS_BINDING_FATAL;
  }

  const result = evaluateAliasBinding({ raw, host, expectedDeploymentId });

  if (result.status === 'fatal') {
    console.error(`::error::${result.message}`);
  } else {
    // Retryable and success are both ordinary progress reporting; the workflow
    // decides what to do with the exit code.
    console.log(result.message);
  }
  return result.code;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
