#!/usr/bin/env node
// DIC-1468: the Official Catalog Sync pipeline discovered brand-new official
// printings, upserted them, and then failed its own completeness gate — six new
// hBP09 yell printings landed with neither skillsJp nor skillsZh, because
// nothing in the pipeline ever acquired skill text for a NEW cardNumber
// (data/effects-jp.json only grew when a human ran scrape-effects.js by hand).
//
// This suite pins the repair's load-bearing properties. Layers:
//   1. work-list      — which cardNumbers the acquisition pass fetches.
//   2. provenance     — a fetched page must declare the cardNumber we asked
//                       for, so one card's rules text can never be stamped
//                       onto another's cardNumber (parseCardPage takes the
//                       cardNumber from the REQUEST, not the HTML).
//   3. derivation     — the controlled-map Traditional-Chinese rule reproduces
//                       the entries already committed to data/effects-zh.json
//                       byte for byte, and refuses everything else.
//   4. fail-closed    — rules text, unmapped names, unknown card types,
//                       prototype keys, and kana all return null.
//   5. retirement     — the pinned skillsZh gap baseline stays deleted
//                       (DIC-1167: skillsZh is required per printing, no
//                       exemption file may return).
//   6. mutation       — each guard is proven load-bearing: remove the reason a
//                       card is refused and the SAME input starts deriving, so
//                       a weakened guard cannot pass this suite silently.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  hasRulesText,
  deriveStructuralZh,
  missingEffectsCardNumbers,
  RULES_TEXT_FIELDS,
} from './lib/official-effects-enrichment.mjs';
import {
  cardNumberDeclaredOnPage,
  deriveMissingZh,
  readOfficialRows,
} from './enrich-official-effects.mjs';

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(repoRoot, ...parts), 'utf8'));

const effectsJp = readJson('data', 'effects-jp.json');
const effectsZh = readJson('data', 'effects-zh.json');
const nameZhMap = readJson('data', 'character-names-zh.json');

// ── 1. Work list ─────────────────────────────────────────────────────
// Only cardNumbers with no effects entry are fetched, rows without a detail
// `id` are unfetchable and skipped, and duplicates collapse to one work item.
{
  const rows = [
    { id: '1', cardNumber: 'hAA01-001' },                    // missing -> fetch
    { id: '2', cardNumber: 'hAA01-002' },                    // already present
    { cardNumber: 'hAA01-003' },                             // no id -> unfetchable
    { id: '4', cardNumber: 'hAA01-001' },                    // duplicate printing
    { id: '5' },                                             // no cardNumber
  ];
  const work = missingEffectsCardNumbers(rows, { 'hAA01-002': { cardNumber: 'hAA01-002' } });
  assert.deepEqual(
    work.map((w) => w.cardNumber),
    ['hAA01-001'],
    'only cardNumbers absent from the effects map are queued, deduped, and only when fetchable',
  );
  // An empty map must queue everything fetchable — the cold-start case.
  assert.equal(missingEffectsCardNumbers(rows, Object.create(null)).length, 2);
  // Prototype keys must not be mistaken for existing entries (DIC-1417).
  const protoWork = missingEffectsCardNumbers([{ id: '9', cardNumber: 'constructor' }], {});
  assert.deepEqual(protoWork.map((w) => w.cardNumber), ['constructor'],
    'an inherited Object.prototype member must not look like an existing effects entry');
}

// ── 2. Provenance: the page must declare the card we asked for ───────
// This is the cross-printing guard. parseCardPage() copies cardNumber/name from
// the request row and reads only skills from the HTML, so without this check a
// re-pointed detail id would silently attach the wrong card's rules text.
{
  const page = (num) => `<p class="number">カードナンバー：<span>${num}</span></p>`;
  assert.equal(cardNumberDeclaredOnPage(page('hY01-015'), 'hY01-015'), true,
    'a matching detail page is accepted');
  assert.equal(cardNumberDeclaredOnPage(page('hY01-014'), 'hY01-015'), false,
    'a page declaring a DIFFERENT cardNumber must be refused (cross-printing guard)');
  assert.equal(cardNumberDeclaredOnPage('<html>no anchor here</html>', 'hY01-015'), false,
    'a page with no card-number anchor must be refused, not trusted');
  assert.equal(cardNumberDeclaredOnPage('', 'hY01-015'), false);
  assert.equal(cardNumberDeclaredOnPage(page('hY01-015'), ''), false);
  // A prefix must not satisfy the check.
  assert.equal(cardNumberDeclaredOnPage(page('hY01-0151'), 'hY01-015'), false,
    'a longer cardNumber sharing our prefix must not satisfy the identity check');
}

// ── 3. Derivation reproduces the COMMITTED artifact ──────────────────
// The strongest available anti-fabrication evidence: run the rule over the real
// repository data and require it to reproduce entries a human already reviewed
// and committed, field for field — including the verbatim Japanese colour glyph.
{
  const committedRulesTextFree = Object.keys(effectsZh)
    .filter((num) => Object.hasOwn(effectsJp, num) && !hasRulesText(effectsJp[num]));
  assert.ok(
    committedRulesTextFree.length >= 6,
    `expected the committed precedent set to survive (got ${committedRulesTextFree.length})`,
  );
  for (const cardNumber of committedRulesTextFree) {
    const derived = deriveStructuralZh(effectsJp[cardNumber], nameZhMap);
    assert.ok(derived, `${cardNumber}: derivation must reproduce the committed entry`);
    assert.deepEqual(
      derived,
      effectsZh[cardNumber],
      `${cardNumber}: derived entry must equal the committed data/effects-zh.json entry exactly`,
    );
  }
}

// ── 4. Fail-closed refusals ──────────────────────────────────────────
const yell = { cardNumber: 'hY01-015', name: '白エール', cardType: 'エール', color: '白' };

{
  // Green baseline for the mutation layer below.
  const ok = deriveStructuralZh(yell, nameZhMap);
  assert.deepEqual(ok, { cardNumber: 'hY01-015', name: '白色應援', cardType: '應援', color: '白' },
    'a rules-text-free, fully mapped card derives from controlled maps only');

  // 4a. ANY rules text disqualifies the card — nothing may be translated.
  const rulesBearing = {
    oshiSkill: { name: 'x', effect: 'y' },
    spOshiSkill: { name: 'x', effect: 'y' },
    arts: [{ name: 'x', effect: 'y' }],
    keywords: [{ label: 'x', effect: 'y' }],
    abilityText: '自分のホロメン1人を選ぶ。',
  };
  for (const field of RULES_TEXT_FIELDS) {
    const entry = { ...yell, [field]: rulesBearing[field] };
    assert.equal(hasRulesText(entry), true, `${field} must count as rules text`);
    assert.equal(deriveStructuralZh(entry, nameZhMap), null,
      `a card carrying ${field} must stay fail-closed — rules text may never be synthesized`);
    // Mutation: the ONLY reason it was refused is that field. Remove it and the
    // same input derives — so the guard is load-bearing, not incidental.
    const { [field]: _removed, ...withoutField } = entry;
    assert.ok(deriveStructuralZh(withoutField, nameZhMap),
      `removing ${field} must re-enable derivation, proving the rules-text guard is what refused`);
  }
  // An unrecognized shape in a rules-text field is treated AS rules text.
  assert.equal(deriveStructuralZh({ ...yell, abilityText: 42 }, nameZhMap), null,
    'an unexpected rules-text shape must be treated as rules-bearing');
  // Empty/blank rules fields are not rules text.
  assert.equal(hasRulesText({ ...yell, arts: [], keywords: [], abilityText: '   ' }), false);

  // 4b. Unmapped name — no transliteration, no passthrough.
  assert.equal(deriveStructuralZh({ ...yell, name: '存在しない名前' }, nameZhMap), null,
    'a name absent from data/character-names-zh.json must stay fail-closed');
  // 4c. Unknown card type — the controlled glossary must actually know it, so a
  //     passthrough of untranslated Japanese can never reach a zh field.
  assert.equal(deriveStructuralZh({ ...yell, cardType: 'ナニカ' }, { ...nameZhMap, ナニカ: 'x' }), null,
    'a cardType the controlled glossary does not translate must stay fail-closed');
  // 4d. Missing/blank structural fields.
  for (const field of ['cardNumber', 'name', 'cardType', 'color']) {
    assert.equal(deriveStructuralZh({ ...yell, [field]: '' }, nameZhMap), null, `blank ${field} must refuse`);
    const { [field]: _dropped, ...without } = yell;
    assert.equal(deriveStructuralZh(without, nameZhMap), null, `missing ${field} must refuse`);
  }
  // 4e. DIC-1417 prototype safety — inherited members must not resolve.
  assert.equal(deriveStructuralZh({ ...yell, name: 'constructor' }, {}), null,
    'an inherited Object.prototype member must not satisfy the name lookup');
  assert.equal(deriveStructuralZh({ ...yell, name: 'toString' }, {}), null);
  // 4f. DIC-465 — a mapping whose value leaks kana must be refused.
  assert.equal(deriveStructuralZh(yell, { ...nameZhMap, '白エール': '白エール' }), null,
    'a mapped name that still contains kana must never reach a zh field');
  // 4g. Non-object inputs.
  assert.equal(deriveStructuralZh(null, nameZhMap), null);
  assert.equal(deriveStructuralZh(yell, null), null);
}

// ── 5. deriveMissingZh only fills genuine gaps ───────────────────────
{
  const jp = {
    'hY01-015': yell,
    'hY01-016': { cardNumber: 'hY01-016', name: '緑エール', cardType: 'エール', color: '緑' },
    'hBP08-090': { cardNumber: 'hBP08-090', name: 'コラボパソコン', cardType: 'サポート・アイテム', color: '無色', abilityText: '自分のホロメン1人を選ぶ。' },
  };
  const existingZh = { 'hY01-016': { cardNumber: 'hY01-016', name: 'PRE-EXISTING', cardType: '應援', color: '緑' } };
  const { additions, skipped } = deriveMissingZh(jp, existingZh, nameZhMap);
  assert.deepEqual(Object.keys(additions), ['hY01-015'], 'only the untranslated rules-text-free card is derived');
  assert.ok(skipped.includes('hBP08-090'), 'the rules-text card is reported as still fail-closed');
  assert.deepEqual(
    existingZh['hY01-016'].name,
    'PRE-EXISTING',
    'deriveMissingZh must be pure — it may never overwrite an existing translation',
  );
}

// ── 6. The exemption baseline stays retired (DIC-1167) ───────────────
// skillsZh is required per official printing with no cardNumber-level
// exemption. The DIC-1439/DIC-1451 pinned baseline file must never return —
// the completeness gate hard-fails on its presence, and this suite pins the
// same invariant at the artifact level.
{
  assert.ok(
    !fs.existsSync(path.join(repoRoot, 'data', 'official-skills-zh-gap.json')),
    'data/official-skills-zh-gap.json is retired (DIC-1167) and must not reappear',
  );
}

// ── 7. Live-data consistency with the completeness gate ──────────────
{
  // Every official cardNumber must carry a real data/effects-zh.json entry —
  // the completeness gate requires skillsZh per printing with no exemption, and
  // the database build derives skillsZh from this artifact by cardNumber.
  const untranslated = [...new Set(readOfficialRows().map((r) => r.cardNumber).filter(Boolean))]
    .filter((num) => !Object.hasOwn(effectsZh, num));
  assert.deepEqual(
    untranslated,
    [],
    `every official cardNumber must carry a data/effects-zh.json translation (DIC-1167): ${untranslated.slice(0, 10).join(', ')}`,
  );
  // Every rules-text-free JP entry must now be translated — that class has no
  // rules text to block derivation, so an untranslated one means the
  // enrichment pass was skipped or a controlled map regressed.
  const underived = Object.keys(effectsJp)
    .filter((num) => !hasRulesText(effectsJp[num]) && !Object.hasOwn(effectsZh, num));
  assert.deepEqual(
    underived,
    [],
    `rules-text-free cardNumbers must all carry derived Traditional-Chinese text: ${underived.join(', ')}`,
  );
}

// ── 8. The acquisition gap itself stays closed ───────────────────────
// This is the incident invariant, asserted against the SHIPPED artifacts: no
// official printing may exist without a data/effects-jp.json entry. The
// completeness gate only inspects built databases, so without this an effects
// entry could be dropped and nothing would notice until the next sync rebuilt
// the database and failed — which is precisely how run 35276519463 failed.
{
  const unacquired = missingEffectsCardNumbers(readOfficialRows(), effectsJp);
  assert.deepEqual(
    unacquired.map((c) => c.cardNumber),
    [],
    `every official cardNumber must carry source-backed Japanese skill text; unacquired: ${unacquired.map((c) => c.cardNumber).join(', ')}`,
  );
}

console.log('✓ DIC-1468: new official printings acquire source-backed skillsJp with page-identity provenance, rules-text-free printings derive Traditional-Chinese text from controlled maps only (reproducing the committed artifact), every other card stays fail-closed, every official cardNumber carries a data/effects-zh.json translation, and the retired skillsZh exemption baseline stays deleted (DIC-1167)');
