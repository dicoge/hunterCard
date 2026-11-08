#!/usr/bin/env node
/**
 * SYNTHETIC TEST-ONLY retained-SELL rendering fixture generator (LOCAL ONLY, 2026-11-09).
 *
 * What it makes: a copy of the EXACT d5 canonical catalog (data/database.json, sha cd7963c0…) in
 * which ONE row — hBD24-010_hPR_P_hBD24-010_P (雪花菈米, the single own printing of hBD24-010,
 * ¥9,980, quoted 2026-08-25T12:11:18.894Z, sourceProduct hPR) — gains the writer flag
 * `sellQuoteRetained: true`, plus the native asset produced from it by the product's OWN unchanged
 * `sanitizeDatabase` (the exact transform scripts/generate-native-database.mjs applies). Nothing else
 * changes: price, quote time, source, printing, listing, history, every other row and every top-level
 * field are byte/semantically preserved and re-verified after the change.
 *
 * What it is NOT: scraped data, a genuine "missing this run" observation, a remote download, a
 * production data change, a price, a history entry or a sequence. It never writes into the product
 * checkout, cache pointers or app data; it only writes a NEW output directory. It exists solely so a
 * test-only client can RENDER the retained label offline next to the unflagged d5 control.
 *
 * Inputs are strict: the pinned d5 canonical / public / series-names hashes, canonical in the
 * builder's own serialization, public == sanitizeDatabase(canonical), zero existing flags, exactly
 * one row for the card number (no sibling / alias), the exact price / time / source / single listing,
 * and no BUY / private field anywhere in the shipped form.
 *
 * Modes (default = --describe: no file read, no write, no process, no network)
 *   node generate_retained_fixture.mjs [--describe]
 *   node generate_retained_fixture.mjs --verify-inputs --product-root <d5 checkout>      (read-only)
 *   node generate_retained_fixture.mjs --generate --product-root <d5 checkout> --out <new dir>
 * Uses only Node built-ins (Node 22) and the product's own scripts/lib/store-mvp-sanitize.mjs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const LABEL = 'SYNTHETIC TEST-ONLY RENDERING FIXTURE — not scraped data, not a genuine missing-this-run observation, '
  + 'not a remote download; never publish, merge or release';
export const SCHEMA = 'hh-retained-ui-fixture/1';
export const FLAG = 'sellQuoteRetained';

export const FIXED = Object.freeze({
  productCommit: 'd5b3c6cfb1c8c88261327f38f7b5d590dce8a50a',
  productTree: 'e030503eee9cf668b5c42a7e13f3c512a94a5e31',
  canonicalSha256: 'cd7963c0ff85fbd69755a848ea64d5de0dae346cd334a3936e7d2724eba0811f',
  publicSha256: '20caa524c21655f27b40c159cf05bb2b3b613e7dfa815bca7aa6ac832c3797ed',
  seriesNamesSha256: '87dab36200e5e63038c1f88d9271fc071478b2ae3eb04445b6cff864c8a36667', // sha256(JSON.stringify(names))
  cardCount: 3975,
  rowId: 'hBD24-010_hPR_P_hBD24-010_P',
  cardNumber: 'hBD24-010',
  sellPrice: 9980,
  timestamp: '2026-08-25T12:11:18.894Z',
  sourceProduct: 'hPR',
  controlApkSha256: '284c830eee91cbb68d7423c4099c724ee1bcd6267835fc4ea8d3b643c709e58b',
  controlEvidence: 'evidence/daily-20261108/native-oldquote-single-source/runs/smoke-20261108T141128Z/REPORT.json',
});

const REL = Object.freeze({
  canonical: 'data/database.json',
  public: 'public/data/database.json',
  names: 'data/series-names.json',
  sanitize: 'scripts/lib/store-mvp-sanitize.mjs',
  nativeGenerator: 'scripts/generate-native-database.mjs',
  zh: 'src/i18n/locales/zh.ts',
});
const MAX = Object.freeze({ canonical: 64 << 20, public: 32 << 20, names: 1 << 20, sanitize: 1 << 20, nativeGenerator: 1 << 20, zh: 4 << 20 });

// Hard privacy floor, unioned with the product's own lists (never narrower than either).
const HARD_CARD = ['buyPrice', 'buyPriceHistory', 'priceHistory', 'ytStats', 'buyPriceRetained', 'buyLastKnown',
  'buyPriorSource', '_rawPricesArchive'];
const HARD_VARIANT = ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp', 'buyPriceRetained',
  'buyLastKnown', 'buyPriorSource', '_rawPricesArchive'];
const HARD_DB = ['buyQuoteRun'];

export const I18N_KEYS = Object.freeze(['price_quote_retained', 'price_quote_retained_tag', 'price_quote_last_known',
  'price_quote_old_tag']);

export const NOT_EVIDENCE_OF = Object.freeze([
  'a genuine scraped missing-this-run case', 'a remote catalog download', 'corrupt-cache fallback',
  'production data', 'a fresh or new quote', 'BUY display', 'release / Play / OpenClaw acceptance']);

export class FixtureRefusal extends Error {}
function refuse(msg) { throw new FixtureRefusal(msg); }
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// ── paths ──────────────────────────────────────────────────────────────────
function lstatOrNull(p) { try { return fs.lstatSync(p); } catch { return null; } }

function realDir(p, what) {
  const abs = path.resolve(p);
  const st = lstatOrNull(abs);
  if (!st) refuse(`${what} does not exist`);
  if (st.isSymbolicLink() || !st.isDirectory()) refuse(`${what} must be a real directory, not a symlink`);
  if (fs.realpathSync(abs) !== abs) refuse(`${what} path must not traverse a symlink`);
  return abs;
}

function readRegular(root, key) {
  const p = path.join(root, REL[key]);
  const st = lstatOrNull(p);
  if (!st) refuse(`input missing: ${REL[key]}`);
  if (st.isSymbolicLink() || !st.isFile()) refuse(`input ${REL[key]} must be a regular file, not a symlink`);
  if (fs.realpathSync(p) !== p) refuse(`input ${REL[key]} must not traverse a symlink`);
  if (st.size > MAX[key]) refuse(`input ${REL[key]} exceeds ${MAX[key]} bytes`);
  return fs.readFileSync(p);
}

function parseJson(buf, what) {
  try { return JSON.parse(buf.toString('utf8')); } catch { return refuse(`${what} is not valid JSON`); }
}

export function prepareOutDir(outDir, productRoot) {
  if (typeof outDir !== 'string' || !outDir) refuse('--out is required');
  const abs = path.resolve(outDir);
  if (lstatOrNull(abs)) refuse('output path already exists; nothing is ever overwritten');
  realDir(path.dirname(abs), 'output parent');
  if (abs === productRoot || abs.startsWith(productRoot + path.sep)) refuse('output must be outside the product checkout');
  if (productRoot.startsWith(abs + path.sep)) refuse('the product checkout must not be inside the output');
  return abs;
}

// ── data checks ────────────────────────────────────────────────────────────
export function flagCount(db) {
  let n = 0;
  for (const e of Object.values(db?.cards || {})) if (e && typeof e === 'object' && Object.hasOwn(e, FLAG)) n += 1;
  return n;
}

/** The UI groups rows by (cardNumber || id), case-insensitively (SearchResultsScreen rowsByNumber). */
function rowsForNumber(db, number) {
  const n = number.toLowerCase();
  return Object.entries(db.cards).filter(([, e]) => e && typeof e === 'object'
    && String(e.cardNumber || e.id || '').toLowerCase() === n);
}

function checkRow(db, fixed, where) {
  if (!db || typeof db !== 'object' || !db.cards || typeof db.cards !== 'object') refuse(`${where}: no cards object`);
  const hits = rowsForNumber(db, fixed.cardNumber);
  if (hits.length !== 1) refuse(`${where}: expected exactly one row for ${fixed.cardNumber} (no sibling), found ${hits.length}`);
  const [key, e] = hits[0];
  if (key !== fixed.rowId || e.id !== fixed.rowId) refuse(`${where}: the ${fixed.cardNumber} row is not ${fixed.rowId}`);
  const n = fixed.cardNumber.toLowerCase();
  const aliases = Object.entries(db.cards).filter(([k, x]) => k !== key
    && (k.toLowerCase().includes(n) || String(x?.id || '').toLowerCase().includes(n)));
  if (aliases.length) refuse(`${where}: ${aliases.length} alias row(s) also name ${fixed.cardNumber}; sibling borrowing not excluded`);
  if (e.sellPrice !== fixed.sellPrice) refuse(`${where}: sellPrice ${e.sellPrice} != ${fixed.sellPrice}`);
  if (e.timestamp !== fixed.timestamp) refuse(`${where}: quote timestamp differs from ${fixed.timestamp}`);
  if (e.sourceProduct !== fixed.sourceProduct) refuse(`${where}: sourceProduct differs from ${fixed.sourceProduct}`);
  if (!Array.isArray(e.prices) || e.prices.length !== 1 || e.prices[0]?.sellPrice !== fixed.sellPrice) {
    refuse(`${where}: the row must carry exactly its own single listing at ${fixed.sellPrice}`);
  }
}

function privacyLists(san) {
  const u = (...xs) => [...new Set(xs.flat())];
  return { card: u(HARD_CARD, san.FORBIDDEN_CARD_FIELDS, san.INTERNAL_AUDIT_FIELDS),
    variant: u(HARD_VARIANT, san.FORBIDDEN_VARIANT_FIELDS, san.INTERNAL_AUDIT_FIELDS),
    db: u(HARD_DB, san.INTERNAL_DATABASE_FIELDS) };
}

export function checkPrivacy(db, lists, where) {
  for (const f of lists.db) if (Object.hasOwn(db, f)) refuse(`${where}: privacy leak: top-level ${f}`);
  for (const [k, e] of Object.entries(db.cards || {})) {
    if (!e || typeof e !== 'object') continue;
    for (const f of lists.card) if (Object.hasOwn(e, f)) refuse(`${where}: privacy leak: ${k}.${f}`);
    if (Array.isArray(e.prices)) {
      e.prices.forEach((p, i) => {
        if (p && typeof p === 'object') for (const f of lists.variant) if (Object.hasOwn(p, f)) refuse(`${where}: privacy leak: ${k}.prices[${i}].${f}`);
      });
    }
  }
}

export function expectedUi(zhText, fixed) {
  const v = {};
  for (const k of I18N_KEYS) {
    const m = [...zhText.matchAll(new RegExp(`^\\s*${k}: '([^'\\\\\\n]*)',\\s*$`, 'gm'))];
    if (m.length !== 1) refuse(`zh.ts must define ${k} exactly once (found ${m.length})`);
    v[k] = m[0][1];
  }
  for (const k of ['price_quote_retained', 'price_quote_last_known']) {
    if (v[k].split('{{date}}').length !== 2) refuse(`zh.ts ${k} must contain {{date}} exactly once`);
  }
  for (const k of ['price_quote_retained_tag', 'price_quote_old_tag']) if (!v[k] || v[k].includes('{{')) refuse(`zh.ts ${k} unexpected`);
  if (v.price_quote_retained_tag === v.price_quote_old_tag) refuse('retained and old tags must differ');
  const date = String(fixed.timestamp).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) refuse('quote timestamp has no ISO date prefix');
  return {
    quoteDate: date,
    fixture: { flag: true, searchResultTagKey: 'price_quote_retained_tag', searchResultTag: v.price_quote_retained_tag,
      detailQuoteLineKey: 'price_quote_retained', detailQuoteLine: v.price_quote_retained.replace('{{date}}', date) },
    control: { flag: false, searchResultTagKey: 'price_quote_old_tag', searchResultTag: v.price_quote_old_tag,
      detailQuoteLineKey: 'price_quote_last_known', detailQuoteLine: v.price_quote_last_known.replace('{{date}}', date) },
  };
}

// ── inputs ─────────────────────────────────────────────────────────────────
export async function verifyInputs({ productRoot, fixed = FIXED }) {
  const root = realDir(productRoot, 'product root');
  const bytes = {};
  for (const key of Object.keys(REL)) bytes[key] = readRegular(root, key);
  const canonicalSha = sha256(bytes.canonical);
  const publicSha = sha256(bytes.public);
  if (canonicalSha !== fixed.canonicalSha256) refuse(`canonical ${REL.canonical} sha256 ${canonicalSha} != pinned ${fixed.canonicalSha256}`);
  if (publicSha !== fixed.publicSha256) refuse(`public ${REL.public} sha256 ${publicSha} != pinned ${fixed.publicSha256}`);
  const namesSha = sha256(Buffer.from(JSON.stringify(parseJson(bytes.names, REL.names)), 'utf8'));
  if (namesSha !== fixed.seriesNamesSha256) refuse(`series names stringify sha256 ${namesSha} != pinned ${fixed.seriesNamesSha256}`);

  const canonText = bytes.canonical.toString('utf8');
  const canonical = parseJson(bytes.canonical, REL.canonical);
  if (`${JSON.stringify(canonical, null, 2)}\n` !== canonText) refuse('canonical serialization is not the builder form JSON.stringify(db, null, 2) + "\\n"');
  const publicText = bytes.public.toString('utf8');
  const pub = parseJson(bytes.public, REL.public);

  const san = await import(pathToFileURL(path.join(root, REL.sanitize)).href);
  for (const name of ['sanitizeDatabase', 'FORBIDDEN_CARD_FIELDS', 'FORBIDDEN_VARIANT_FIELDS', 'INTERNAL_AUDIT_FIELDS', 'INTERNAL_DATABASE_FIELDS']) {
    if (!(name in san)) refuse(`product sanitizer lacks ${name}`);
  }
  if (JSON.stringify(san.sanitizeDatabase(canonical)) !== publicText) refuse('source parity: public asset != sanitizeDatabase(canonical)');
  const lists = privacyLists(san);
  checkPrivacy(pub, lists, 'source public');

  for (const [where, db] of [['canonical', canonical], ['public', pub]]) {
    const count = Object.keys(db.cards || {}).length;
    if (count !== fixed.cardCount) refuse(`${where}: ${count} cards != pinned ${fixed.cardCount}`);
    if (flagCount(db) !== 0) refuse(`${where}: source already carries ${FLAG} (zero expected in d5)`);
    checkRow(db, fixed, where);
  }
  const ui = expectedUi(bytes.zh.toString('utf8'), fixed);
  return { root, bytes, canonicalSha, publicSha, namesSha, canonText, publicText, san, lists, ui };
}

// ── change + post-verification ─────────────────────────────────────────────
export function applyFlag(canonText, rowId) {
  const db = JSON.parse(canonText);
  db.cards[rowId][FLAG] = true;
  return `${JSON.stringify(db, null, 2)}\n`;
}

/** The fixture canonical differs from the source by exactly one added `"sellQuoteRetained": true`. */
export function verifyCanonicalDelta(origText, outText, rowId) {
  let m;
  try { m = JSON.parse(outText); } catch { refuse('fixture canonical is not valid JSON'); }
  if (flagCount(m) !== 1 || m.cards?.[rowId]?.[FLAG] !== true) refuse(`fixture canonical must carry exactly one ${FLAG}: true, on ${rowId}`);
  delete m.cards[rowId][FLAG];
  if (`${JSON.stringify(m, null, 2)}\n` !== origText) refuse('fixture canonical changes more than the single flag');
  // Byte level: the source lines, except that the row's last property line gained a comma and one
  // `"sellQuoteRetained": true` line at the same indent follows it. Any reformat is refused.
  const a = origText.split('\n');
  const b = outText.split('\n');
  if (b.length !== a.length + 1) refuse('fixture canonical must differ by one inserted line');
  let i = 0;
  while (i < a.length && a[i] === b[i]) i += 1;
  const indent = (a[i] || '').match(/^ */)[0];
  if (i >= a.length || b[i] !== `${a[i]},` || b[i + 1] !== `${indent}"${FLAG}": true`
      || b.slice(i + 2).join('\n') !== a.slice(i + 1).join('\n')) {
    refuse('fixture canonical bytes differ from the source by more than the one inserted flag line');
  }
}

/** The fixture native asset differs from the source asset by exactly that flag, with no private field. */
export function verifyPublicDelta(origPublicText, outPublicText, rowId, lists) {
  let m;
  try { m = JSON.parse(outPublicText); } catch { refuse('fixture public is not valid JSON'); }
  if (flagCount(m) !== 1 || m.cards?.[rowId]?.[FLAG] !== true) refuse(`fixture public must carry exactly one ${FLAG}: true, on ${rowId}`);
  checkPrivacy(m, lists, 'fixture public');
  delete m.cards[rowId][FLAG];
  if (JSON.stringify(m) !== origPublicText) refuse('fixture public changes more than the single flag');
  // Byte level: the source asset with exactly one `,"sellQuoteRetained":true` inserted.
  const ins = `,"${FLAG}":true`;
  const at = outPublicText.indexOf(ins);
  if (at < 0 || outPublicText.indexOf(ins, at + 1) >= 0 || outPublicText.length !== origPublicText.length + ins.length
      || outPublicText.slice(0, at) + outPublicText.slice(at + ins.length) !== origPublicText) {
    refuse('fixture public bytes differ from the source by more than the one inserted flag');
  }
}

function writeExcl(file, text) {
  const fd = fs.openSync(file, 'wx', 0o644);
  try { fs.writeSync(fd, text); } finally { fs.closeSync(fd); }
}

export async function generateFixture({ productRoot, outDir, fixed = FIXED }) {
  const v = await verifyInputs({ productRoot, fixed });
  const out = prepareOutDir(outDir, v.root);
  const canonOut = applyFlag(v.canonText, fixed.rowId);
  verifyCanonicalDelta(v.canonText, canonOut, fixed.rowId);
  const publicOut = JSON.stringify(v.san.sanitizeDatabase(JSON.parse(canonOut)));
  verifyPublicDelta(v.publicText, publicOut, fixed.rowId, v.lists);
  checkRow(JSON.parse(publicOut), fixed, 'fixture public');

  const outputs = {
    'data/database.json': { sha256: sha256(Buffer.from(canonOut, 'utf8')), bytes: Buffer.byteLength(canonOut) },
    'public/data/database.json': { sha256: sha256(Buffer.from(publicOut, 'utf8')), bytes: Buffer.byteLength(publicOut) },
  };
  const manifest = {
    schema: SCHEMA, label: LABEL, synthetic: true,
    evidenceClass: 'offline RENDERING of an explicit writer flag on real d5 data only',
    notEvidenceOf: [...NOT_EVIDENCE_OF],
    product: { commit: fixed.productCommit, tree: fixed.productTree, note: 'declared pins; the CI recipe verifies the checkout tree' },
    inputs: {
      [REL.canonical]: { sha256: v.canonicalSha, bytes: v.bytes.canonical.length },
      [REL.public]: { sha256: v.publicSha, bytes: v.bytes.public.length },
      seriesNamesStringifySha256: v.namesSha,
      [REL.zh]: { sha256: sha256(v.bytes.zh) },
      [REL.sanitize]: { sha256: sha256(v.bytes.sanitize) },
    },
    change: { row: fixed.rowId, cardNumber: fixed.cardNumber, field: FLAG, before: 'absent', after: true,
      rowsChanged: 1, flagsInFixture: 1, otherFieldsChanged: 0 },
    preserved: { sellPrice: fixed.sellPrice, quoteTimestamp: fixed.timestamp, sourceProduct: fixed.sourceProduct,
      listings: 1, siblingRows: 0, seriesNames: 'unchanged (not emitted)' },
    outputs,
    expectedUi: v.ui,
    control: { apkSha256: fixed.controlApkSha256, data: 'unchanged d5 bundle (no flag)', priorObservation: fixed.controlEvidence },
    runConstraints: [
      'airplane mode ON before the FIRST launch and for every launch: the fixture bundle differs from the official catalog, so an online refresh would legitimately replace it',
      `search ${fixed.cardNumber} → exactly one result tile; its price-age tag must equal expectedUi.fixture.searchResultTag`,
      'card detail must show expectedUi.fixture.detailQuoteLine and the unchanged price / source',
      'no BUY surface may appear (Store MVP)',
      'the control is the unchanged d5 APK on the same card: expectedUi.control.* and never the retained text',
    ],
  };
  const manifestText = `${JSON.stringify(manifest, null, 2)}\n`;

  fs.mkdirSync(out);
  fs.mkdirSync(path.join(out, 'data'));
  fs.mkdirSync(path.join(out, 'public'));
  fs.mkdirSync(path.join(out, 'public', 'data'));
  writeExcl(path.join(out, 'data', 'database.json'), canonOut);
  writeExcl(path.join(out, 'public', 'data', 'database.json'), publicOut);
  writeExcl(path.join(out, 'FIXTURE_MANIFEST.json'), manifestText);

  for (const key of ['canonical', 'public']) {     // the source checkout is still byte-identical
    if (sha256(readRegular(v.root, key)) !== (key === 'canonical' ? v.canonicalSha : v.publicSha)) refuse(`source ${REL[key]} changed during generation`);
  }
  return manifest;
}

// ── CLI ────────────────────────────────────────────────────────────────────
export function describe() {
  return { label: LABEL, schema: SCHEMA, fixed: FIXED, change: `cards.${FIXED.rowId}.${FLAG}: absent → true (only)`,
    inputs: REL, outputs: ['data/database.json', 'public/data/database.json', 'FIXTURE_MANIFEST.json'],
    modes: ['--describe (default; no read/write)', '--verify-inputs --product-root <dir> (read-only)',
      '--generate --product-root <dir> --out <new dir>'],
    notEvidenceOf: [...NOT_EVIDENCE_OF] };
}

export async function main(argv, io = { out: process.stdout, err: process.stderr }) {
  const say = (s) => io.out.write(`${s}\n`);
  if (argv.length === 0 || (argv.length === 1 && argv[0] === '--describe')) { say(JSON.stringify(describe(), null, 2)); return 0; }
  const mode = argv[0];
  const opts = {};
  for (let i = 1; i < argv.length; i += 2) {
    if (!['--product-root', '--out'].includes(argv[i]) || typeof argv[i + 1] !== 'string' || argv[i] in opts) {
      io.err.write(`refused: unexpected argument ${argv[i]}\n`);
      return 2;
    }
    opts[argv[i]] = argv[i + 1];
  }
  try {
    if (mode === '--verify-inputs' && opts['--product-root'] && !opts['--out']) {
      const v = await verifyInputs({ productRoot: opts['--product-root'] });
      say(JSON.stringify({ verified: true, canonicalSha256: v.canonicalSha, publicSha256: v.publicSha, expectedUi: v.ui }, null, 2));
      return 0;
    }
    if (mode === '--generate' && opts['--product-root'] && opts['--out']) {
      const m = await generateFixture({ productRoot: opts['--product-root'], outDir: opts['--out'] });
      say(JSON.stringify({ generated: true, label: LABEL, outputs: m.outputs }, null, 2));
      return 0;
    }
    io.err.write('refused: use --describe, --verify-inputs --product-root <dir>, or --generate --product-root <dir> --out <new dir>\n');
    return 2;
  } catch (e) {
    if (e instanceof FixtureRefusal) { io.err.write(`refused: ${e.message}\n`); return 2; }
    throw e;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2));
}
