#!/usr/bin/env node
/**
 * DIC-1430 — BEHAVIOURAL tests for the canonical alias binding validator.
 *
 * Why this file exists
 * --------------------
 * The companion suite `test-exact-sha-production-recovery.mjs` asserts the
 * SHAPE of the deploy workflow: which endpoints it calls, which it must never
 * call, what order the steps run in. Those checks are string and regex matches
 * over YAML, and they are worth keeping — but they cannot see behaviour. The
 * inline alias validator shipped a High-severity bug (a missing top-level
 * `deploymentId` was accepted whenever the optional nested `deployment.id`
 * matched) and all 89 of those checks passed, because not one of them ran the
 * validator.
 *
 * So this file executes the REAL production module —
 * `scripts/ci/verify-alias-binding.mjs`, the same file the workflow invokes —
 * against fixtures. Two ways, deliberately:
 *
 *   * by import, to assert the decision and its message; and
 *   * by subprocess, to assert the process EXIT CODE the workflow branches on,
 *     since a correct decision reported through the wrong exit code would let
 *     a fatal record retry, or a mismatch be read as success.
 *
 * There is no second copy of the validator here. The only re-implementations in
 * this file are `priorInlineValidator` and `priorInterpolatingDiagnostic` — the
 * OLD, buggy decision and the OLD, leaky message construction, preserved solely
 * to prove both regressions are really gone and would be caught again.
 *
 * The second dimension: diagnostics
 * ---------------------------------
 * Everything this module is handed is attacker-reachable. The alias response
 * body is whatever the Vercel API — or anything able to answer for it — returns,
 * and it is read inside a GitHub Actions job whose log honours ANSI control
 * sequences and `::workflow command::` lines. An earlier revision interpolated
 * the JSON parse exception, `error.code`, and both deployment ids into its
 * messages, so a record carrying `"\u001b[2J::error::INJECTED"` printed a screen
 * clear and a forged workflow command into the log verbatim.
 *
 * So the fixtures below are not only shape fixtures. They carry ANSI escapes,
 * CR/LF, and command-like markers in every field the validator touches — plus
 * malformed JSON whose parse error quotes the payload back — and they are run
 * through BOTH paths. The assertions are that the decision is unchanged and
 * that not one attacker byte reaches stdout or stderr.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ALIAS_BINDING_FATAL,
  ALIAS_BINDING_MAX_DIAGNOSTIC,
  ALIAS_BINDING_MESSAGES,
  ALIAS_BINDING_RETRY,
  ALIAS_BINDING_SUCCESS,
  evaluateAliasBinding,
  sanitizeDiagnostic,
} from './ci/verify-alias-binding.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HELPER = path.join(ROOT, 'scripts', 'ci', 'verify-alias-binding.mjs');

const HOST = 'holohunter.dicoge.com';
const THIS_RUN = 'dpl_thisRunDeployment0000000001';
const OTHER_RUN = 'dpl_someoneElsesDeployment000002';

let passed = 0;
function check(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

/** Run the production helper as the workflow does, and return its exit code. */
function runHelper(raw, expectedId = THIS_RUN, host = HOST) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-binding-'));
  const file = path.join(dir, 'alias-binding.json');
  try {
    fs.writeFileSync(file, raw);
    const r = spawnSync(process.execPath, [HELPER, file, host, expectedId], {
      encoding: 'utf8',
    });
    return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const decide = (raw, expectedId = THIS_RUN) =>
  evaluateAliasBinding({ raw, host: HOST, expectedDeploymentId: expectedId });

// ─────────────────────────────────────────────────────────────────────────
// Fixtures — every shape the alias API can hand back on a 200, plus the
// shapes that mean the response is not trustworthy at all.
// ─────────────────────────────────────────────────────────────────────────
const FIXTURES = [
  {
    name: 'valid, top-level id only (nested mirror absent)',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }),
    expect: 'success',
  },
  {
    name: 'valid, top-level id with a matching nested deployment.id',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: THIS_RUN, url: 'holocard-hunter.vercel.app' },
    }),
    expect: 'success',
  },
  {
    name: 'malformed JSON',
    raw: '{"alias": "holohunter.dicoge.com", "deploymentId": ',
    expect: 'fatal',
  },
  {
    name: 'explicit API error object',
    raw: JSON.stringify({ error: { code: 'forbidden', message: 'Not authorized' } }),
    expect: 'fatal',
  },
  {
    name: 'THE REGRESSION: top-level id absent, nested deployment.id matches',
    raw: JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is an empty string',
    raw: JSON.stringify({ alias: HOST, deploymentId: '' }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is the wrong type (number)',
    raw: JSON.stringify({ alias: HOST, deploymentId: 12345 }),
    expect: 'fatal',
  },
  {
    name: 'top-level id is null',
    raw: JSON.stringify({ alias: HOST, deploymentId: null }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment.id conflicts with the top-level id',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: OTHER_RUN },
    }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment.id is present but the wrong type',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: { nested: true } },
    }),
    expect: 'fatal',
  },
  {
    name: 'nested deployment is present but not an object',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN, deployment: 'dpl_x' }),
    expect: 'fatal',
  },
  {
    name: 'response body is a JSON array, not an object',
    raw: JSON.stringify([{ deploymentId: THIS_RUN }]),
    expect: 'fatal',
  },
  {
    name: 'well-formed but bound to a DIFFERENT deployment (propagation)',
    raw: JSON.stringify({ alias: HOST, deploymentId: OTHER_RUN }),
    expect: 'retry',
  },
  {
    name: 'well-formed, different deployment, nested mirror agrees (propagation)',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: OTHER_RUN,
      deployment: { id: OTHER_RUN },
    }),
    expect: 'retry',
  },
  {
    name: 'nested deployment object present without an id key (mirror optional)',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { url: 'holocard-hunter.vercel.app' },
    }),
    expect: 'success',
  },
];

const CODE_FOR = {
  success: ALIAS_BINDING_SUCCESS,
  fatal: ALIAS_BINDING_FATAL,
  retry: ALIAS_BINDING_RETRY,
};

console.log('\nAlias binding validator — in-process decisions (production module):');
for (const f of FIXTURES) {
  const got = decide(f.raw);
  check(
    `${f.name} → ${f.expect}`,
    got.status === f.expect && got.code === CODE_FOR[f.expect],
    `got status=${got.status} code=${got.code}: ${got.message}`,
  );
}

console.log('\nAlias binding validator — process exit codes (as the workflow reads them):');
for (const f of FIXTURES) {
  const r = runHelper(f.raw);
  check(
    `${f.name} → exit ${CODE_FOR[f.expect]}`,
    r.code === CODE_FOR[f.expect],
    `got exit ${r.code}; stderr=${r.stderr.trim().slice(0, 200)}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// The three outcomes must stay mutually distinguishable. A validator whose
// fatal and retryable states collide would either hang a broken record
// through the whole window or abort on ordinary propagation lag.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nExit codes are unambiguous:');
check(
  'success / retry / fatal are three distinct codes',
  new Set([ALIAS_BINDING_SUCCESS, ALIAS_BINDING_RETRY, ALIAS_BINDING_FATAL]).size === 3,
);
check('success is exit 0 (the only code a shell reads as pass)', ALIAS_BINDING_SUCCESS === 0);
check('fatal is exit 1', ALIAS_BINDING_FATAL === 1);
check('retryable is exit 2, never 0 and never 1', ALIAS_BINDING_RETRY === 2);

// ─────────────────────────────────────────────────────────────────────────
// Diagnostics: fatal states must be loud, and nothing may echo the payload.
// ─────────────────────────────────────────────────────────────────────────
console.log('\nDiagnostics:');
{
  const r = runHelper(JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } }));
  check(
    'the missing-top-level fatal is annotated with ::error:: for the Actions log',
    /::error::/.test(r.stderr),
    `stderr=${r.stderr.trim().slice(0, 200)}`,
  );
  check(
    'the missing-top-level fatal names the required top-level field',
    /top-level deploymentId/i.test(r.stderr),
  );
}
{
  // A response body carrying a credential-shaped value must not be echoed back
  // into the log by the diagnostics path.
  const raw = JSON.stringify({
    error: { code: 'forbidden', message: 'token sk_live_SHOULD_NEVER_BE_LOGGED' },
    secretish: 'sk_live_SHOULD_NEVER_BE_LOGGED',
  });
  const r = runHelper(raw);
  check(
    'an explicit API error is fatal',
    r.code === ALIAS_BINDING_FATAL,
    `got exit ${r.code}`,
  );
  check(
    'the raw alias body is never echoed into the log',
    !r.stdout.includes('SHOULD_NEVER_BE_LOGGED')
      && !r.stderr.includes('SHOULD_NEVER_BE_LOGGED'),
    'diagnostics must be bounded and specific, never a payload dump',
  );
}
{
  const r = runHelper(JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }), '');
  check(
    'an empty expected deployment id is fatal, never an accidental match',
    r.code === ALIAS_BINDING_FATAL,
    `got exit ${r.code}`,
  );
}
{
  const r = spawnSync(process.execPath, [HELPER], { encoding: 'utf8' });
  check(
    'the helper fails closed when invoked with no arguments',
    r.status === ALIAS_BINDING_FATAL,
    `got exit ${r.status}`,
  );
}
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-binding-missing-'));
  const r = spawnSync(
    process.execPath,
    [HELPER, path.join(dir, 'nope.json'), HOST, THIS_RUN],
    { encoding: 'utf8' },
  );
  fs.rmSync(dir, { recursive: true, force: true });
  check(
    'an unreadable alias response file is fatal, not a silent pass',
    r.status === ALIAS_BINDING_FATAL,
    `got exit ${r.status}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// ADVERSARIAL DIAGNOSTICS
// ─────────────────────────────────────────────────────────────────────────
// Every fixture below is a well-formed HTTP 200 body (or a deliberately
// malformed one) carrying content designed to escape the log line it lands in.
// The decision must be unaffected; the output must contain none of it.
const ESC = '\u001b';
const ANSI_CLEAR = `${ESC}[2J`;
const ANSI_RED = `${ESC}[31m`;
const CMD_WARN = '::warning::INJECTED';
const CMD_ERROR = '::error::INJECTED';
const CRLF = '\r\n';
const BEL = '\u0007';
const NUL = '\u0000';

/** A bare marker is the shape whose V8 parse error quotes it back in full. */
const PARSE_FRAGMENT = '::error::INJECTED_PARSE_FRAGMENT';

const ATTACK_MARKERS = ['INJECTED', 'SHOULD_NEVER_BE_LOGGED'];
/** Every control character except LF, the single legitimate line terminator. */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = /[\u0000-	\u000b-\u001f\u007f-\u009f]/;
/** No diagnostic line may exceed this, prefix included. */
const MAX_OUTPUT = 300;

/** Everything a log line must never contain, named so failures are readable. */
function attackerBytesIn(text) {
  const hits = [];
  for (const m of ATTACK_MARKERS) {
    if (text.includes(m)) hits.push(`marker:${m}`);
  }
  if (CONTROL_CHARS.test(text)) hits.push('control-characters');
  if (text.split('\n').filter((l) => l.length > 0).length > 1) hits.push('multi-line-output');
  if (text.length > MAX_OUTPUT) hits.push(`unbounded-output:${text.length}`);
  return hits;
}

const MALICIOUS_ID = `dpl_${ANSI_CLEAR}${CMD_ERROR}${CRLF}evil`;
const MALICIOUS_OTHER_ID = `dpl_${ANSI_RED}${CMD_WARN}${BEL}other`;
const MALICIOUS_HOST = `holohunter.dicoge.com${CRLF}${CMD_WARN}${ANSI_RED}`;

const ATTACKS = [
  {
    name: 'ANSI escape sequences in error.code',
    raw: JSON.stringify({ error: { code: `${ANSI_RED}${ANSI_CLEAR}forbidden` } }),
    expect: 'fatal',
  },
  {
    name: 'command-like markers and CRLF in error.code and error.message',
    raw: JSON.stringify({
      error: { code: `${CMD_ERROR}${CRLF}`, message: `${CMD_WARN}${CRLF}SHOULD_NEVER_BE_LOGGED` },
    }),
    expect: 'fatal',
  },
  {
    name: 'malicious top-level deploymentId naming another deployment',
    raw: JSON.stringify({ alias: HOST, deploymentId: MALICIOUS_OTHER_ID }),
    expect: 'retry',
  },
  {
    name: 'malicious top-level deploymentId that matches a malicious expected id',
    raw: JSON.stringify({ alias: HOST, deploymentId: MALICIOUS_ID }),
    expectedId: MALICIOUS_ID,
    expect: 'success',
  },
  {
    name: 'malicious nested deployment.id contradicting the top-level id',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: MALICIOUS_OTHER_ID },
    }),
    expect: 'fatal',
  },
  {
    name: 'malicious nested deployment.id of the wrong type',
    raw: JSON.stringify({
      alias: HOST,
      deploymentId: THIS_RUN,
      deployment: { id: { evil: `${CMD_ERROR}${CRLF}` } },
    }),
    expect: 'fatal',
  },
  {
    name: 'malicious deployment field that is a string, not an object',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN, deployment: MALICIOUS_ID }),
    expect: 'fatal',
  },
  {
    name: 'THE REGRESSION carrying an injection: no top-level id, malicious nested id',
    raw: JSON.stringify({ alias: HOST, deployment: { id: MALICIOUS_ID } }),
    expect: 'fatal',
  },
  {
    name: 'malformed JSON whose parse error quotes the attacker fragment in full',
    raw: PARSE_FRAGMENT,
    expect: 'fatal',
  },
  {
    name: 'malformed JSON leading with an ANSI escape',
    raw: `${ANSI_CLEAR}${CMD_ERROR}{`,
    expect: 'fatal',
  },
  {
    name: 'truncated JSON with a marker inside the unterminated value',
    raw: `{"alias": "${HOST}", "deploymentId": "${CMD_WARN}`,
    expect: 'fatal',
  },
  {
    name: 'malformed JSON carrying a NUL byte',
    raw: `{${NUL}${CMD_ERROR}`,
    expect: 'fatal',
  },
  {
    name: 'a JSON array of malicious records',
    raw: JSON.stringify([{ deploymentId: MALICIOUS_ID }]),
    expect: 'fatal',
  },
  {
    name: 'malicious caller host with a well-formed record naming another deployment',
    raw: JSON.stringify({ alias: HOST, deploymentId: OTHER_RUN }),
    host: MALICIOUS_HOST,
    expect: 'retry',
  },
  {
    name: 'malicious caller host on the success path',
    raw: JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }),
    host: MALICIOUS_HOST,
    expect: 'success',
  },
  {
    name: 'everything at once: ANSI + CRLF + markers in every field the validator reads',
    raw: JSON.stringify({
      alias: `${ANSI_CLEAR}${CMD_WARN}`,
      error: { code: `${CMD_ERROR}${CRLF}`, message: `${BEL}SHOULD_NEVER_BE_LOGGED` },
      deploymentId: MALICIOUS_ID,
      deployment: { id: MALICIOUS_OTHER_ID, url: `${ANSI_RED}${CMD_WARN}` },
    }),
    host: MALICIOUS_HOST,
    expectedId: MALICIOUS_ID,
    expect: 'fatal',
  },
];

const FIXED_MESSAGES = new Set(Object.values(ALIAS_BINDING_MESSAGES));

console.log('\nAdversarial fixtures — in-process decisions and messages:');
for (const a of ATTACKS) {
  const got = evaluateAliasBinding({
    raw: a.raw,
    host: a.host ?? HOST,
    expectedDeploymentId: a.expectedId ?? THIS_RUN,
  });
  check(
    `${a.name} → ${a.expect}`,
    got.status === a.expect && got.code === CODE_FOR[a.expect],
    `got status=${got.status} code=${got.code}`,
  );
  check(
    `${a.name} → message is a fixed table entry, not built from the payload`,
    FIXED_MESSAGES.has(got.message),
    `message was ${JSON.stringify(got.message)}`,
  );
  const leaks = attackerBytesIn(got.message);
  check(
    `${a.name} → message carries no attacker bytes`,
    leaks.length === 0,
    `leaked: ${leaks.join(', ')}`,
  );
}

console.log('\nAdversarial fixtures — subprocess stdout/stderr (what the log receives):');
for (const a of ATTACKS) {
  const r = runHelper(a.raw, a.expectedId ?? THIS_RUN, a.host ?? HOST);
  check(
    `${a.name} → exit ${CODE_FOR[a.expect]}`,
    r.code === CODE_FOR[a.expect],
    `got exit ${r.code}`,
  );
  const combined = r.stdout + r.stderr;
  const leaks = attackerBytesIn(combined);
  check(
    `${a.name} → nothing attacker-controlled reaches stdout/stderr`,
    leaks.length === 0,
    `leaked: ${leaks.join(', ')} in ${JSON.stringify(combined.slice(0, 200))}`,
  );
  check(
    `${a.name} → output is a single bounded line drawn from the fixed table`,
    [...FIXED_MESSAGES].some((m) => combined.includes(m)),
    `output was ${JSON.stringify(combined.slice(0, 200))}`,
  );
}

console.log('\nAdversarial CLI arguments:');
{
  // A caller-supplied path is not response data, but it is still not ours to
  // print: the old read-failure diagnostic echoed both the path and the OS
  // error text.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alias-binding-evil-'));
  const evilPath = path.join(dir, `${CMD_ERROR}-missing.json`);
  const r = spawnSync(process.execPath, [HELPER, evilPath, MALICIOUS_HOST, MALICIOUS_ID], {
    encoding: 'utf8',
  });
  fs.rmSync(dir, { recursive: true, force: true });
  check(
    'a malicious unreadable path is fatal',
    r.status === ALIAS_BINDING_FATAL,
    `got exit ${r.status}`,
  );
  const combined = (r.stdout ?? '') + (r.stderr ?? '');
  check(
    'the malicious path, host and expected id are never echoed',
    attackerBytesIn(combined).length === 0 && !combined.includes('missing.json'),
    `output was ${JSON.stringify(combined.slice(0, 200))}`,
  );
  check(
    'the read failure reports the fixed unreadable-response message',
    combined.includes(ALIAS_BINDING_MESSAGES.UNREADABLE_RESPONSE),
    `output was ${JSON.stringify(combined.slice(0, 200))}`,
  );
}

console.log('\nThe fixed message table and its final guard:');
for (const [key, message] of Object.entries(ALIAS_BINDING_MESSAGES)) {
  check(
    `message ${key} is a bounded, control-character-free constant`,
    attackerBytesIn(message).length === 0
      && message.length <= ALIAS_BINDING_MAX_DIAGNOSTIC
      && !message.includes('::'),
    `message was ${JSON.stringify(message)}`,
  );
}
check(
  'the message table is frozen',
  Object.isFrozen(ALIAS_BINDING_MESSAGES),
);
{
  const hostile = `${ANSI_CLEAR}${CMD_ERROR}${CRLF}${BEL}${NUL}` + 'x'.repeat(5000);
  const cleaned = sanitizeDiagnostic(hostile);
  check(
    'sanitizeDiagnostic strips control characters',
    !CONTROL_CHARS.test(cleaned) && !cleaned.includes('\n'),
  );
  check(
    'sanitizeDiagnostic bounds the length',
    cleaned.length <= ALIAS_BINDING_MAX_DIAGNOSTIC,
    `got ${cleaned.length}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// THE FINAL GUARD: bare workflow command markers
// ─────────────────────────────────────────────────────────────────────────
// Stripping control bytes and bounding the length is not enough on its own.
// A runner reads a line beginning `::name::value` as a COMMAND rather than as
// text, so `::add-mask::x` or `::set-output::x` is an injection even though
// every byte in it is printable and the line is short. The production call
// sites all pass fixed table entries today, so nothing reachable leaks — but
// this function is advertised as the final pass that holds even if a future
// edit reintroduces interpolation, and a final pass that lets `::` through is
// not one.
//
// The contract asserted below holds for ARBITRARY input, not just fixtures:
//   * no `::` survives anywhere in the output;
//   * no control byte and no newline survives;
//   * the result is a single line bounded by ALIAS_BINDING_MAX_DIAGNOSTIC.

/** Everything sanitizeDiagnostic must guarantee about its own return value. */
function sanitizerViolations(out) {
  const bad = [];
  if (typeof out !== 'string') return ['not-a-string'];
  if (out.includes('::')) bad.push('workflow-command-marker');
  if (CONTROL_CHARS.test(out)) bad.push('control-characters');
  if (out.includes('\n') || out.includes('\r')) bad.push('newline');
  if (out.length > ALIAS_BINDING_MAX_DIAGNOSTIC) bad.push(`unbounded:${out.length}`);
  return bad;
}

/** C1 controls, built without literal escapes so the bytes are unambiguous. */
const C1_NEL = String.fromCharCode(0x85);
const C1_APC = String.fromCharCode(0x9f);
const DEL = String.fromCharCode(0x7f);

const MARKER_FIXTURES = [
  // ── bare markers: start, middle, end ──────────────────────────────────
  { name: 'bare ::error:: marker alone at the start', raw: CMD_ERROR },
  { name: 'bare ::warning:: marker alone at the start', raw: CMD_WARN },
  { name: 'marker in the middle of ordinary prose', raw: `alias check failed ${CMD_ERROR} and continued` },
  { name: 'marker at the very end of the line', raw: `alias check failed ${CMD_WARN}` },
  { name: 'a trailing bare :: with nothing after it', raw: 'alias check failed::' },
  { name: 'a leading bare :: with nothing before it', raw: '::alias check failed' },

  // ── repeated / overlapping colon runs ─────────────────────────────────
  { name: 'odd-length colon run (:::)', raw: 'a:::b' },
  { name: 'even-length colon run (::::)', raw: 'a::::b' },
  { name: 'long colon run (eight colons)', raw: `a${':'.repeat(8)}b` },
  { name: 'two markers run together with no separator', raw: `${CMD_ERROR}${CMD_WARN}` },
  { name: 'overlapping marker heads (::error::::warning::)', raw: '::error::::warning::INJECTED' },
  { name: 'a colon run longer than the output bound', raw: ':'.repeat(5000) },
  { name: 'markers repeated past the output bound', raw: CMD_ERROR.repeat(500) },

  // ── mixed case command names ──────────────────────────────────────────
  { name: 'mixed case ::ERROR::', raw: '::ERROR::INJECTED' },
  { name: 'mixed case ::Warning::', raw: '::Warning::INJECTED' },
  { name: 'mixed case ::sEt-OuTpUt::', raw: '::sEt-OuTpUt::name=INJECTED' },
  { name: 'the ::add-mask:: command', raw: '::add-mask::sk_live_SHOULD_NEVER_BE_LOGGED' },
  { name: 'the ::stop-commands:: token form', raw: '::stop-commands::INJECTED' },

  // ── CR/LF combined with markers ───────────────────────────────────────
  { name: 'CRLF followed by a marker', raw: `first line${CRLF}${CMD_ERROR}` },
  { name: 'marker sandwiched between CRLF pairs', raw: `${CRLF}${CMD_WARN}${CRLF}tail` },
  { name: 'bare LF followed by a marker', raw: `first line\n${CMD_ERROR}` },
  { name: 'bare CR followed by a marker', raw: `first line\r${CMD_WARN}` },

  // ── ESC combined with markers ─────────────────────────────────────────
  { name: 'ANSI clear followed by a marker', raw: `${ANSI_CLEAR}${CMD_ERROR}` },
  { name: 'ANSI colour wrapped around a marker', raw: `${ANSI_RED}${CMD_WARN}${ANSI_CLEAR}` },
  { name: 'a bare ESC byte glued to a marker', raw: `${ESC}${CMD_ERROR}` },
  { name: 'ESC between the two colons of a marker head', raw: `:${ESC}:error::INJECTED` },

  // ── adjacency created ONLY by control stripping ───────────────────────
  // These are the cases a "tidy up the regex" refactor breaks: if controls
  // were deleted rather than spaced, or spaced after the colon pass, each of
  // these would emerge as a live `::`.
  { name: 'colons made adjacent only after a NUL is removed', raw: `:${NUL}:` },
  { name: 'colons made adjacent only after an ESC is removed', raw: `:${ESC}:` },
  { name: 'colons made adjacent only after a CRLF is removed', raw: `:${CRLF}:` },
  { name: 'colons made adjacent only after a BEL is removed', raw: `:${BEL}:` },
  { name: 'colons made adjacent only after a DEL is removed', raw: `:${DEL}:` },
  { name: 'colons separated by C1 control bytes', raw: `:${C1_NEL}:${C1_APC}:` },
  { name: 'a whole marker split by control bytes that removal would rejoin', raw: `:${NUL}:error:${BEL}:INJECTED` },

  // ── everything at once ────────────────────────────────────────────────
  { name: 'markers plus every control byte plus overlength padding', raw: `${ANSI_CLEAR}${CMD_ERROR}${CRLF}${BEL}${NUL}${'x'.repeat(5000)}` },

  // ── non-string and degenerate inputs ──────────────────────────────────
  { name: 'a non-string input carrying a marker', raw: { toString: () => CMD_ERROR } },
  { name: 'the empty string', raw: '' },
];

console.log('\nThe final guard neutralizes bare workflow command markers:');
for (const f of MARKER_FIXTURES) {
  const out = sanitizeDiagnostic(f.raw);
  const bad = sanitizerViolations(out);
  check(
    `sanitizeDiagnostic — ${f.name}`,
    bad.length === 0,
    `violations: ${bad.join(', ')} in ${JSON.stringify(String(out).slice(0, 120))}`,
  );
}

// Transformations must not create work for a second pass: if sanitizing twice
// differs from sanitizing once, some rewrite is producing a new marker or a
// new control byte out of its own output.
console.log('\nThe final guard is idempotent (it never creates what it removes):');
for (const f of MARKER_FIXTURES) {
  const once = sanitizeDiagnostic(f.raw);
  check(
    `sanitizeDiagnostic is a fixed point — ${f.name}`,
    sanitizeDiagnostic(once) === once,
    `second pass changed the result for ${JSON.stringify(String(once).slice(0, 120))}`,
  );
}

// Neutralizing must not cost legibility: the strings production actually
// prints have to survive byte-for-byte. A guard that stripped every colon
// would silently mangle the usage line, which reads `usage: verify-...`.
console.log('\nThe final guard leaves real production diagnostics untouched:');
for (const [key, message] of Object.entries(ALIAS_BINDING_MESSAGES)) {
  check(
    `sanitizeDiagnostic passes ${key} through byte-for-byte`,
    sanitizeDiagnostic(message) === message,
    `became ${JSON.stringify(sanitizeDiagnostic(message))}`,
  );
}
check(
  'a single colon is still a single colon (the usage line stays readable)',
  sanitizeDiagnostic('usage: verify-alias-binding.mjs <path>')
    === 'usage: verify-alias-binding.mjs <path>',
);

// Finally, close the loop from the unit level to the real log line: the only
// `::` a reader should ever see is the ONE `::error::` prefix main() adds
// itself. `::error::` contributes exactly two `::` occurrences; a fatal line
// must show those two and no more, and a success/retry line none at all.
console.log('\nOnly the helper-authored ::error:: prefix reaches the log:');
for (const a of ATTACKS) {
  const r = runHelper(a.raw, a.expectedId ?? THIS_RUN, a.host ?? HOST);
  const combined = r.stdout + r.stderr;
  const markerCount = (combined.match(/::/g) ?? []).length;
  const expected = CODE_FOR[a.expect] === ALIAS_BINDING_FATAL ? 2 : 0;
  check(
    `${a.name} → exactly ${expected} '::' occurrence(s) in the log`,
    markerCount === expected,
    `got ${markerCount} in ${JSON.stringify(combined.slice(0, 200))}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────
// MUTATION / REGRESSION PROOF
// ─────────────────────────────────────────────────────────────────────────
// `priorInlineValidator` is the exact decision the workflow's inline
// `node -e` validator made before this remediation, transcribed from commit
// 7e8e9d295. It is NOT an alternative implementation under test — it is the
// bug, kept so the suite can demonstrate two things:
//
//   1. the old logic really did accept a record with no top-level
//      `deploymentId`, and
//   2. the fixtures above really do discriminate, i.e. this suite would have
//      failed against the old validator instead of passing 89/89 beside it.
//
// If someone reintroduces the collect-whichever-ids-are-present shape, the
// first assertion below still passes and the production assertions fail.
function priorInlineValidator(raw, expectedId) {
  let a;
  try {
    a = JSON.parse(raw);
  } catch {
    return 1;
  }
  if (a && a.error) return 1;
  const ids = [a.deploymentId, a.deployment && a.deployment.id]
    .filter((v) => typeof v === 'string' && v.length > 0);
  if (ids.length === 0) return 2;
  if (ids.some((v) => v !== ids[0])) return 1;
  if (ids[0] !== expectedId) return 2;
  return 0;
}

console.log('\nMutation proof — the prior inline validator fails these fixtures:');
const MISSING_TOP_LEVEL = JSON.stringify({ alias: HOST, deployment: { id: THIS_RUN } });

check(
  'the PRIOR validator accepted a missing top-level deploymentId (the High finding, reproduced)',
  priorInlineValidator(MISSING_TOP_LEVEL, THIS_RUN) === ALIAS_BINDING_SUCCESS,
  'if this stops reproducing, the transcription of the old bug has drifted',
);
check(
  'the PRODUCTION validator rejects that same record as fatal',
  decide(MISSING_TOP_LEVEL).code === ALIAS_BINDING_FATAL,
  `got ${JSON.stringify(decide(MISSING_TOP_LEVEL))}`,
);
check(
  'the production helper rejects it through its exit code too',
  runHelper(MISSING_TOP_LEVEL).code === ALIAS_BINDING_FATAL,
);

// The suite as a whole must discriminate: run every fixture through the old
// validator and require that at least one disagrees with production. A suite
// that both implementations satisfy is exactly the failure mode being fixed.
const divergent = FIXTURES.filter(
  (f) => priorInlineValidator(f.raw, THIS_RUN) !== CODE_FOR[f.expect],
);
check(
  'the fixture set discriminates between the prior and current validators',
  divergent.length > 0,
  'no fixture distinguishes them, so these tests could not have caught the regression',
);
console.log(
  `    (${divergent.length} fixture(s) the prior validator got wrong: `
    + `${divergent.map((f) => f.name).join('; ')})`,
);

// A second mutation: the "empty top-level string" shape. The old filter
// dropped empty strings silently and fell through to "no deployment id yet",
// which retried until timeout instead of reporting a malformed contract.
check(
  'the PRIOR validator treated an empty top-level id as retryable, not fatal',
  priorInlineValidator(JSON.stringify({ alias: HOST, deploymentId: '' }), THIS_RUN)
    === ALIAS_BINDING_RETRY,
);
check(
  'the PRODUCTION validator treats an empty top-level id as fatal',
  decide(JSON.stringify({ alias: HOST, deploymentId: '' })).code === ALIAS_BINDING_FATAL,
);

// ─────────────────────────────────────────────────────────────────────────
// MUTATION PROOF, SECOND DIMENSION: the diagnostics
// ─────────────────────────────────────────────────────────────────────────
// `priorInterpolatingDiagnostic` is the message construction this module used
// before this remediation, transcribed from commit 346d1863. Like
// `priorInlineValidator` it is the BUG, not an alternative implementation: it
// is here so the adversarial fixtures above can be shown to bite. A fixture set
// that the old, leaking diagnostics also satisfied would prove nothing.
function priorInterpolatingDiagnostic(raw, host, expectedId) {
  let record;
  try {
    record = JSON.parse(raw);
  } catch (err) {
    return `Alias record for ${host} was not valid JSON: ${err.message}`;
  }
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return `Alias record for ${host} was not an object.`;
  }
  if (record.error !== undefined && record.error !== null) {
    const code = record.error?.code;
    return `Alias API returned an error for ${host}`
      + `${typeof code === 'string' && code.length > 0 ? ` (code=${code})` : ''}.`;
  }
  const topLevel = record.deploymentId;
  if (typeof topLevel !== 'string' || topLevel.length === 0) {
    return `Alias record for ${host} has no usable top-level deploymentId.`;
  }
  const nested = record.deployment && record.deployment.id;
  if (nested !== undefined && nested !== topLevel) {
    return `Alias record for ${host} contradicts itself: deploymentId=${topLevel} `
      + `but deployment.id=${JSON.stringify(nested)}.`;
  }
  if (topLevel !== expectedId) {
    return `${host} is bound to ${topLevel}, not this run deployment ${expectedId}.`;
  }
  return `${host} is bound to exactly this run deployment ${expectedId}.`;
}

console.log('\nMutation proof — the prior diagnostics leaked what these fixtures carry:');
const priorLeaking = ATTACKS.filter(
  (a) =>
    attackerBytesIn(
      priorInterpolatingDiagnostic(a.raw, a.host ?? HOST, a.expectedId ?? THIS_RUN),
    ).length > 0,
);
const currentLeaking = ATTACKS.filter(
  (a) =>
    attackerBytesIn(
      evaluateAliasBinding({
        raw: a.raw,
        host: a.host ?? HOST,
        expectedDeploymentId: a.expectedId ?? THIS_RUN,
      }).message,
    ).length > 0,
);

check(
  'the PRIOR diagnostics leaked attacker bytes for most of these fixtures (the High finding, reproduced)',
  priorLeaking.length >= 8,
  `only ${priorLeaking.length} of ${ATTACKS.length} fixtures leaked, so the transcription of the old diagnostics has drifted`,
);
check(
  'the PRODUCTION diagnostics leak for NONE of them',
  currentLeaking.length === 0,
  `leaking fixtures: ${currentLeaking.map((a) => a.name).join('; ')}`,
);
console.log(
  `    (${priorLeaking.length} of ${ATTACKS.length} fixtures escaped the prior diagnostics)`,
);

// V8 quotes only the first ~10 characters of the offending input back inside
// `err.message` ("Unexpected token ':', \"::error::I\"... is not valid JSON").
// Ten characters is already enough to plant a forged `::error::` workflow
// command in the log, which is exactly why the fragment must not be echoed at
// all — a bound on how much leaks is not a defence.
check(
  'the PRIOR diagnostics reproduced an attacker fragment straight out of a JSON parse error',
  priorInterpolatingDiagnostic(PARSE_FRAGMENT, HOST, THIS_RUN).includes('::error::'),
  'V8 quotes the offending input back inside err.message; if it stopped, this proof is stale',
);
check(
  'the PRODUCTION helper reports that same body as a fixed message through its exit code and log',
  runHelper(PARSE_FRAGMENT).code === ALIAS_BINDING_FATAL
    && attackerBytesIn(runHelper(PARSE_FRAGMENT).stdout + runHelper(PARSE_FRAGMENT).stderr)
      .length === 0,
);
check(
  'the PRIOR diagnostics echoed the caller-supplied host',
  priorInterpolatingDiagnostic(
    JSON.stringify({ alias: HOST, deploymentId: THIS_RUN }),
    MALICIOUS_HOST,
    THIS_RUN,
  ).includes('INJECTED'),
);

// ─────────────────────────────────────────────────────────────────────────
// Guard the contract itself: the module must expose the three codes.
// ─────────────────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────────────────
// MUTATION PROOF, THIRD DIMENSION: the final guard
// ─────────────────────────────────────────────────────────────────────────
// `priorSanitizeDiagnostic` is the guard exactly as it stood at commit
// e593fcf8: it removed control bytes and bounded the length but left `::`
// alone, so `sanitizeDiagnostic('::error::INJECTED')` returned its argument
// verbatim. Like the two mutations above it is the BUG, kept so the marker
// fixtures can be shown to bite rather than merely to pass.
//
// The other two functions are not history — they are the plausible WRONG
// fixes. They are here so the fixtures defend the two ordering decisions the
// real implementation makes, not just the presence of some colon pass.
function priorSanitizeDiagnostic(text) {
  return String(text)
    .replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g'), ' ')
    .slice(0, ALIAS_BINDING_MAX_DIAGNOSTIC);
}

/** WRONG FIX 1: rewrite each `::` pair on its own — `:::` becomes `: ::`. */
function pairwiseSanitizer(text) {
  return String(text)
    .replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g'), ' ')
    .replace(/::/g, ': :')
    .slice(0, ALIAS_BINDING_MAX_DIAGNOSTIC);
}

/** WRONG FIX 2: split runs first, then DELETE controls — `:NUL:` becomes `::`. */
function splitBeforeStripSanitizer(text) {
  return String(text)
    .replace(/:{2,}/g, (run) => run.split('').join(' '))
    .replace(new RegExp('[\\u0000-\\u001f\\u007f-\\u009f]', 'g'), '')
    .slice(0, ALIAS_BINDING_MAX_DIAGNOSTIC);
}

console.log('\nMutation proof — the prior final guard fails the marker fixtures:');

// The two cases named verbatim in the review finding.
check(
  'the PRIOR guard returned ::error::INJECTED unchanged (the Medium finding, reproduced)',
  priorSanitizeDiagnostic(CMD_ERROR) === CMD_ERROR,
  'if this stops reproducing, the transcription of the old guard has drifted',
);
check(
  'the PRIOR guard returned ::warning::INJECTED unchanged (the Medium finding, reproduced)',
  priorSanitizeDiagnostic(CMD_WARN) === CMD_WARN,
);
check(
  'the CURRENT guard neutralizes both of those exact inputs',
  !sanitizeDiagnostic(CMD_ERROR).includes('::')
    && !sanitizeDiagnostic(CMD_WARN).includes('::'),
  `got ${JSON.stringify(sanitizeDiagnostic(CMD_ERROR))} and `
    + `${JSON.stringify(sanitizeDiagnostic(CMD_WARN))}`,
);

const priorGuardFailures = MARKER_FIXTURES.filter(
  (f) => sanitizerViolations(priorSanitizeDiagnostic(f.raw)).length > 0,
);
const currentGuardFailures = MARKER_FIXTURES.filter(
  (f) => sanitizerViolations(sanitizeDiagnostic(f.raw)).length > 0,
);
check(
  'the PRIOR guard is defeated by a large majority of the marker fixtures',
  priorGuardFailures.length >= 15,
  `only ${priorGuardFailures.length} of ${MARKER_FIXTURES.length} fixtures defeated it, `
    + 'so the fixtures are not discriminating',
);
check(
  'the CURRENT guard is defeated by NONE of them',
  currentGuardFailures.length === 0,
  `failing fixtures: ${currentGuardFailures.map((f) => f.name).join('; ')}`,
);
console.log(
  `    (${priorGuardFailures.length} of ${MARKER_FIXTURES.length} fixtures defeated the prior guard)`,
);

// Each wrong fix must be caught by at least one fixture, and the catching
// fixture is printed so a later reader sees which decision it protects.
const pairwiseFailures = MARKER_FIXTURES.filter(
  (f) => sanitizerViolations(pairwiseSanitizer(f.raw)).length > 0,
);
check(
  'MUTATION: pairwise `::` replacement is caught (odd-length colon runs defeat it)',
  pairwiseFailures.length > 0,
  'no fixture carries an odd-length colon run, so `:::` -> `: ::` would ship unnoticed',
);
console.log(
  `    (pairwise replacement defeated by: ${pairwiseFailures.map((f) => f.name).join('; ')})`,
);

const reorderedFailures = MARKER_FIXTURES.filter(
  (f) => sanitizerViolations(splitBeforeStripSanitizer(f.raw)).length > 0,
);
check(
  'MUTATION: splitting colons before DELETING controls is caught (removal re-forms `::`)',
  reorderedFailures.length > 0,
  'no fixture separates two colons with a control byte, so the ordering is unprotected',
);
console.log(
  `    (strip-after-split defeated by: ${reorderedFailures.map((f) => f.name).join('; ')})`,
);

// ─────────────────────────────────────────────────────────────────────────
// Guard the contract itself: the module must expose the three codes.
// ─────────────────────────────────────────────────────────────────────────
assert.equal(typeof evaluateAliasBinding, 'function');

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1430 alias binding validator behaviour: ${passed} checks passed`);
} else {
  console.error('\n❌ DIC-1430 alias binding validator behaviour FAILED');
}
