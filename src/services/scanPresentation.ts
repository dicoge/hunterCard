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

export type ScanPresentation =
  | { kind: 'best'; card: CardInfo; evidence: string[]; alternatives: RecognizedCandidate[] }
  | { kind: 'identity'; card: CardInfo; printings: RecognizedCandidate[] }
  | { kind: 'none'; reason: NoneReason; suggestions: RecognizedCandidate[] };

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

/** Candidates the backend / OCR offered with no verdict: same number → identity, else none. */
export function presentCandidates(cands: RecognizedCandidate[]): ScanPresentation {
  const list = cands.slice(0, 8);
  if (sameCardNumber(list)) {
    return { kind: 'identity', card: withoutPrintingPrice(list[0].card), printings: list };
  }
  return { kind: 'none', reason: 'low_evidence', suggestions: list.slice(0, 5) };
}

/**
 * A result that carries the backend's explicit verdict. Returns null when there is no
 * verdict (older backend or local OCR) — the caller then uses the legacy routes below.
 */
export function presentMatch(result: Pick<RecognitionResult, 'match' | 'card' | 'candidates'>): ScanPresentation | null {
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
): ScanPresentation {
  if (decision.action === 'commit') return { kind: 'best', card: decision.card, evidence, alternatives: [] };
  if (decision.action === 'ambiguous-picker') {
    return { kind: 'identity', card: withoutPrintingPrice(decision.candidates[0].card), printings: decision.candidates };
  }
  return { kind: 'none', reason: 'low_evidence', suggestions: decision.candidates.slice(0, 5) };
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
