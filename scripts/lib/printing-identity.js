// DIC-1321 (Mac-Codex CR DIC-1326): the SOLE production printing-identity
// builder. `sync-official-catalog-to-database.mjs` (the official-sync writer)
// and `scripts/audit-lost-priced-cardnumbers.mjs` (the fresh-source audit) MUST
// both derive card ids from a source listing with exactly this function. A
// simplified `cardNumber_sourceProduct` id omits the rarity + official-image
// suffix that distinguishes sibling OSR/OUR/SEC/promo printings, which falsely
// classifies unrelated printings as exact matches of a legacy aggregate row.
//
//   printingId({cardNumber, sourceProduct, rarity, imageUrl, id}) ->
//     `<cardNumber>_<sourceProduct>_<rarity>_<imageSuffix|id>`
// e.g. hBP01-081 RR@hEB01 (/hEB01/hBP01-081_RR_02.png) =>
//      `hBP01-081_hEB01_RR_hBP01-081_RR_02` (matches production).

export function imageSuffix(url = '') {
  return String(url).match(/\/([^/]+)\.png$/i)?.[1] || '';
}

export function printingId(card) {
  const cardNumber = card.cardNumber || imageSuffix(card.imageUrl).match(/^(h[A-Za-z0-9]+-\d{3})/)?.[1] || '';
  const sourceProduct = card.sourceProduct || card.expansion || card.series || '';
  return [cardNumber, sourceProduct, card.rarity || '', imageSuffix(card.imageUrl) || card.id || '']
    .filter(Boolean)
    .join('_');
}
