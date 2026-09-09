#!/usr/bin/env node
// DIC-1380 W7 CR — tournament collector discovery must ACQUIRE, not just log.
//
// Mac-Codex reproduced the previous behaviour:
//   $ npm run collect:tournaments -- --live --dry-run
//   ⚠️  A newer official deck-showcase column was published (2026-09-04T18:00:00);
//       it has not been parsed yet — last-known-good is preserved.
//   ... retained July/August data ... exit 0
//
// That is a silent "release train continues to ship stale data" path.
// The W7 fix has two moving parts, both regression-pinned here:
//
//   1. `ensureDiscoveryStub` writes a discovery-stub source file into
//      SOURCES_DIR when a newer publication than everything committed is
//      found. Idempotent — a second call sees the stub and does nothing.
//      --dry-run skips the write but still reports the target path.
//
//   2. The collector process EXITS NON-ZERO when discovery finds a newer
//      column than anything committed. The scheduled workflow can then
//      surface the miss instead of silently exiting 0.
//
// Together these turn "discovered but ignored" into "discovered, stubbed
// into SOURCES_DIR, workflow fails so someone fills it in" — the
// sustainable acquisition path the CR asked for.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const collectorPath = path.join(__dirname, 'collect-tournament-reports.mjs');
const repoRoot = path.join(__dirname, '..');

let passed = 0;
function ok(label, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    process.exitCode = 1;
  }
}

function makeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1380-w7-tourn-'));
  const sources = path.join(dir, 'sources');
  const outDir = path.join(dir, 'out');
  fs.mkdirSync(sources, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  // Committed July source with a real publishedDate so classifyFreshness
  // sees it as "known".
  fs.writeFileSync(
    path.join(sources, '2026-07.json'),
    JSON.stringify({
      month: '2026-07',
      publishedDate: '2026-07-15T18:00:00',
      liveDecklog: false,
      events: [],
    }, null, 2),
  );
  return { dir, sources, outDir };
}

async function importCollector() {
  // Fresh import per test so process-level `args` / DRY_RUN / SOURCES_DIR
  // reflect the argv we set.
  const mod = await import(pathToFileURL(collectorPath).href + `?t=${Date.now()}`);
  return mod;
}

// ── ensureDiscoveryStub unit tests ──────────────────────────────────────
{
  const { sources } = makeFixture();
  process.argv = [process.argv[0], collectorPath, '--live', '--sources-dir', sources];
  const mod = await importCollector();

  // Fresh module already sees --live; ensureDiscoveryStub is safe to call
  // synchronously — no network.
  const first = mod.ensureDiscoveryStub({
    publishedDate: '2026-09-04T18:00:00',
    knownNewest: '2026-07-15T18:00:00',
    officialLink: 'https://hololive-official-cardgame.com/news/9999/',
    officialTitle: '2026-09 champion decks',
  });
  ok(
    'ensureDiscoveryStub writes a stub for a newly discovered publication',
    first.wrote === true && fs.existsSync(first.absolutePath),
    `wrote=${first.wrote} absPath=${first.absolutePath}`,
  );
  const stub = JSON.parse(fs.readFileSync(first.absolutePath, 'utf8'));
  ok('stub file lands under SOURCES_DIR with the discovered date in its name', /discovered-2026-09-04\.json$/.test(first.absolutePath));
  ok('stub carries publishedDate + month + officialSource', stub.publishedDate === '2026-09-04T18:00:00' && stub.month === '2026-09' && stub?.officialSource?.link === 'https://hololive-official-cardgame.com/news/9999/');
  ok('stub carries an empty events[] so a re-run needs human curation before anything ships', Array.isArray(stub.events) && stub.events.length === 0);
  ok('stub is idempotent — a second call with the same publishedDate does NOT overwrite', (() => {
    const before = fs.readFileSync(first.absolutePath, 'utf8');
    const second = mod.ensureDiscoveryStub({
      publishedDate: '2026-09-04T18:00:00',
      knownNewest: '2026-07-15T18:00:00',
      officialLink: null,
      officialTitle: null,
    });
    const after = fs.readFileSync(first.absolutePath, 'utf8');
    return second.wrote === false && before === after;
  })());
}

// --dry-run must NOT write the stub, but still report the target path so
// the caller (the collector's discoverFreshness) can raise the alert.
{
  const { sources } = makeFixture();
  process.argv = [process.argv[0], collectorPath, '--live', '--dry-run', '--sources-dir', sources];
  const mod = await importCollector();
  const res = mod.ensureDiscoveryStub({
    publishedDate: '2026-09-04T18:00:00',
    knownNewest: '2026-07-15T18:00:00',
    officialLink: null,
    officialTitle: null,
  });
  ok('--dry-run: ensureDiscoveryStub does NOT write to disk', res.wrote === false && !fs.existsSync(res.absolutePath));
  ok('--dry-run: ensureDiscoveryStub still reports the target path so the caller can raise the alert', /discovered-2026-09-04\.json$/.test(res.relativePath));
}

// A discovery with no valid publishedDate cannot form a slug; the writer
// returns { wrote: false } instead of throwing / creating a garbage file.
{
  const { sources } = makeFixture();
  process.argv = [process.argv[0], collectorPath, '--live', '--sources-dir', sources];
  const mod = await importCollector();
  const res = mod.ensureDiscoveryStub({ publishedDate: '', knownNewest: null, officialLink: null, officialTitle: null });
  ok('ensureDiscoveryStub refuses to write when publishedDate cannot form a slug', res.wrote === false && res.absolutePath === null);
}

// ── Integration: collector process exits non-zero when discovery finds a
//    newer column than anything committed. We stub the WP fetch by
//    intercepting `fetchWithRetry` through a wrapper script that pre-loads
//    the module and monkey-patches the export before invoking main.
// Skipping the real network path — SKIP_DISCOVERY + a synthetic fixture
// exercise the same alert-error → exit(1) plumbing.
{
  const { sources, outDir } = makeFixture();
  // Add ANOTHER source that would be considered "invalid" — an empty
  // month/events pair — so we can prove the exit-nonzero came from the
  // discovery alert, not from some incidental error. Actually simpler:
  // just prove exit code plumbing by writing a source with a bad shape
  // — the collector already alerts('error') on that AND exits 1, but
  // we want the DISCOVERY branch specifically. Skip this
  // path here; the WordPress-response mock lives inside a Node child.

  // Compact child: import the collector's `discoverFreshness` indirectly
  // via a wrapper that stubs global.fetch to return a synthetic post
  // newer than the fixture's known publishedDate. If discovery raises
  // an error alert, the process exits 1.
  const wrapperPath = path.join(sources, '..', 'run-wrapper.mjs');
  fs.writeFileSync(wrapperPath, `
    globalThis.fetch = async (url, init) => {
      const u = String(url);
      if (u.includes('/wp-json/wp/v2/post_news')) {
        return new Response(JSON.stringify([
          { date: '2026-09-04T18:00:00', link: 'https://hololive-official-cardgame.com/news/9999/', title: { rendered: 'newer than committed' } },
        ]), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (u.includes('/api/fxtwitter')) return new Response(JSON.stringify({ code: 200, tweet: { id: 'x', date: '2026-01-01' } }), { status: 200 });
      // Everything else: fall through to a soft error so the collector
      // treats it as "unreachable" rather than crashing.
      return new Response('{}', { status: 500 });
    };
    // Opt in to running main() since we're a wrapper, not the entry point.
    globalThis.__COLLECT_TOURNAMENT_REPORTS_RUN_MAIN__ = true;
    await import(${JSON.stringify(pathToFileURL(collectorPath).href)});
  `);
  const argv = [
    wrapperPath,
    '--live',
    '--skip-discovery=no',
    '--sources-dir', sources,
    '--out-dir', outDir,
    '--now', '2026-09-05T00:00:00Z',
  ];
  const res = spawnSync(
    process.execPath,
    ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(repoRoot, 'scripts', 'register-ts.mjs'), ...argv],
    { encoding: 'utf8', timeout: 60_000 },
  );
  const combined = `${res.stdout ?? ''}\n${res.stderr ?? ''}`;
  ok(
    'live collector EXITS NON-ZERO when a newer official column is discovered (DIC-1380 W7 CR fail-closed acquisition)',
    res.status !== 0,
    `exit=${res.status}\n${combined}`,
  );
  ok(
    'live collector writes the discovery-stub source file it named',
    fs.existsSync(path.join(sources, 'discovered-2026-09-04.json')),
    `sources dir contents:\n${fs.readdirSync(sources).join('\n')}`,
  );
  ok(
    'live collector output surfaces the newer publication + the stub it wrote',
    /newer official deck-showcase column was published .*2026-09-04.*/i.test(combined)
      && /discovered-2026-09-04\.json/.test(combined),
    combined.slice(0, 800),
  );
}

if ((process.exitCode ?? 0) === 0) {
  console.log(`\n✅ DIC-1380 W7 tournament discovery + acquisition: ${passed} checks passed`);
} else {
  console.error(`\n❌ DIC-1380 W7 tournament discovery + acquisition failed`);
}
