#!/usr/bin/env node
/**
 * DIC-P0 hBP09 — Production recognition availability validator.
 *
 * On 2026-09-24 every physical hBP09 scan against canonical Production failed:
 * POST /api/recognize-card answered 503 RECOGNITION_UNAVAILABLE for all of
 * them, because the deployment had no GEMINI_API_KEY while the catalog itself
 * carried all 244 hBP09 rows. DIC-1185 made recognition fail closed to Google
 * direct only — correctly — but nothing made a Production deploy PROVE the
 * provider is provisioned, so the exact-SHA deploy workflow kept reporting
 * green runs for a Production whose scanner could not recognise anything.
 *
 * This module is the decision procedure for the recognition smoke that closes
 * that gap: given the HTTP status and response body of one probe POST against
 * `https://holohunter.dicoge.com/api/recognize-card`, decide whether the live
 * deployment resolved a vision adapter.
 *
 * The probe is deliberately FREE. `api/recognize-card.ts` checks the provider
 * BEFORE the legibility floor (the DIC-1013 ordering), so a well-formed PNG
 * whose longest edge sits below MIN_LEGIBLE_IMAGE_PX (320) is answered without
 * ever opening a connection to the vision provider:
 *
 *   404 "照片解析度太低…"        → an adapter resolved; the handler answered
 *                                  about the photo. Zero vision tokens spent.
 *   503 RECOGNITION_UNAVAILABLE → resolveAdapters() was empty: the deployment
 *                                  has no GEMINI_API_KEY. Fatal — waiting
 *                                  cannot provision a secret.
 *
 * Deliberate boundary: this proves the deployment RESOLVES a provider, not
 * that the key is valid. Validating the key would spend a metered vision call
 * on every deploy, and an invalid key surfaces as the 502 family, which the
 * client already classifies as infrastructure failure rather than as a bad
 * photo. The P0 being prevented here is specifically the silent 503 class.
 *
 * Contract
 * --------
 *   success (0)  the live handler answered ABOUT THE PROBE PHOTO (JSON 404
 *                with success:false), or ran the vision path (JSON 200) —
 *                either one is only reachable with an adapter resolved.
 *   fatal (1)    the body carries the stable RECOGNITION_UNAVAILABLE code on
 *                any status (the deployment's own declaration that it cannot
 *                recognise anything), or the probe itself was rejected as a
 *                request (400/405: the probe/handler contract drifted), or
 *                the CLI was invoked unusably.
 *   retryable(2) everything else — connection failure (000), platform 5xx
 *                without the stable code, non-JSON edge responses, cold
 *                starts. The workflow's bounded loop decides when patience
 *                runs out, and its timeout arm fails closed.
 *
 * Diagnostics are FIXED STRINGS, same threat model as verify-alias-binding:
 * the response body is whatever answers for canonical Production and it lands
 * in a GitHub Actions log that honours ANSI sequences and `::workflow
 * command::` lines. Every printable message lives in the frozen table below;
 * the body is parsed and compared, never printed.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeDiagnostic } from './verify-alias-binding.mjs';

/** Unambiguous outcomes, mapped 1:1 onto the process exit codes. */
export const RECOGNITION_AVAILABLE = 0;
export const RECOGNITION_FATAL = 1;
export const RECOGNITION_RETRY = 2;

/** Must stay byte-identical to RECOGNITION_UNAVAILABLE_CODE in api/recognize-card.ts. */
export const RECOGNITION_UNAVAILABLE_CODE = 'RECOGNITION_UNAVAILABLE';

/**
 * A complete, valid 64×89 PNG (103 bytes, flat gray). Both edges sit far below
 * the handler's MIN_LEGIBLE_IMAGE_PX floor of 320, and the IHDR parses, so a
 * provisioned deployment answers the photo-level 404 without spending a vision
 * call — the probe's zero-cost property. scripts/test-recognition-availability-
 * validator.mjs pins that against the REAL imageLongestEdge /
 * isBelowLegibleResolution implementations, not against this comment.
 */
export const RECOGNITION_PROBE_IMAGE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABZCAAAAACr231RAAAALklEQVR42u3MQREAAAwCIKMb3Qy7fSEA6VMEAoFAIBAIBAKBQCAQCAQCgUAgOBiEfyCmm3EI9wAAAABJRU5ErkJggg==';

/** The exact POST body the deploy workflow sends. A compile-time constant. */
export const RECOGNITION_PROBE_BODY = Object.freeze({
  images: Object.freeze([RECOGNITION_PROBE_IMAGE]),
});

/**
 * The COMPLETE set of strings this module can print. Nothing outside this
 * table ever reaches stdout or stderr, so no response byte can either.
 */
export const RECOGNITION_PROBE_MESSAGES = Object.freeze({
  USAGE:
    'usage: verify-recognition-availability.mjs <httpStatus> <bodyJsonPath> | --emit-probe-body',
  BAD_STATUS:
    'The recognition probe was handed an HTTP status that is not three digits.',
  UNPROVISIONED:
    'The live deployment declared RECOGNITION_UNAVAILABLE. Recognition has no '
    + 'provisioned vision provider (GEMINI_API_KEY), and waiting cannot '
    + 'provision a secret.',
  PROBE_REJECTED:
    'The recognition endpoint rejected the probe request itself. The probe '
    + 'and the handler contract have drifted; waiting cannot repair that.',
  UNREACHABLE_RETRY:
    'The recognition probe could not reach canonical Production at all.',
  NOT_DECIDABLE_RETRY:
    'The recognition probe response was not a decidable handler answer yet.',
  AVAILABLE_PHOTO_ANSWER:
    'Recognition is provisioned: the live handler answered about the probe '
    + 'photo, which it only does once a vision adapter resolved.',
  AVAILABLE_VISION_ANSWER:
    'Recognition is provisioned: the live handler ran its vision path for the '
    + 'probe.',
});

const isThreeDigits = (v) => typeof v === 'string' && /^[0-9]{3}$/.test(v);

/**
 * Decide one probe response.
 *
 * @param {object} args
 * @param {string} args.statusText  curl's own `%{http_code}` (three digits; 000 on connection failure).
 * @param {string} args.raw         Raw response body ('' when none was written).
 * @returns {{ code: number, status: 'success'|'retry'|'fatal', reason: string, message: string }}
 */
export function evaluateRecognitionAvailability({ statusText, raw }) {
  const outcome = (code, status, reason) => ({
    code,
    status,
    reason,
    message: RECOGNITION_PROBE_MESSAGES[reason],
  });
  const success = (reason) => outcome(RECOGNITION_AVAILABLE, 'success', reason);
  const fatal = (reason) => outcome(RECOGNITION_FATAL, 'fatal', reason);
  const retry = (reason) => outcome(RECOGNITION_RETRY, 'retry', reason);

  if (!isThreeDigits(statusText)) return fatal('BAD_STATUS');
  if (statusText === '000') return retry('UNREACHABLE_RETRY');

  let record = null;
  try {
    // The exception is deliberately NOT inspected: V8 quotes a slice of the
    // offending input back inside `err.message`.
    const parsed = JSON.parse(String(raw));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      record = parsed;
    }
  } catch {
    record = null;
  }

  // The stable code is the deployment's own declaration and the client treats
  // it as authoritative on ANY status (recognitionOutcome.ts does the same),
  // so it is checked before the status arms: an unprovisioned deployment must
  // never be re-read as "retryable platform noise".
  if (record !== null && record.code === RECOGNITION_UNAVAILABLE_CODE) {
    return fatal('UNPROVISIONED');
  }

  if (statusText === '404') {
    // The handler's two 404 arms are both photo-level answers, both carry
    // success:false, and both are only reachable once resolveAdapters() found
    // a provider. A non-JSON 404 (platform router, missing function) proves
    // nothing and stays in the bounded retry lane.
    if (record !== null && record.success === false) {
      return success('AVAILABLE_PHOTO_ANSWER');
    }
    return retry('NOT_DECIDABLE_RETRY');
  }

  if (statusText === '200') {
    if (record !== null) return success('AVAILABLE_VISION_ANSWER');
    return retry('NOT_DECIDABLE_RETRY');
  }

  if (statusText === '400' || statusText === '405') {
    return fatal('PROBE_REJECTED');
  }

  // 5xx without the stable code (including a platform 503 that never came
  // from the handler), 429, redirects, and anything unrecognised: transient
  // until the workflow's bounded window says otherwise.
  return retry('NOT_DECIDABLE_RETRY');
}

/**
 * CLI:
 *   verify-recognition-availability.mjs --emit-probe-body
 *   verify-recognition-availability.mjs <httpStatus> <bodyJsonPath>
 * Exits 0 (provisioned), 2 (retryable), or 1 (fatal).
 */
export function main(argv) {
  if (argv[0] === '--emit-probe-body') {
    // A compile-time constant, and the only non-table output this module has.
    console.log(JSON.stringify(RECOGNITION_PROBE_BODY));
    return RECOGNITION_AVAILABLE;
  }

  const [statusText, jsonPath] = argv;
  if (!isThreeDigits(statusText) || typeof jsonPath !== 'string' || jsonPath.length === 0) {
    console.error(`::error::${sanitizeDiagnostic(RECOGNITION_PROBE_MESSAGES.USAGE)}`);
    return RECOGNITION_FATAL;
  }

  // A connection-level failure often leaves no readable body behind; that is
  // the retry lane's job, not a fatal contract break, so an unreadable file
  // reduces to an empty body and the status decides. The path itself is never
  // echoed.
  let raw = '';
  try {
    raw = fs.readFileSync(jsonPath, 'utf8');
  } catch {
    raw = '';
  }

  const result = evaluateRecognitionAvailability({ statusText, raw });
  const line = sanitizeDiagnostic(result.message);

  if (result.status === 'fatal') {
    console.error(`::error::${line}`);
  } else {
    console.log(line);
  }
  return result.code;
}

const invokedDirectly = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  process.exit(main(process.argv.slice(2)));
}
