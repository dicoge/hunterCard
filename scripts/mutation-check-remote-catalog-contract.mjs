#!/usr/bin/env node
/**
 * Isolated mutation sanity check for the remote-catalog contract gate (review F1).
 *
 * Proves the CI step `npm run test:remote-catalog` really goes red when the
 * client's forbidden-field list drifts from the server sanitizer — WITHOUT ever
 * touching the working tree:
 *
 *   1. copy only the public source/data files the contract test needs into a
 *      fresh, task-owned temp directory (no .git, no node_modules, no user data,
 *      no credentials);
 *   2. CONTROL: run the exact real contract test in an unmutated copy → must exit 0
 *      (so a red mutation run cannot come from a broken harness);
 *   3. MUTATION: in a second copy, remove 'buyPrice' from the copied client
 *      FORBIDDEN_CARD_FIELDS and run the same test → must exit non-zero with an
 *      AssertionError naming the drifted field;
 *   4. delete both temp directories.
 *
 * No network, installs or shared-cache changes. Exit 0 only when the control
 * passes AND the mutation is caught.
 *
 * Run: node scripts/mutation-check-remote-catalog-contract.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

// Everything scripts/test-remote-catalog-contract.mjs imports or reads.
const FILES = [
  'package.json',
  'scripts/register-ts.mjs',
  'scripts/test-remote-catalog-contract.mjs',
  'scripts/lib/store-mvp-sanitize.mjs',
  'scripts/lib/native-catalog-publish.mjs',
  'scripts/fix-html.js',
  'src/services/catalog/catalogContract.ts',
  'src/services/catalog/catalogRepository.ts',
  'src/services/catalog/catalogPlatform.native.ts',
  'src/utils/staticData.ts',
  'src/utils/staticData.web.ts',
  'data/database.json',
  'data/series-names.json',
  'public/data/database.json',
];

const ORIGINAL_LIST = "export const FORBIDDEN_CARD_FIELDS = ['buyPrice', 'buyPriceHistory', 'priceHistory', 'ytStats', 'buyPriceRetained', 'buyLastKnown', 'buyPriorSource'] as const;";
const MUTATED_LIST = "export const FORBIDDEN_CARD_FIELDS = ['buyPriceHistory', 'priceHistory', 'ytStats', 'buyPriceRetained', 'buyLastKnown', 'buyPriorSource'] as const;";

function makeCopy(tag) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `holo-remote-catalog-${tag}-`));
  for (const rel of FILES) {
    const src = path.join(repoRoot, rel);
    if (!fs.existsSync(src)) throw new Error(`required file missing in the worktree: ${rel}`);
    const dest = path.join(dir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
  }
  return dir;
}

function runContract(dir) {
  return spawnSync(process.execPath, [
    '--experimental-strip-types',
    '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON',
    '--import', './scripts/register-ts.mjs',
    'scripts/test-remote-catalog-contract.mjs',
  ], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: os.tmpdir(), TMPDIR: os.tmpdir() } });
}

const dirs = [];
let exitCode = 1;
try {
  // Control.
  const control = makeCopy('control');
  dirs.push(control);
  const c = runContract(control);
  if (c.status !== 0) {
    console.error('✗ CONTROL failed: the unmutated copy must pass before a mutation result means anything.');
    console.error(c.stdout, c.stderr);
    process.exitCode = 2;
  } else {
    console.log('✓ control: unmutated isolated copy passes the real contract test');

    // Mutation.
    const mutant = makeCopy('mutant');
    dirs.push(mutant);
    const contractPath = path.join(mutant, 'src/services/catalog/catalogContract.ts');
    const src = fs.readFileSync(contractPath, 'utf8');
    if (src.split(ORIGINAL_LIST).length !== 2) {
      console.error('✗ mutation not applied: the FORBIDDEN_CARD_FIELDS declaration changed shape; update this helper.');
      process.exitCode = 2;
    } else {
      fs.writeFileSync(contractPath, src.replace(ORIGINAL_LIST, MUTATED_LIST));
      const r = runContract(mutant);
      const output = `${r.stdout}\n${r.stderr}`;
      const caught = r.status !== 0 && /AssertionError/.test(output) && /buyPrice/.test(output);
      if (caught) {
        console.log(`✓ mutation caught: removing 'buyPrice' from the client list exits ${r.status} with an AssertionError naming buyPrice`);
        exitCode = 0;
      } else {
        console.error(`✗ mutation NOT caught (exit ${r.status}); the contract gate is not sensitive to forbidden-field drift.`);
        console.error(output);
      }
    }
  }
} finally {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
}
if (process.exitCode == null) process.exitCode = exitCode;
