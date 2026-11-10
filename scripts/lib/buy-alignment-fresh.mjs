/**
 * buy-alignment-fresh.mjs — which buy quotes count as "fresh" when VERIFYING a committed artifact
 * (2026-11-10, PR #287 repair).
 *
 * The merge (merge-buy-prices.js) decides fresh vs retained from its run proof (`db.buyQuoteRun`,
 * review N5/N7): a quote is fresh only when observed at/after the run start (HUNTERCARD_RUN_STARTED_AT)
 * and within 18h of the merge clock; with NO run marker nothing is fresh and every proven quote is
 * RETAINED with its own source/time. The byte-identity gate (regen-buy-alignment.mjs
 * regenerateCommitted) already reproduces exactly that contract. verify-buy-price-alignment.mjs
 * predated it and re-derived "fresh" from snapshot age (latest source timestamp + 1s, no run start),
 * so for a no-marker artifact it expected this run's retained quotes to be fresh assignments.
 *
 * This module gives the verifier the SAME contract, fail closed:
 *   - artifact WITHOUT buyQuoteRun → legacy snapshot semantics (unchanged);
 *   - artifact WITH a buyQuoteRun that validRunProof accepts (bound to the exact source bytes, carry
 *     digest consistent, merge-rule audit) → the merge's own fresh index (empty without a run marker)
 *     plus its not-fresh bound evidence;
 *   - artifact WITH an invalid / stale buyQuoteRun, or one whose retained audit has any violation
 *     → mode 'invalid-run-proof' (the verifier fails; nothing is treated as fresh).
 * Retained source coverage is classified independently in buy-retained-coverage.mjs (review R1 P1-1).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildBuyIndex, notFreshBoundEvidence, MAX_SOURCE_AGE_HOURS } from '../merge-buy-prices.js';
import { latestSourceTs, validRunProof } from '../regen-buy-alignment.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FUTURE_SKEW_MS = 5 * 60 * 1000; // same tolerance as merge-buy-prices.js
const AGE_MS = MAX_SOURCE_AGE_HOURS * 3600 * 1000;

export function defaultBuyDir() {
  return process.env.HUNTERCARD_BUY_PRICES_DIR || path.join(__dirname, '../../data/buy-prices');
}

/**
 * @param {object} rawDb  the parsed artifact (top level, with `cards` and optional `buyQuoteRun`)
 * @returns {{ mode: 'snapshot'|'run-proof'|'invalid-run-proof', proof: object|null, now: number,
 *   runStartedAt: number|null|undefined, freshIndex: Map, boundEvidence: Map, isFresh: (t:number)=>boolean }}
 */
export function freshContextForArtifact(rawDb, { buyDir = defaultBuyDir() } = {}) {
  const present = !!rawDb && typeof rawDb === 'object' && Object.hasOwn(rawDb, 'buyQuoteRun');
  if (!present) {
    const now = latestSourceTs(buyDir) + 1000;
    return {
      mode: 'snapshot', proof: null, now, runStartedAt: undefined,
      freshIndex: buildBuyIndex(now, { dir: buyDir }), boundEvidence: new Map(),
      // exactly the original independent-invariant filter (18h only)
      isFresh: (t) => Number.isFinite(t) && !(now - t > AGE_MS),
    };
  }
  const proof = validRunProof(rawDb, buyDir);
  if (!proof) {
    return { mode: 'invalid-run-proof', reason: 'proof malformed / source bytes or carry digest mismatch', proof: null, now: NaN, runStartedAt: undefined,
      freshIndex: new Map(), boundEvidence: new Map(), isFresh: () => false };
  }
  // A proof whose retained audit has ANY violation certifies nothing: fail closed with nothing
  // fresh (a faked run marker on a no-marker artifact must never turn its quotes into fresh ones).
  const violations = proof.audit && proof.audit.violations;
  if (!(violations instanceof Map) || violations.size > 0) {
    return { mode: 'invalid-run-proof', reason: `retained audit violations: ${violations instanceof Map ? violations.size : 'missing'}`, proof,
      now: NaN, runStartedAt: undefined, freshIndex: new Map(), boundEvidence: new Map(), isFresh: () => false };
  }
  const { now, runStartedAt } = proof;
  return {
    mode: 'run-proof', proof, now, runStartedAt,
    freshIndex: runStartedAt == null ? new Map() : buildBuyIndex(now, { dir: buyDir, notBefore: runStartedAt }),
    boundEvidence: notFreshBoundEvidence(buyDir, now, runStartedAt),
    // the merge's own fresh rule (merge-buy-prices.js buildBuyIndex + notBefore)
    isFresh: (t) => runStartedAt != null && Number.isFinite(t) && t >= runStartedAt && !(now - t > AGE_MS) && !(t > now + FUTURE_SKEW_MS),
  };
}

/**
 * The verifier's run-proof gate as a pure function (shared with the regression so a non-zero audit
 * is proven to fail it). Empty = pass; a legacy artifact without buyQuoteRun has no proof to check.
 */
export function runProofProblems(ctx) {
  if (ctx.mode === 'snapshot') return [];
  const p = [];
  if (ctx.mode !== 'run-proof') p.push(`buyQuoteRun present but not a valid run proof (${ctx.reason || ctx.mode}) → fail closed`);
  const v = ctx.proof && ctx.proof.audit && ctx.proof.audit.violations;
  if (!(v instanceof Map)) p.push('run proof has no retained audit result');
  else if (v.size > 0) p.push(`retained audit violations ${v.size}: ${[...v].slice(0, 5).map(([k, w]) => `${k.replace('\u0000', ' :: ')}=${w}`).join(', ')}`);
  return p;
}
