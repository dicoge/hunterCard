/**
 * What the Scan screen shows for a recognition result (scan best-match fix 2026-10-15,
 * Pen `docs/pen-scan/holohunter-scan-best-match.pen` states B / C / D).
 *
 *   best      — one printing proven by the photo: shown as a PREVIEW. Nothing is added
 *               or charged until the user taps 加入; 「不是這張？更正」 is secondary.
 *   identity  — the card is known but not its printing: shown without a price; picking
 *               a printing is the primary action.
 *   none      — no valid answer: an explicit failure (never filler). Evidence-backed
 *               alternatives, if any, are offered only as a secondary option.
 *
 * Commit (and the quota charge) happens only from an explicit user action on one of
 * these, so a correction can never add or charge twice. Dependency-free type-only
 * imports so the Node regressions drive this exact decision.
 */
import type { CardInfo, RecognitionResult, RecognizedCandidate } from './cardRecognition';

/**
 * Which rule produced a presentation — logged separately from the server verdict so a
 * legacy-backend result is never mistaken for a v39 verdict (or for "unknown").
 *   server_verdict      the backend's `match`
 *   legacy_evidence     no verdict; per-candidate ranker evidence from an older backend
 *   legacy_no_evidence  no verdict and no evidence (older backend list / local OCR list)
 *   local_ocr           on-device / browser text recognition decision
 */
export type PresentationSource = 'server_verdict' | 'legacy_evidence' | 'legacy_no_evidence' | 'local_ocr';

export type ScanPresentation = (
  | { kind: 'best'; card: CardInfo; evidence: string[]; alternatives: RecognizedCandidate[] }
  | { kind: 'identity'; card: CardInfo; printings: RecognizedCandidate[] }
  | { kind: 'none'; reason: NoneReason; suggestions: RecognizedCandidate[] }
) & { source?: PresentationSource };

export type NoneReason = 'no_evidence' | 'no_card_number' | 'number_not_in_database' | 'number_name_conflict' | 'low_evidence';

/** Evidence token from local (on-device / browser) text recognition. */
export const LOCAL_OCR_EVIDENCE = 'local OCR cardNumber';

/** An identified card whose printing is unresolved must not carry any printing's price. */
export function withoutPrintingPrice(card: CardInfo): CardInfo {
  return { ...card, sellPrice: null, buyPrice: null, prices: [], priceHistory: undefined };
}

function sameCardNumber(cands: RecognizedCandidate[]): boolean {
  const numbers = new Set(cands.map((c) => String(c.card.cardNumber || '').toLowerCase()));
  return cands.length > 0 && numbers.size === 1 && !numbers.has('');
}

/**
 * Candidates offered with no verdict — a backend that predates `match` (v37 production
 * answers every multi-printing card as lowConfidence + top-5) or local OCR.
 *
 * Scan regression 2026-10-16: with a v37 backend, a card whose number has 2–4 printings
 * comes back as its printings PLUS same-character filler of other numbers. Treating that
 * mixed list as "no match" turned a correctly read card into 證據不足 (offline: 875 of
 * 1,387 numbers with a perfect reading). When the backend sent per-candidate evidence,
 * the same rules the v38 server uses apply here: only candidates whose card number was
 * read EXACTLY count, filler is dropped; one such printing with a corroborating name
 * (or one singled out by the rarity read) is a best-match preview, several are an
 * identity without price. Nothing is committed or charged — the user still taps 加入 /
 * picks the printing. Without exact-number evidence it stays an explicit no-match.
 */
export function presentCandidates(cands: RecognizedCandidate[]): ScanPresentation {
  const p = presentCandidatesInner(cands);
  return { ...p, source: cands.some((c) => c.evidence) ? 'legacy_evidence' : 'legacy_no_evidence' };
}

function presentCandidatesInner(cands: RecognizedCandidate[]): ScanPresentation {
  const list = cands.slice(0, 8);
  const exact = list.filter((c) => c.evidence?.includes('cardNumber exact'));
  const lead = exact[0];
  if (lead) {
    const leadNumber = String(lead.card.cardNumber || '').toLowerCase();
    const printings = exact.filter((c) => String(c.card.cardNumber || '').toLowerCase() === leadNumber);
    const named = (c: RecognizedCandidate) => !!c.evidence?.some((e) => e.startsWith('character') || e.startsWith('title'));
    const best = (c: RecognizedCandidate): ScanPresentation => ({
      kind: 'best', card: c.card, evidence: c.evidence ?? [], alternatives: printings.filter((p) => p !== c),
    });
    // The read name matched OTHER numbers but none of these printings: the number was
    // misread (v38 server: number_name_conflict). No identity, no price — explicit no-match.
    if (!printings.some(named) && list.some((c) => !printings.includes(c) && named(c))) {
      return { kind: 'none', reason: 'number_name_conflict', suggestions: list.slice(0, 5) };
    }
    if (printings.length === 1 && named(lead)) return best(lead);
    const byRarity = printings.filter((c) => c.evidence?.includes('rarity'));
    if (byRarity.length === 1 && named(byRarity[0])) return best(byRarity[0]);
    return { kind: 'identity', card: withoutPrintingPrice(lead.card), printings };
  }
  if (sameCardNumber(list) && list.every((c) => !c.evidence)) {
    return { kind: 'identity', card: withoutPrintingPrice(list[0].card), printings: list };
  }
  return { kind: 'none', reason: 'low_evidence', suggestions: list.slice(0, 5) };
}

/**
 * A result that carries the backend's explicit verdict. Returns null when there is no
 * verdict (older backend or local OCR) — the caller then uses the legacy routes below.
 */
export function presentMatch(result: Pick<RecognitionResult, 'match' | 'card' | 'candidates'>): ScanPresentation | null {
  const p = presentMatchInner(result);
  return p ? { ...p, source: 'server_verdict' } : null;
}

function presentMatchInner(result: Pick<RecognitionResult, 'match' | 'card' | 'candidates'>): ScanPresentation | null {
  const m = result.match;
  if (!m) return null;
  if (m.status === 'matched' && result.card) {
    const alternatives = (m.alternatives.length ? m.alternatives : (result.candidates ?? []))
      .filter((c) => c.card.id !== result.card!.id);
    return { kind: 'best', card: result.card, evidence: m.evidence, alternatives };
  }
  if (m.status === 'identity_only') {
    const printings = m.alternatives.length ? m.alternatives : (result.candidates ?? []);
    const identity = result.card ?? printings[0]?.card;
    if (!identity || printings.length === 0) return { kind: 'none', reason: 'low_evidence', suggestions: [] };
    return { kind: 'identity', card: withoutPrintingPrice(identity), printings };
  }
  return { kind: 'none', reason: (m.reason ?? 'no_evidence') as NoneReason, suggestions: m.alternatives.slice(0, 5) };
}

/** The decision ScanScreen.handleRecognized used to turn straight into a commit. */
export function presentLegacyDecision(
  decision:
    | { action: 'ambiguous-picker'; candidates: RecognizedCandidate[] }
    | { action: 'commit'; card: CardInfo; confidence: number }
    | { action: 'picker'; tier: 'mid' | 'low'; candidates: RecognizedCandidate[] },
  evidence: string[] = [LOCAL_OCR_EVIDENCE],
  candidates: RecognizedCandidate[] = [],
): ScanPresentation {
  if (decision.action === 'commit') {
    // A backend-accepted card carries its own ranker evidence; only a local OCR read
    // is labelled as such.
    const own = candidates.find((c) => c.card.id === decision.card.id && c.evidence?.length);
    return own
      ? { kind: 'best', card: decision.card, evidence: own.evidence!, alternatives: [], source: 'legacy_evidence' }
      : { kind: 'best', card: decision.card, evidence, alternatives: [], source: 'local_ocr' };
  }
  if (decision.action === 'ambiguous-picker') {
    return { kind: 'identity', card: withoutPrintingPrice(decision.candidates[0].card), printings: decision.candidates, source: 'local_ocr' };
  }
  // Scan regression 2026-10-16: an older backend's accepted card below the client's
  // 0.85 auto-add bar (v37 accepts at 0.82) arrives here with per-candidate evidence.
  // Judge it by that evidence (same rules as presentCandidates) instead of declaring a
  // no-match; a list without evidence (local OCR name match) stays a no-match.
  if (decision.candidates.some((c) => c.evidence)) return presentCandidates(decision.candidates);
  return { kind: 'none', reason: 'low_evidence', suggestions: decision.candidates.slice(0, 5), source: 'local_ocr' };
}

/** The backend's `match` object as it travels on the wire → ScanMatch (or undefined). */
export function matchFromWire(
  raw: any,
  mapCandidates: (raw: any) => RecognizedCandidate[] | undefined,
): RecognitionResult['match'] {
  if (!raw || !['matched', 'identity_only', 'no_match'].includes(raw.status)) return undefined;
  return {
    status: raw.status,
    printingResolved: raw.printingResolved === true,
    reason: raw.reason ?? null,
    evidence: Array.isArray(raw.evidence) ? raw.evidence.filter((e: unknown) => typeof e === 'string') : [],
    alternatives: mapCandidates(raw.alternatives) ?? [],
    ruleScore: typeof raw.ruleScore === 'number' ? raw.ruleScore : null,
  };
}
