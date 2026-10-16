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
export interface FieldTrace { state: FieldState; value?: string }

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

/** One field from the model reply: its line → a typed state, never the raw line. */
export function traceReplyField(reply: string, field: TraceField): FieldTrace {
  const m = reply.match(new RegExp(`^\\s*${LINE_FOR[field]}\\s*:(.*)$`, 'im'));
  if (!m) return { state: 'missing' };
  const raw = m[1].trim();
  if (!raw) return { state: 'empty' };
  if (UNKNOWN_WORD.test(raw)) return { state: 'provider_unknown' };
  const value = safeCardText(field, raw);
  if (value !== null) return { state: 'parsed', value };
  return { state: field === 'number' && raw.length <= MAX_TEXT && /^[\x20-\x7e]+$/.test(raw) && !SECRETISH.some((re) => re.test(raw)) ? 'parse_error' : 'redacted' };
}

export interface TraceCandidate { id: string; score: number | null; evidence: string[] }
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

export function evidenceTokens(raw: unknown): string[] {
  const list = Array.isArray(raw) ? raw : typeof raw === 'string' ? raw.split(',') : [];
  return [...new Set(list.map((t) => String(t).trim()).filter((t) => EVIDENCE.has(t)))].slice(0, 8);
}

/** Server side: build the trace from the reply lines, the ranking and the verdict. */
export function buildRecognitionTrace(input: {
  reply: string; requestId: string | null; backendSha: unknown; model: string;
  candidates: Array<{ id?: unknown; score?: unknown; reason?: unknown }>; candidateCount: number;
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
    top: input.candidates.slice(0, MAX_TOP).map((c) => ({
      id: typeof c.id === 'string' && CATALOG_ID.test(c.id) ? c.id : '[redacted]',
      score: typeof c.score === 'number' && Number.isFinite(c.score) ? Math.round(c.score * 10) / 10 : null,
      evidence: evidenceTokens(c.reason),
    })),
    verdict: { status, reason: input.verdict.reason ?? null },
    rejection: status === 'matched' ? null
      : status === 'identity_only' ? 'printing_unresolved'
        : input.candidateCount === 0 ? 'no_candidate' : 'evidence_rejected',
  };
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
    const state: FieldState = STATES.has(x?.state) ? x.state : 'not_provided';
    if (state === 'parsed') {
      const value = safeCardText(f, x?.value);
      fields[f] = value === null ? { state: 'redacted' } : { state, value };
    } else fields[f] = { state };
  }
  return {
    schema: TRACE_SCHEMA,
    requestId: typeof raw.requestId === 'string' && REQUEST_ID.test(raw.requestId) ? raw.requestId : null,
    backendSha: typeof raw.backendSha === 'string' && SHA.test(raw.backendSha) ? raw.backendSha : null,
    model: typeof raw.model === 'string' && MODEL.test(raw.model) ? raw.model : null,
    replySchema: raw.replySchema === 'schema_mismatch' ? 'schema_mismatch' : 'ok',
    fields,
    candidateCount: typeof raw.candidateCount === 'number' && Number.isFinite(raw.candidateCount) ? Math.max(0, Math.min(9999, Math.floor(raw.candidateCount))) : 0,
    top: (Array.isArray(raw.top) ? raw.top : []).slice(0, MAX_TOP).map((c: any) => ({
      id: typeof c?.id === 'string' && CATALOG_ID.test(c.id) ? c.id : '[redacted]',
      score: typeof c?.score === 'number' && Number.isFinite(c.score) ? Math.round(c.score * 10) / 10 : null,
      evidence: evidenceTokens(c?.evidence),
    })),
    verdict: { status: raw.verdict.status, reason: REASONS.has(raw.verdict.reason) ? raw.verdict.reason : null },
    rejection: REJECTIONS.has(raw.rejection) ? raw.rejection : null,
  };
}
