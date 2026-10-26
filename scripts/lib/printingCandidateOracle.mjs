// Shared TEST oracle (no production imports): which raw catalog rows of one card
// number must surface as ONE scan candidate.
//
// A raw row is not always its own physical printing: since 2026-10-19 an `ent07`
// aggregation row that carries NO shop listing and NO price folds into the one
// product row it is evidently the same card as (same official art, compatible
// rarity / condition, same language). It adds no quote, so it can never move a
// price; it only stops one printing being offered twice. A row matching two or
// more product rows joins none. Everything else stays its own candidate.
//
// The rule is re-stated here from raw catalog fields, NOT from the implementation,
// so scan tests can require: every raw id survives exactly once (primary or
// alias), only unlisted unpriced aliases fold, each candidate keeps its own row's
// price, and no candidate joins rows of different art / rarity / product source.

export const AGGREGATE = 'ent07';
export const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
export const rawArt = (r) => str(r.officialImage) ?? str(r.localImage);
export const rawListing = (r) => str(r.yuyuImage) ?? str(r.listing);
export const hasQuote = (r) => (typeof r.sellPrice === 'number' && r.sellPrice > 0)
  || (typeof r.buyPrice === 'number' && r.buyPrice > 0);
const knownDiffer = (a, b) => !!str(a) && !!str(b) && str(a) !== str(b);
const ownPrice = (r) => (r && typeof r.sellPrice === 'number' && r.sellPrice > 0 ? r.sellPrice : null);

export const isUnlistedUnpricedAlias = (r) =>
  r.sourceProduct === AGGREGATE && !rawListing(r) && !hasQuote(r) && !!rawArt(r);

/** primary row id → member row ids, for the given raw rows (one card number). */
export function expectedGroups(raw) {
  const partnerOf = new Map();
  for (const alias of raw) {
    if (!isUnlistedUnpricedAlias(alias)) continue;
    const partners = raw.filter((r) => r.sourceProduct !== AGGREGATE
      && rawArt(r) === rawArt(alias)
      && !knownDiffer(r.rarity, alias.rarity)
      && !knownDiffer(r.condition, alias.condition)
      && (str(r.language) ?? null) === (str(alias.language) ?? null));
    if (partners.length === 1) partnerOf.set(alias.id, partners[0].id); // ambiguous → stays separate
  }
  const groups = new Map();
  for (const r of raw) {
    const primary = partnerOf.get(r.id) ?? r.id;
    groups.set(primary, [...(groups.get(primary) ?? []), r.id]);
  }
  return groups;
}

export const describeGroups = (groups) =>
  [...groups].map(([p, m]) => (m.length > 1 ? `${p} ⊇ ${m.filter((x) => x !== p).join('+')}` : p));

/** Every folded member is an unlisted unpriced alias whose primary is a product row. */
export function foldsAreProvenAliases(groups, rawRows) {
  const byId = new Map(rawRows.map((r) => [r.id, r]));
  return [...groups].every(([p, members]) => members.every((id) => id === p
    || (isUnlistedUnpricedAlias(byId.get(id)) && byId.get(p).sourceProduct !== AGGREGATE)));
}

/**
 * Compare candidate cards (`[{ card }]` or CardInfo-shaped `card`s) against the
 * groups derived from `rawRows` (the rows the candidates were drawn from).
 */
export function compareCandidates(candidates, rawRows) {
  const expected = expectedGroups(rawRows);
  const byId = new Map(rawRows.map((r) => [r.id, r]));
  const cards = (candidates ?? []).map((c) => (c && c.card ? c.card : c));
  const seen = [];
  const mismatched = [];
  for (const card of cards) {
    const members = [...(card?.aliasIds ?? [card?.id])].sort();
    seen.push(...members);
    const want = expected.get(card?.id);
    if (!want || JSON.stringify([...want].sort()) !== JSON.stringify(members)) {
      mismatched.push({ id: card?.id, members, want });
    }
    // a folded alias contributes no quote: the version's price is its own row's
    if (want && (card.sellPrice ?? null) !== ownPrice(byId.get(card.id))) {
      mismatched.push({ id: card.id, price: card.sellPrice, ownPrice: ownPrice(byId.get(card.id)) });
    }
  }
  const unmixed = cards.every((card) => {
    const members = (card?.aliasIds ?? [card?.id]).map((id) => byId.get(id));
    if (members.some((m) => !m)) return false;
    return new Set(members.map(rawArt)).size === 1
      && new Set(members.map((m) => str(m.rarity)).filter(Boolean)).size <= 1
      && members.filter((m) => m.sourceProduct !== AGGREGATE).length <= 1;
  });
  return {
    expected,
    count: cards.length,
    countOk: cards.length === expected.size,
    everyRawOnce: JSON.stringify([...seen].sort()) === JSON.stringify(rawRows.map((r) => r.id).sort()),
    seen: [...seen].sort(),
    mismatched,
    unmixed,
  };
}
