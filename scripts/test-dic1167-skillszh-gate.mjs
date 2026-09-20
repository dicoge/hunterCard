#!/usr/bin/env node
// DIC-1167: the completeness gate must hard-fail on ANY official printing
// missing user-visible Traditional-Chinese text (nameZh / skillsZh), with no
// cardNumber-level exemption path. The 2026-09-18 incident state — 498
// Production printings with empty skillsZh passing the gate because 227
// cardNumbers were pinned in data/official-skills-zh-gap.json — must be
// unrepresentable: this suite drives the REAL gate (runCompletenessGate) over
// fixture repos and proves
//   1. a complete fixture passes;
//   2. one printing missing skillsZh fails, naming the field, even when every
//      OTHER printing of the same cardNumber carries it (printing-level, not
//      cardNumber-level);
//   3. writing the retired data/official-skills-zh-gap.json exemption file —
//      even one that lists the gapped cardNumber — does NOT rescue the gap and
//      is ITSELF a failure on an otherwise-green repo, so the exemption
//      mechanism cannot silently return;
//   4. missing nameZh and missing skillsJp fail identically (the DIC-1167
//      requirement covers all user-visible per-printing text);
//   5. the shipped repo carries no gap file and no official row without
//      skillsZh — the incident state is really gone, not just untested.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCompletenessGate } from './verify-official-catalog-completeness.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMG = 'https://hololive-official-cardgame.com/wp-content/images/cardlist/hZZ99/hZZ99-001_OUR.png';

/** Build a minimal but fully-valid fixture repo, then let `mutate` break it. */
function makeFixture(mutate = () => {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dic1167-gate-'));
  const officialRow = (rarity, img) => ({
    id: `hZZ99-001_${rarity}`,
    cardNumber: 'hZZ99-001',
    name: 'テスト',
    sourceProduct: 'hZZ99',
    sourceProductName: 'Test Product',
    rarity,
    imageUrl: img,
  });
  const dbRow = (rarity, img) => ({
    id: `hZZ99-001_hZZ99_${rarity}`,
    cardNumber: 'hZZ99-001',
    name: 'テスト',
    nameZh: '測試',
    sourceProduct: 'hZZ99',
    sourceProductName: 'Test Product',
    rarity,
    officialImage: img,
    skillsJp: { abilityText: 'テキスト' },
    skillsZh: { abilityText: '文字' },
  });
  const img2 = IMG.replace('_OUR', '_SEC');
  const fixture = {
    meta: { totalCards: 2, seriesStats: [{ code: 'hZZ99', expectedCount: 2 }] },
    official: [officialRow('OUR', IMG), officialRow('SEC', img2)],
    db: { cards: { a: dbRow('OUR', IMG), b: dbRow('SEC', img2) } },
  };
  mutate(fixture, dir);
  fs.mkdirSync(path.join(dir, 'data', 'official'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'public', 'data'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'official', '_meta.json'), JSON.stringify(fixture.meta));
  fs.writeFileSync(path.join(dir, 'data', 'official', 'hZZ99.json'), JSON.stringify(fixture.official));
  fs.writeFileSync(path.join(dir, 'data', 'database.json'), JSON.stringify(fixture.db));
  fs.writeFileSync(path.join(dir, 'public', 'data', 'database.json'), JSON.stringify(fixture.db));
  return dir;
}

// ── 1. A complete fixture passes ─────────────────────────────────────
{
  const dir = makeFixture();
  const summary = runCompletenessGate(dir);
  assert.match(summary, /completeness gate passed/);
  assert.match(summary, /no exemptions/);
}

// ── 2. One printing missing skillsZh fails — printing-level ──────────
// The sibling printing of the SAME cardNumber keeps its skillsZh, so a
// cardNumber-level check would see the number as covered. The gate must still
// fail on the specific printing (canonical and public are checked alike).
{
  for (const variant of [
    (row) => { delete row.skillsZh; },
    (row) => { row.skillsZh = {}; },       // empty object is not coverage
    (row) => { row.skillsZh = '  '; },     // blank string is not coverage
  ]) {
    const dir = makeFixture((f) => variant(f.db.cards.b));
    assert.throws(
      () => runCompletenessGate(dir),
      /missing skillsZh/,
      'a printing without skillsZh must fail the gate even when its sibling printing has it',
    );
  }
}

// ── 3. The retired exemption file cannot rescue anything ─────────────
{
  // 3a. Gap file listing the gapped cardNumber: the gap must STILL fail.
  const gapped = makeFixture((f, dir) => {
    delete f.db.cards.b.skillsZh;
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'data', 'official-skills-zh-gap.json'),
      JSON.stringify({ maxEntries: 1, cardNumbers: ['hZZ99-001'] }),
    );
  });
  assert.throws(
    () => runCompletenessGate(gapped),
    /retired/,
    'the exemption file must be rejected outright — it can never exempt a missing skillsZh again',
  );

  // 3b. Even on an otherwise fully-green repo, the file's mere presence fails.
  const greenButPinned = makeFixture((f, dir) => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'data', 'official-skills-zh-gap.json'),
      JSON.stringify({ maxEntries: 0, cardNumbers: [] }),
    );
  });
  assert.throws(
    () => runCompletenessGate(greenButPinned),
    /retired/,
    'even an empty exemption file must hard-fail: the mechanism itself is retired',
  );
}

// ── 4. nameZh and skillsJp are equally unconditional ─────────────────
{
  const noNameZh = makeFixture((f) => { f.db.cards.a.nameZh = ''; });
  assert.throws(() => runCompletenessGate(noNameZh), /missing nameZh/);
  const noSkillsJp = makeFixture((f) => { delete f.db.cards.a.skillsJp; });
  assert.throws(() => runCompletenessGate(noSkillsJp), /missing skillsJp/);
}

// ── 5. The shipped repo really left the incident state ───────────────
{
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'data', 'official-skills-zh-gap.json')),
    'data/official-skills-zh-gap.json must stay deleted',
  );
  const meta = JSON.parse(fs.readFileSync(path.join(repoRoot, 'data', 'official', '_meta.json'), 'utf8'));
  const products = new Set((meta.seriesStats || []).map((s) => s.code));
  const nonEmpty = (v) => (typeof v === 'string' ? v.trim().length > 0
    : Array.isArray(v) ? v.length > 0
      : v && typeof v === 'object' ? Object.keys(v).length > 0 : v != null);
  for (const dbFile of ['data/database.json', 'public/data/database.json']) {
    const db = JSON.parse(fs.readFileSync(path.join(repoRoot, dbFile), 'utf8'));
    const gaps = Object.values(db.cards)
      .filter((c) => products.has(c.sourceProduct))
      .filter((c) => !nonEmpty(c.skillsZh) || !nonEmpty(c.nameZh))
      .map((c) => c.id);
    assert.deepEqual(gaps, [], `${dbFile}: every official printing must carry nameZh and skillsZh; missing on: ${gaps.slice(0, 10).join(', ')}`);
  }
}

console.log('✓ DIC-1167: the completeness gate hard-fails any official printing missing skillsZh/nameZh/skillsJp at printing level, rejects the retired exemption file outright (empty or not), and the shipped canonical+public databases carry full Traditional-Chinese coverage with the baseline deleted');
