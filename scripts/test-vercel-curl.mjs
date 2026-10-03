#!/usr/bin/env node
/**
 * PR #216 security CR d90a82ad — EXECUTES scripts/ci/vercel-curl.sh.
 *
 * The exact-SHA deploy workflow used `curl --oauth2-bearer "${VERCEL_TOKEN}"`,
 * which put the Vercel credential in curl's process argv. Every Vercel API
 * call now goes through the wrapper, and this suite proves by running it:
 *
 *   1. the token never appears in curl's argv, nor in curl's environment;
 *      the Authorization header arrives on curl's stdin as a config line;
 *   2. the header is built by bash's BUILTIN printf (a PATH-shadowing
 *      `printf` executable is never exec'd, so no exec carries the token);
 *   3. curl's stdout (`-w '%{http_code}'`) and exit status pass through;
 *   4. absent / empty / malformed tokens fail closed BEFORE curl runs, with
 *      a fixed message that never echoes the token;
 *   5. even under `bash -x`, the token is not traced to stderr;
 *   6. with the REAL curl against a local HTTP server, the server receives
 *      `Authorization: Bearer <token>` while no process on the machine has
 *      the token in its argv (sampled with `ps` mid-request).
 *
 * Check 1 (argv recorded AT EXEC by a fake curl) is the authoritative proof.
 * The `ps` sample in 6 is supplementary only: real curl blanks
 * `--oauth2-bearer` in its own argv shortly after it starts, so a mid-request
 * sample cannot see the exposure window the CR flagged — the old
 * `--oauth2-bearer "${VERCEL_TOKEN}"` shape passes 6 but fails 1.
 *
 * The sentinel token is synthetic; no real credential is read or printed.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRAPPER = path.join(ROOT, 'scripts', 'ci', 'vercel-curl.sh');
const SENTINEL = 'vcltestSENTINEL0123456789abcdef';

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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'vercel-curl-'));
const fakeBin = path.join(tmp, 'bin');
fs.mkdirSync(fakeBin);
const log = (name) => path.join(tmp, name);

// Fake curl: records argv (one per line), stdin, and environment, then
// prints a status and exits with FAKE_CURL_EXIT (default 0).
fs.writeFileSync(path.join(fakeBin, 'curl'), `#!/bin/sh
printf '%s\\n' "$@" > "${log('curl.argv')}"
cat > "${log('curl.stdin')}"
env > "${log('curl.env')}"
printf '201'
exit "\${FAKE_CURL_EXIT:-0}"
`, { mode: 0o755 });
// Fake printf: if the wrapper ever EXECs printf (rather than using the bash
// builtin), the token would be in that exec's argv. Record any invocation.
fs.writeFileSync(path.join(fakeBin, 'printf'), `#!/bin/sh
echo invoked > "${log('printf.invoked')}"
`, { mode: 0o755 });

const read = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null);
function reset() {
  for (const f of ['curl.argv', 'curl.stdin', 'curl.env', 'printf.invoked']) {
    fs.rmSync(log(f), { force: true });
  }
}
function runWrapper(env, args = [], bashFlags = []) {
  reset();
  const baseEnv = { PATH: `${fakeBin}:${process.env.PATH}`, HOME: tmp };
  return spawnSync('bash', [...bashFlags, WRAPPER, ...args], {
    env: { ...baseEnv, ...env },
    encoding: 'utf8',
  });
}

// ── 1–3: happy path with a recording fake curl ─────────────────────────
{
  const args = ['-sS', '-o', '/tmp/x.json', '-w', '%{http_code}', '-X', 'POST',
    '--data-raw', '{"a":1}', 'https://api.vercel.com/v13/deployments?teamId=t'];
  const r = runWrapper({ VERCEL_TOKEN: SENTINEL }, args);
  const argv = read(log('curl.argv'));
  const stdin = read(log('curl.stdin'));
  const env = read(log('curl.env'));
  check('wrapper exits 0 when curl succeeds', r.status === 0, `status=${r.status}`);
  check('curl stdout (the -w status) passes through unchanged', r.stdout === '201', `got ${JSON.stringify(r.stdout)}`);
  check('curl was invoked', argv !== null);
  check('curl argv NEVER contains the token', argv !== null && !argv.includes(SENTINEL));
  check('curl argv carries no --oauth2-bearer / -H Authorization',
    argv !== null && !/oauth2-bearer|Authorization|Bearer/i.test(argv));
  check('curl reads its config from stdin (`--config -` first)',
    argv !== null && argv.split('\n').slice(0, 2).join(' ') === '--config -');
  check('every caller argument reaches curl verbatim and in order',
    argv !== null && argv.split('\n').slice(2, 2 + args.length).join('\u0000') === args.join('\u0000'));
  check('the Authorization header arrives on stdin as exactly one config line',
    stdin === `header = "Authorization: Bearer ${SENTINEL}"\n`);
  check('curl environment does NOT contain VERCEL_TOKEN or the token value',
    env !== null && !/VERCEL_TOKEN/.test(env) && !env.includes(SENTINEL));
  check('the header is built by the bash BUILTIN printf (no printf exec)',
    read(log('printf.invoked')) === null);
  check('nothing the wrapper prints contains the token',
    !r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
}
{
  const r = runWrapper({ VERCEL_TOKEN: SENTINEL, FAKE_CURL_EXIT: '7' }, ['https://api.vercel.com/']);
  check('curl\'s own non-zero exit status propagates (fail closed on transport error)',
    r.status === 7, `status=${r.status}`);
}

// ── 4: fail closed on absent / malformed tokens, before curl ───────────
const BAD = [
  ['unset', undefined],
  ['empty', ''],
  ['double quote (config breakout)', `${SENTINEL}"x`],
  ['backslash (config escape)', `${SENTINEL}\\x`],
  ['space', `${SENTINEL} x`],
  ['newline (second config directive)', `${SENTINEL}\nurl = "https://evil.example/"`],
  ['tab', `${SENTINEL}\tx`],
  ['non-ASCII', `${SENTINEL}é`],
];
for (const [name, value] of BAD) {
  const env = value === undefined ? {} : { VERCEL_TOKEN: value };
  const r = runWrapper(env, ['https://api.vercel.com/']);
  check(`${name} token → exit 1`, r.status === 1, `status=${r.status}`);
  check(`${name} token → curl never runs`, read(log('curl.argv')) === null);
  check(`${name} token → fixed ::error:: message`,
    /^::error::VERCEL_TOKEN (is missing or empty|has an unexpected shape); refusing to call the Vercel API\.\n$/.test(r.stderr),
    `stderr=${JSON.stringify(r.stderr.slice(0, 120))}`);
  check(`${name} token → token never echoed`,
    !r.stdout.includes(SENTINEL) && !r.stderr.includes(SENTINEL));
}

// ── 5: xtrace does not leak it ─────────────────────────────────────────
{
  const r = runWrapper({ VERCEL_TOKEN: SENTINEL }, ['https://api.vercel.com/'], ['-x']);
  check('under `bash -x` the call still succeeds', r.status === 0, `status=${r.status}`);
  check('under `bash -x` the token is never traced to stderr', !r.stderr.includes(SENTINEL));
}

// ── Static: the wrapper disables xtrace first and never uses argv auth ──
{
  const src = fs.readFileSync(WRAPPER, 'utf8');
  const code = src.split('\n').filter((l) => !l.trim().startsWith('#')).join('\n');
  check('wrapper turns xtrace off before touching the token',
    code.indexOf('set +x') > -1 && code.indexOf('set +x') < code.indexOf('VERCEL_TOKEN'));
  check('wrapper never passes the token as a curl flag',
    !/oauth2-bearer|\s-H\s|--header|\s-u\s|--user/.test(code));
  check('wrapper feeds curl via `--config -`', /\|\s*curl --config - "\$@"/.test(code));
}

// ── 6: real curl, real HTTP, argv sampled mid-request ──────────────────
const curlPath = spawnSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).stdout.trim();
check('a real curl is available for the end-to-end check', curlPath.length > 0);
if (curlPath) {
  let seenAuth = null;
  let psSample = null;
  const server = http.createServer((req, res) => {
    seenAuth = req.headers.authorization ?? null;
    // The request is in flight here: curl (and the wrapper's bash) are alive.
    try {
      psSample = execFileSync('ps', ['-Ao', 'args'], { encoding: 'utf8' });
    } catch {
      psSample = null;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end('{"ok":true}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const out = path.join(tmp, 'real.json');
  const child = spawn('bash', [WRAPPER, '-sS', '-o', out, '-w', '%{http_code}',
    `http://127.0.0.1:${port}/v9/projects/x?teamId=t`], {
    env: { PATH: process.env.PATH, HOME: tmp, VERCEL_TOKEN: SENTINEL },
  });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (d) => { stdout += d; });
  child.stderr.on('data', (d) => { stderr += d; });
  const status = await new Promise((resolve) => child.on('close', resolve));
  server.close();
  check('real curl: request succeeds with HTTP 200 reported via -w', status === 0 && stdout === '200',
    `status=${status} stdout=${JSON.stringify(stdout)}`);
  check('real curl: server received exactly `Authorization: Bearer <token>`',
    seenAuth === `Bearer ${SENTINEL}`);
  check('real curl: a process-table sample was taken mid-request', typeof psSample === 'string' && /curl/.test(psSample));
  check('real curl: NO process argv on the machine contained the token mid-request',
    typeof psSample === 'string' && !psSample.includes(SENTINEL));
  check('real curl: the token was never printed', !stdout.includes(SENTINEL) && !stderr.includes(SENTINEL));
}

fs.rmSync(tmp, { recursive: true, force: true });

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ vercel-curl token-argv contract: ${passed} checks passed`);
} else {
  console.error('\n❌ vercel-curl token-argv contract FAILED');
}
