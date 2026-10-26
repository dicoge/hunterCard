/**
 * Typed recognition trace (scan observability, 2026-10-16).
 *
 * The four user diagnostic exports from v38 could not say WHY a scan failed: every
 * number was `unknown` (missing? NONE? unparseable?), two names were `[redacted]` by an
 * over-strict name rule, and the old server's lack of a verdict showed up as
 * `status: unknown`. This module gives one shared vocabulary:
 *
 *   field state — parsed | missing (line absent) | empty (line blank) |
 *                 provider_unknown (NONE / UNKNOWN / N/A / -) | parse_error (number
 *                 present but not a whole card-number token) | redacted (present but
 *                 unsafe to keep) | not_provided (an older server sent nothing)
 *   provenance  — server_trace (this module, v39+ server) | legacy_debug (older
 *                 server's debug block) | none
 *
 * The server builds the trace ONLY from the expected `FIELD:` lines of the model reply,
 * value by value through safeCardText — never the raw reply. Dependency-free: imported
 * by api/recognize-card and the app.
 */
import { parseCardNumberToken } from '../utils/cardNumberToken';

export const TRACE_SCHEMA = 'scan-trace/1';
export type FieldState = 'parsed' | 'missing' | 'empty' | 'provider_unknown' | 'parse_error' | 'redacted' | 'not_provided';
export type Provenance = 'server_trace' | 'legacy_debug' | 'none';
export type TraceField = 'name' | 'title' | 'number' | 'set' | 'language' | 'rarity';
/**
 * `received`: the field as the reply line gave it, kept only when it is safe expected-field
 * text (receivedCardText) — e.g. `hBP01-0100` or `hBP0l-O1O` — so normalisation can be
 * diagnosed. `value`: the parsed / normalised value (number → canonical token).
 */
export interface FieldTrace { state: FieldState; received?: string; value?: string }

const LINE_FOR: Record<TraceField, string> = {
  name: 'CHARACTER', title: 'TITLE', number: 'CARD_NUMBER', set: 'SET', language: 'LANGUAGE', rarity: 'RARITY',
};
export const TRACE_FIELDS = Object.keys(LINE_FOR) as TraceField[];
export const MAX_TEXT = 48;
export const MAX_TOP = 5;

const UNKNOWN_WORD = /^(none|unknown|n\/a|na|null|-+|\?+)$/i;
// Card / character names: the scripts cards are printed in, digits, spaces and the
// punctuation that real names and titles use. NOT: @ / \ : = < > { } [ ] | ; ` " % $ #,
// which emails, urls, tokens and markup need.
const NAME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}A-Za-zÀ-ɏ0-9 ・·ー'’.,，、&!?！？()（）「」『』〜~☆★♪+＋-]+$/u;
const SET = /^[A-Za-z]{1,4}[0-9]{0,3}$/;
const LANGUAGE = /^[A-Za-z]{2,3}$/;
const RARITY = /^[A-Za-z0-9_+]{1,8}$/;
// Shapes that are never card text even when every character is allowed.
const SECRETISH = [/AIza[0-9A-Za-z_-]{10,}/, /\beyJ[0-9A-Za-z_-]{6,}/, /\bya29\./, /\bsk-[0-9A-Za-z]{6,}/, /[A-Za-z0-9+]{28,}/];

/** A value safe to store for `field`, or null when it must be redacted. */
export function safeCardText(field: TraceField, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!v || v.length > MAX_TEXT) return null;
  if (SECRETISH.some((re) => re.test(v))) return null;
  switch (field) {
    case 'name':
    case 'title': return NAME.test(v) ? v : null;
    case 'set': return SET.test(v) ? v : null;
    case 'language': return LANGUAGE.test(v) ? v.toUpperCase() : null;
    case 'rarity': return RARITY.test(v) ? v.toUpperCase() : null;
    case 'number': return parseCardNumberToken(v);
    default: return null;
  }
}

/** The reply labels the scanner asks for. Only these lines are ever read. */
export const EXPECTED_LABELS = ['CHARACTER', 'HP', 'RARITY', 'BLOOM_LEVEL', 'CARD_NUMBER', 'TITLE', 'SET', 'LANGUAGE'] as const;
export type ExpectedLabel = typeof EXPECTED_LABELS[number];
const MAX_LINE = 200;

/**
 * THE reader for one expected reply line, shared by the ranking (api/recognize-card
 * parseField) and the trace, so they can never disagree (CR 2026-10-16 #3). Accepts
 * leading/trailing horizontal whitespace around an exact label and the colon; the label
 * must be one of EXPECTED_LABELS (exact word, case-insensitive as before; no fuzzy
 * labels). First matching line wins.
 * Returns null when the line is absent, else the trimmed value (bounded).
 */
export function readExpectedField(reply: string, label: ExpectedLabel): string | null {
  if (typeof reply !== 'string' || !(EXPECTED_LABELS as readonly string[]).includes(label)) return null;
  const m = reply.match(new RegExp(`^[ \\t]*${label}[ \\t]*:[ \\t]*(.*?)[ \\t]*$`, 'mi'));
  return m ? m[1].slice(0, MAX_LINE).trim() : null;
}

/** True for NONE / UNKNOWN / N/A / - … (the model saying it could not read the field). */
export function isUnknownWord(value: string): boolean {
  return UNKNOWN_WORD.test(value.trim());
}

// Received (pre-normalisation) number / codes: card-number-ish characters only.
const RECEIVED_CODE = /^[A-Za-z0-9〇｜|\-‐‑‒–—―− _.]{1,24}$/;

/**
 * The received value of an expected field, if it is safe to keep as-is for diagnosis:
 * names / titles by the name rule; number / set / language / rarity only as short
 * card-code characters. Keys, tokens, emails, urls, markup, base64-like runs → null.
 */
export function receivedCardText(field: TraceField, raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const v = raw.normalize('NFKC').replace(/\s+/g, ' ').trim();
  if (!v || v.length > MAX_TEXT || SECRETISH.some((re) => re.test(v))) return null;
  if (field === 'name' || field === 'title') return NAME.test(v) ? v : null;
  return RECEIVED_CODE.test(v) ? v : null;
}

/** One field from the model reply: its line → a typed state, never the raw line. */
export function traceReplyField(reply: string, field: TraceField): FieldTrace {
  const raw = readExpectedField(reply, LINE_FOR[field] as ExpectedLabel);
  if (raw === null) return { state: 'missing' };
  if (!raw) return { state: 'empty' };
  if (isUnknownWord(raw)) return { state: 'provider_unknown' };
  const received = receivedCardText(field, raw) ?? undefined;
  const value = safeCardText(field, raw);
  if (value !== null) return { state: 'parsed', ...(received ? { received } : {}), value };
  // A number that is safe text but not a whole card-number token: keep what was
  // received, give no value (nothing downstream may treat it as a number).
  if (field === 'number' && received) return { state: 'parse_error', received };
  return { state: 'redacted' };
}

/** name: the catalog card name (public catalog text, safe-text checked) — so a log can say
 *  which card a read number actually belongs to. */
export interface TraceCandidate { id: string; score: number | null; evidence: string[]; name?: string }
export interface RecognitionTrace {
  schema: typeof TRACE_SCHEMA;
  requestId: string | null;
  backendSha: string | null;
  model: string | null;
  replySchema: 'ok' | 'schema_mismatch';
  fields: Record<TraceField, FieldTrace>;
  candidateCount: number;
  top: TraceCandidate[];
  verdict: { status: 'matched' | 'identity_only' | 'no_match'; reason: string | null };
  rejection: 'no_candidate' | 'evidence_rejected' | 'printing_unresolved' | null;
}

const EVIDENCE = new Set(['cardNumber exact', 'cardNumber fuzzy-1', 'cardNumber fuzzy-2', 'character exact/contains', 'character fuzzy', 'title exact/contains', 'title fuzzy', 'rarity', 'hp', 'bloom/type']);
const CATALOG_ID = /^h[a-z]{1,2}\d{0,2}-\d{3}(_[a-z0-9-]{1,16}){0,8}$/i;
const SHA = /^[0-9a-f]{40}$/;
const REQUEST_ID = /^[0-9a-f]{16,32}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{1,47}$/;
const STATUS = new Set(['matched', 'identity_only', 'no_match']);
const REASONS = new Set(['no_evidence', 'no_card_number', 'number_not_in_database', 'number_name_conflict']);
const REJECTIONS = new Set(['no_candidate', 'evidence_rejected', 'printing_unresolved']);
const STATES = new Set<FieldState>(['parsed', 'missing', 'empty', 'provider_unknown', 'parse_error', 'redacted', 'not_provided']);

/** Attaches a catalog name only when it passes the card-name safe-text rule. */
export function withName(c: TraceCandidate, name: unknown): TraceCandidate {
  const safe = typeof name === 'string' ? safeCardText('name', name) : null;
  return safe ? { ...c, name: safe } : c;
}

export function evidenceTokens(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim()).filter((t) => EVIDENCE.has(t)))].slice(0, 8);
}

/** Server side: build the trace from the reply lines, the ranking and the verdict. */
export function buildRecognitionTrace(input: {
  reply: string; requestId: string | null; backendSha: unknown; model: string;
  candidates: Array<{ id?: unknown; score?: unknown; reason?: unknown; name?: unknown }>; candidateCount: number;
  verdict: { status: string; reason?: string | null };
}): RecognitionTrace {
  const fields = {} as Record<TraceField, FieldTrace>;
  for (const f of TRACE_FIELDS) fields[f] = traceReplyField(input.reply, f);
  const anyLine = TRACE_FIELDS.some((f) => fields[f].state !== 'missing');
  const status = input.verdict.status as RecognitionTrace['verdict']['status'];
  return {
    schema: TRACE_SCHEMA,
    requestId: input.requestId && REQUEST_ID.test(input.requestId) ? input.requestId : null,
    backendSha: typeof input.backendSha === 'string' && SHA.test(input.backendSha) ? input.backendSha : null,
    model: MODEL.test(input.model) ? input.model : null,
    replySchema: anyLine ? 'ok' : 'schema_mismatch',
    fields,
    candidateCount: Math.max(0, Math.min(9999, Math.floor(input.candidateCount))),
    top: input.candidates.slice(0, MAX_TOP).map((c) => withName({
      id: typeof c.id === 'string' && CATALOG_ID.test(c.id) ? c.id : '[redacted]',
      score: typeof c.score === 'number' && Number.isFinite(c.score) ? Math.round(c.score * 10) / 10 : null,
      evidence: evidenceTokens(c.reason),
    }, c.name)),
    verdict: { status, reason: input.verdict.reason ?? null },
    rejection: status === 'matched' ? null
      : status === 'identity_only' ? 'printing_unresolved'
        : input.candidateCount === 0 ? 'no_candidate' : 'evidence_rejected',
  };
}

/** Re-validates one field (wire / storage / export): state, received, value. */
export function sanitizeFieldTrace(f: TraceField, x: any): FieldTrace {
  const state: FieldState = STATES.has(x?.state) ? x.state : 'not_provided';
  const received = x?.received === undefined ? undefined : receivedCardText(f, x.received) ?? undefined;
  const withReceived = (o: FieldTrace): FieldTrace => (received ? { ...o, received } : o);
  if (state === 'parsed') {
    const value = safeCardText(f, x?.value);
    return value === null ? { state: 'redacted' } : withReceived({ state, value });
  }
  if (state === 'parse_error') return withReceived({ state });
  return { state };
}

/**
 * Client side: re-validate a trace received over the wire. Anything that does not fit
 * the schema exactly is dropped or redacted; an unrecognisable trace → undefined.
 */
export function projectTrace(raw: any): RecognitionTrace | undefined {
  if (!raw || typeof raw !== 'object' || raw.schema !== TRACE_SCHEMA) return undefined;
  if (!STATUS.has(raw.verdict?.status)) return undefined;
  const fields = {} as Record<TraceField, FieldTrace>;
  for (const f of TRACE_FIELDS) {
    const x = raw.fields?.[f];
    fields[f] = sanitizeFieldTrace(f, x);
  }
  return {
    schema: TRACE_SCHEMA,
    requestId: typeof raw.requestId === 'string' && REQUEST_ID.test(raw.requestId) ? raw.requestId : null,
    backendSha: typeof raw.backendSha === 'string' && SHA.test(raw.backendSha) ? raw.backendSha : null,
    model: typeof raw.model === 'string' && MODEL.test(raw.model) ? raw.model : null,
    replySchema: raw.replySchema === 'schema_mismatch' ? 'schema_mismatch' : 'ok',
    fields,
    candidateCount: typeof raw.candidateCount === 'number' && Number.isFinite(raw.candidateCount) ? Math.max(0, Math.min(9999, Math.floor(raw.candidateCount))) : 0,
    top: (Array.isArray(raw.top) ? raw.top : []).slice(0, MAX_TOP).map((c: any) => withName({
      id: typeof c?.id === 'string' && CATALOG_ID.test(c.id) ? c.id : '[redacted]',
      score: typeof c?.score === 'number' && Number.isFinite(c.score) ? Math.round(c.score * 10) / 10 : null,
      evidence: evidenceTokens(c?.evidence),
    }, c?.name)),
    verdict: { status: raw.verdict.status, reason: REASONS.has(raw.verdict.reason) ? raw.verdict.reason : null },
    rejection: REJECTIONS.has(raw.rejection) ? raw.rejection : null,
  };
}
