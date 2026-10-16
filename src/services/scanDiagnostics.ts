/**
 * Local scan / sign-in diagnostic log (owner request 2026-10-15: compare scans and
 * report real Android errors). Pure and dependency-free so the Node regressions drive
 * the exact sanitiser that runs in the app.
 *
 * Privacy contract — enforced on WRITE and again on EXPORT (old or tampered storage is
 * re-sanitised, never trusted):
 *   • stays on the device (platform storage); nothing is sent anywhere. Export is a
 *     user-initiated share / download of the JSON text.
 *   • allowlisted fields only. No photo, base64, local file uri, token, key, email,
 *     OAuth code / nonce, account id, provider payload or free-form error text.
 *   • every string is checked against a strict pattern; anything else becomes
 *     'unknown' (not read) or '[redacted]' (read but not safe to keep).
 *   • bounded: at most MAX_ENTRIES entries and MAX_AGE_MS old.
 *   • `ruleScore` is the deterministic ranking score, NOT an accuracy or probability.
 */

import {
  TRACE_FIELDS, TRACE_SCHEMA, evidenceTokens, projectTrace, receivedCardText, safeCardText, sanitizeFieldTrace, withName,
  type FieldTrace, type Provenance, type TraceField,
} from './scanTrace';

/** 2 (2026-10-16): typed trace, presentation, timeline. v1 entries are still read. */
export const DIAGNOSTICS_SCHEMA = 2;
export const MAX_ENTRIES = 100;
export const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const UNKNOWN = 'unknown';
export const REDACTED = '[redacted]';

export type DiagKind = 'scan' | 'auth';
export type ScanSource = 'camera' | 'gallery';
export type ScanOutcome = 'pending' | 'added' | 'corrected' | 'discarded' | 'cancelled' | 'failed' | 'no_match';
export type StageName = 'capture' | 'prepare' | 'request' | 'fallback' | 'total';

export interface DiagEntry {
  v: number;
  id: string;
  kind: DiagKind;
  at: string;
  platform: string;
  appVersion: string;
  nativeBuild: string;
  model: string;
  source?: ScanSource;
  stagesMs: Partial<Record<StageName, number>>;
  extracted?: { name: string; number: string; set: string; language: string };
  match?: { status: string; reason: string; ruleScore: number | null; evidence: string[] };
  errors: string[];
  outcome?: ScanOutcome;
  correctedTo?: string;
  auth?: { stage: string; code: string };
  /** What the server read and decided, field by field, with where it came from. */
  trace?: DiagTrace;
  /** What the app showed, and by which rule — separate from the server verdict. */
  presentation?: { kind: 'best' | 'identity' | 'none'; reason: string; source: string };
  /** Bounded event sequence of this scan (ms since start). */
  timeline?: Array<{ e: TimelineEvent; t: number }>;
}

export type TimelineEvent = 'presented' | 'added' | 'corrected' | 'discarded' | 'cancelled' | 'failed' | 'no_match';
export interface DiagTrace {
  provenance: Provenance;
  traceSchema: string | null;
  requestId: string | null;
  backendSha: string | null;
  replySchema: 'ok' | 'schema_mismatch' | 'not_provided';
  fields: Record<TraceField, FieldTrace>;
  candidateCount: number | null;
  top: Array<{ id: string; score: number | null; evidence: string[]; name?: string }>;
  serverVerdict: { status: string; reason: string | null };
  rejection: string | null;
}
export const MAX_TIMELINE = 12;

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const ID = /^[a-z0-9]{8,32}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{1,47}$/;
const CARD_NUMBER = /^h[a-z]{1,2}(\d{2})?-\d{3}$/;
const CATALOG_ID = /^h[a-z]{1,2}\d{0,2}-\d{3}(_[a-z0-9-]{1,16}){0,8}$/i;
const SET_CODE = /^[a-z]{1,4}\d{0,3}$/i;
const LANGUAGE = /^[a-z]{2,3}$/i;
// legacy_no_verdict: an older backend answered without a `match` verdict (v1 logs
// showed this as `unknown`).
const STATUS = new Set(['matched', 'identity_only', 'no_match', 'service_unavailable', 'not_uploaded', 'local_ocr', 'legacy_no_verdict', 'unknown']);
const REASON = new Set(['no_evidence', 'no_card_number', 'number_not_in_database', 'number_name_conflict', 'low_evidence', 'none']);
const EVIDENCE = new Set(['cardNumber exact', 'cardNumber fuzzy-1', 'cardNumber fuzzy-2', 'character exact/contains', 'character fuzzy', 'title exact/contains', 'title fuzzy', 'rarity', 'hp', 'bloom/type', 'local OCR cardNumber']);
const OUTCOMES = new Set<ScanOutcome>(['pending', 'added', 'corrected', 'discarded', 'cancelled', 'failed', 'no_match']);
const AUTH_STAGE = /^[a-z][a-z_]{1,31}$/;

function pick(value: unknown, pattern: RegExp, missing = UNKNOWN): string {
  if (value === null || value === undefined || value === '' || value === 'NONE' || value === 'none') return missing;
  // Sentinels written by an earlier sanitise pass stay as they are (idempotent).
  if (value === UNKNOWN || value === REDACTED) return value;
  const s = String(value).trim();
  return pattern.test(s) ? s : REDACTED;
}

/** Card names keep their real punctuation / digits (safeCardText), unsafe → redacted. */
function safeName(value: unknown): string {
  if (value === null || value === undefined || value === '' || value === 'NONE' || value === 'none') return UNKNOWN;
  if (value === UNKNOWN || value === REDACTED) return value;
  return safeCardText('name', value) ?? REDACTED;
}

const PRESENT_KIND = new Set(['best', 'identity', 'none']);
const PRESENT_REASON = new Set(['no_evidence', 'no_card_number', 'number_not_in_database', 'number_name_conflict', 'low_evidence', 'none']);
const PRESENT_SOURCE = new Set(['server_verdict', 'legacy_evidence', 'legacy_no_evidence', 'local_ocr']);
const TIMELINE_EVENTS = new Set<TimelineEvent>(['presented', 'added', 'corrected', 'discarded', 'cancelled', 'failed', 'no_match']);
const PROVENANCE = new Set<Provenance>(['server_trace', 'legacy_debug', 'none']);

/** Re-validates a stored / incoming trace (both provenances) field by field. */
export function sanitizeTrace(raw: any): DiagTrace | undefined {
  if (!raw || typeof raw !== 'object' || !PROVENANCE.has(raw.provenance)) return undefined;
  if (raw.provenance === 'server_trace') {
    const t = projectTrace({ ...raw, schema: raw.traceSchema, verdict: raw.serverVerdict });
    if (!t) return undefined;
    return {
      provenance: 'server_trace', traceSchema: t.schema, requestId: t.requestId, backendSha: t.backendSha,
      replySchema: t.replySchema, fields: t.fields, candidateCount: t.candidateCount, top: t.top,
      serverVerdict: t.verdict, rejection: t.rejection,
    };
  }
  const fields = {} as Record<TraceField, FieldTrace>;
  for (const f of TRACE_FIELDS) {
    const x = raw.fields?.[f];
    // An older backend can only say parsed / parse_error / redacted; anything it did not
    // carry is not_provided (it cannot tell missing from empty from NONE).
    fields[f] = ['parsed', 'parse_error', 'redacted'].includes(x?.state) ? sanitizeFieldTrace(f, x) : { state: 'not_provided' };
  }
  // CR 2026-10-16 #2: provenance (where the FIELDS came from) is independent of whether
  // the backend sent a verdict. A 4a566fa-style response has `match` but no trace.
  const sv = raw.serverVerdict;
  const serverVerdict = sv && ['matched', 'identity_only', 'no_match'].includes(sv.status)
    ? { status: sv.status, reason: REASON.has(sv.reason) && sv.reason !== 'none' ? sv.reason : null }
    : { status: 'legacy_no_verdict', reason: null };
  return {
    provenance: raw.provenance, traceSchema: null, requestId: null, backendSha: null, replySchema: 'not_provided',
    fields, candidateCount: typeof raw.candidateCount === 'number' && Number.isFinite(raw.candidateCount) ? Math.max(0, Math.min(99, Math.floor(raw.candidateCount))) : null,
    top: (Array.isArray(raw.top) ? raw.top : []).slice(0, 5).map((c: any) => withName({
      id: typeof c?.id === 'string' && CATALOG_ID.test(c.id) ? c.id : REDACTED,
      score: typeof c?.score === 'number' && Number.isFinite(c.score) ? Math.round(c.score * 10) / 10 : null,
      evidence: evidenceTokens(c?.evidence),
    }, c?.name)),
    serverVerdict,
    rejection: null,
  };
}

function ms(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value < 600_000
    ? Math.round(value)
    : undefined;
}

/** Re-validates one entry field by field. Unknown keys are dropped; bad values redacted. */
export function sanitizeEntry(raw: any): DiagEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  if (typeof raw.id !== 'string' || !ID.test(raw.id)) return null;
  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? new Date(raw.at).toISOString() : null;
  if (!at) return null;
  const kind: DiagKind = raw.kind === 'auth' ? 'auth' : 'scan';
  const stagesMs: Partial<Record<StageName, number>> = {};
  for (const k of ['capture', 'prepare', 'request', 'fallback', 'total'] as StageName[]) {
    const v = ms(raw.stagesMs?.[k]);
    if (v !== undefined) stagesMs[k] = v;
  }
  const entry: DiagEntry = {
    v: DIAGNOSTICS_SCHEMA,
    id: raw.id,
    kind,
    at,
    platform: ['android', 'ios', 'web'].includes(raw.platform) ? raw.platform : UNKNOWN,
    appVersion: pick(raw.appVersion, VERSION),
    nativeBuild: pick(raw.nativeBuild, VERSION),
    model: pick(raw.model, MODEL),
    stagesMs,
    errors: Array.isArray(raw.errors)
      ? [...new Set(raw.errors.map((e: unknown) => (typeof e === 'string' && ERROR_CODE.test(e) ? e : 'REDACTED_ERROR')))].slice(0, 8) as string[]
      : [],
  };
  if (kind === 'scan') {
    entry.source = raw.source === 'gallery' ? 'gallery' : 'camera';
    const x = raw.extracted ?? {};
    entry.extracted = {
      name: safeName(x.name),
      number: pick(typeof x.number === 'string' && x.number !== REDACTED ? x.number.toLowerCase() : x.number, CARD_NUMBER),
      set: pick(x.set, SET_CODE),
      language: pick(typeof x.language === 'string' && x.language !== UNKNOWN && x.language !== REDACTED ? x.language.toUpperCase() : x.language, LANGUAGE),
    };
    const m = raw.match ?? {};
    entry.match = {
      status: STATUS.has(m.status) ? m.status : UNKNOWN,
      reason: REASON.has(m.reason) ? m.reason : 'none',
      ruleScore: typeof m.ruleScore === 'number' && Number.isFinite(m.ruleScore) ? Math.round(m.ruleScore * 10) / 10 : null,
      evidence: Array.isArray(m.evidence) ? m.evidence.filter((e: unknown) => typeof e === 'string' && EVIDENCE.has(e)).slice(0, 8) : [],
    };
    entry.outcome = OUTCOMES.has(raw.outcome) ? raw.outcome : 'pending';
    const trace = sanitizeTrace(raw.trace);
    if (trace) entry.trace = trace;
    const p = raw.presentation;
    if (p && PRESENT_KIND.has(p.kind)) {
      entry.presentation = {
        kind: p.kind,
        reason: PRESENT_REASON.has(p.reason) ? p.reason : 'none',
        source: PRESENT_SOURCE.has(p.source) ? p.source : UNKNOWN,
      };
    }
    if (Array.isArray(raw.timeline)) {
      const tl = raw.timeline
        .filter((x: any) => x && TIMELINE_EVENTS.has(x.e) && ms(x.t) !== undefined)
        .map((x: any) => ({ e: x.e as TimelineEvent, t: ms(x.t)! }))
        .slice(-MAX_TIMELINE);
      if (tl.length) entry.timeline = tl;
    }
    if (raw.correctedTo !== undefined) {
      const c = String(raw.correctedTo);
      entry.correctedTo = CATALOG_ID.test(c) ? c : REDACTED;
    }
  } else {
    entry.auth = {
      stage: typeof raw.auth?.stage === 'string' && AUTH_STAGE.test(raw.auth.stage) ? raw.auth.stage : UNKNOWN,
      code: typeof raw.auth?.code === 'string' && ERROR_CODE.test(raw.auth.code) ? raw.auth.code : 'REDACTED_ERROR',
    };
  }
  return entry;
}

/** Drops expired / invalid entries and keeps the newest MAX_ENTRIES. */
export function pruneEntries(entries: unknown, now = Date.now()): DiagEntry[] {
  if (!Array.isArray(entries)) return [];
  return entries
    .map(sanitizeEntry)
    .filter((e): e is DiagEntry => !!e && now - Date.parse(e.at) <= MAX_AGE_MS && Date.parse(e.at) <= now + 60_000)
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at))
    .slice(-MAX_ENTRIES);
}

/** The exported file: re-sanitised entries plus a header that says what they are. */
export function buildExport(entries: unknown, now = Date.now()): string {
  const clean = pruneEntries(entries, now);
  return JSON.stringify({
    format: 'holohunter-diagnostics',
    schema: DIAGNOSTICS_SCHEMA,
    exportedAt: new Date(now).toISOString(),
    note: 'Local diagnostics only. ruleScore is a deterministic ranking score, not accuracy. No photos, tokens or account data.',
    count: clean.length,
    // Human summary first (v39 user report: the raw log was unreadable); the full
    // technical entries follow unchanged.
    summary: buildReadableSummary(clean),
    entries: clean,
  }, null, 2);
}

const ERROR_TEXT: Record<string, string> = {
  RECOGNITION_UNAVAILABLE: '辨識服務沒有回應結果',
  NETWORK_ERROR: '網路連線失敗（沒有收到伺服器回應）',
  SERVICE_BUSY: '辨識服務忙碌',
  TIMEOUT: '辨識逾時',
  PROVIDER_TIMEOUT: '辨識服務逾時',
  PROVIDER_BUSY: '辨識服務忙碌',
  PROVIDER_ERROR: '辨識服務錯誤（原因未知）',
  NO_MATCH: '沒有相符的卡',
  CANCELLED: '已取消',
  SCAN_FAILED: '拍攝或處理失敗',
};
const REASON_TEXT: Record<string, string> = {
  no_evidence: '照片上沒有可用的卡號或名稱',
  no_card_number: '沒有讀到卡號',
  number_not_in_database: '讀到的卡號不在資料庫',
  number_name_conflict: '讀到的卡號與角色名稱不符',
  low_evidence: '證據不足',
};
const VERDICT_TEXT: Record<string, string> = {
  matched: '已確定版本',
  identity_only: '已辨識卡牌，版本未定（不顯示價格）',
  no_match: '沒有相符的卡',
  service_unavailable: '辨識服務沒有回應結果',
  not_uploaded: '照片未送出',
  legacy_no_verdict: '舊版伺服器（沒有判定欄位）',
};
const PRESENT_TEXT: Record<string, string> = { best: '最佳結果預覽', identity: '卡牌已辨識・請選版本', none: '找不到相符卡牌' };
const OUTCOME_TEXT: Record<string, string> = {
  pending: '未完成', added: '已加入', corrected: '已改選其他卡並加入', discarded: '已捨棄（重拍）',
  cancelled: '已離開／取消', failed: '失敗', no_match: '停在「找不到」畫面',
};
const EVIDENCE_TEXT: Record<string, string> = {
  'cardNumber exact': '卡號相同', 'cardNumber fuzzy-1': '卡號差 1 字', 'cardNumber fuzzy-2': '卡號差 2 字',
  'character exact/contains': '角色名稱相符', 'character fuzzy': '角色名稱相近', 'title exact/contains': '標題相符',
  'title fuzzy': '標題相近', rarity: '稀有度相符', hp: 'HP 相符', 'bloom/type': '類型相符',
};
const SERVICE_ERRORS = new Set(['RECOGNITION_UNAVAILABLE', 'NETWORK_ERROR', 'SERVICE_BUSY', 'TIMEOUT', 'PROVIDER_TIMEOUT', 'PROVIDER_BUSY', 'PROVIDER_ERROR']);

/** `hBP05-081_hBP05_U_hBP05-081_U` → `hBP05-081 U`. */
function printingLabel(id: string): string {
  const [num, , rarity] = id.split('_');
  return rarity ? `${num} ${rarity}` : num;
}

/**
 * Readable Traditional Chinese summary of already-sanitised entries, grouped by app build
 * (newest first) so old and new versions are never mixed. Only fields the entry already
 * holds — nothing new is collected. ruleScore is never presented as accuracy.
 */
export function buildReadableSummary(entries: DiagEntry[]): string[] {
  const out: string[] = ['說明：以下是本機掃描紀錄的摘要；完整技術欄位在 entries。排序分數不是準確率。不含照片、帳號或金鑰。'];
  const builds = [...new Set(entries.map((e) => e.nativeBuild))]
    .sort((a, b) => (Number(b) || -1) - (Number(a) || -1));
  builds.forEach((build, i) => {
    const group = entries.filter((e) => e.nativeBuild === build);
    out.push(`=== App build ${build}${i === 0 && builds.length > 1 ? '（較新版本）' : builds.length > 1 ? '（較舊版本）' : ''}：${group.length} 筆 ===`);
    group.forEach((e, n) => out.push(...summarizeEntry(e, n + 1)));
  });
  return out;
}

function summarizeEntry(e: DiagEntry, n: number): string[] {
  const when = `${e.at.slice(0, 10)} ${e.at.slice(11, 19)} UTC`;
  if (e.kind === 'auth') {
    return [`#${n} ${when}｜登入｜階段 ${e.auth?.stage ?? UNKNOWN}｜代碼 ${e.auth?.code ?? UNKNOWN}`];
  }
  const lines = [`#${n} ${when}｜${e.source === 'gallery' ? '相簿' : '相機'}｜${e.platform}｜模型 ${e.model}`];
  const f = e.trace?.fields;
  const shown = (x: FieldTrace | undefined, fallback?: string) => {
    const v = x?.received ?? x?.value ?? (fallback && fallback !== UNKNOWN ? fallback : undefined);
    return v === undefined ? '（沒讀到）' : v === REDACTED || x?.state === 'redacted' ? '（已遮蔽）' : v;
  };
  const read = e.extracted;
  lines.push(`  讀到：名稱 ${shown(f?.name, read?.name)}／卡號 ${shown(f?.number, read?.number)}／系列 ${shown(f?.set, read?.set)}／稀有度 ${shown(f?.rarity)}`);
  const top = e.trace?.top ?? [];
  const exact = top.filter((c) => c.evidence.includes('cardNumber exact'));
  if (exact.length) {
    const names = [...new Set(exact.map((c) => c.name ?? '（名稱未記錄）'))].join('、');
    lines.push(`  這個卡號在資料庫是：${names}（${exact.map((c) => printingLabel(c.id).split(' ')[1] ?? '').filter(Boolean).join('、')}）`);
  }
  if (top.length) {
    lines.push(`  候選前 ${Math.min(3, top.length)} 名：${top.slice(0, 3).map((c) => `${printingLabel(c.id)}${c.name ? ` ${c.name}` : ''}（${c.evidence.map((x) => EVIDENCE_TEXT[x] ?? x).join('・') || '無證據'}）`).join('；')}`);
  }
  const verdict = e.trace?.serverVerdict ?? (e.match ? { status: e.match.status, reason: e.match.reason } : null);
  if (verdict && verdict.status !== UNKNOWN) {
    const why = verdict.reason && verdict.reason !== 'none' ? `，原因：${REASON_TEXT[verdict.reason] ?? verdict.reason}` : '';
    lines.push(`  伺服器判定：${VERDICT_TEXT[verdict.status] ?? verdict.status}${why}`);
  }
  if (e.presentation) {
    const why = e.presentation.reason !== 'none' ? `（${REASON_TEXT[e.presentation.reason] ?? e.presentation.reason}）` : '';
    lines.push(`  App 顯示：${PRESENT_TEXT[e.presentation.kind]}${why}`);
  }
  const errs = e.errors.map((x) => (x.startsWith('HTTP_') ? `HTTP ${x.slice(5)}` : ERROR_TEXT[x] ?? x));
  if (errs.length) lines.push(`  錯誤：${[...new Set(errs)].join('、')}`);
  const serviceFailed = e.errors.some((x) => SERVICE_ERRORS.has(x));
  lines.push(`  結果：${OUTCOME_TEXT[e.outcome ?? 'pending'] ?? e.outcome}｜${serviceFailed
    ? '可重試：是（服務沒有回應，與照片無關）'
    : e.match?.status === 'no_match' ? '建議：重拍（卡號清楚、避免反光）或手動搜尋' : '可重試：不需要'}`);
  return lines;
}

/** Correlation id: random, per scan, not derived from any device or account id. */
export function newDiagnosticId(random: () => number = Math.random): string {
  let s = '';
  for (let i = 0; i < 16; i++) s += Math.floor(random() * 36).toString(36);
  return s;
}

/**
 * The fields a recognition result carries that are worth keeping, mapped from the
 * backend's sanitised debug / match (never the raw model output).
 */
export function diagnosticsFromResult(r: any): { extracted: Partial<DiagEntry['extracted']>; match: Partial<NonNullable<DiagEntry['match']>>; errors: string[]; model?: string; trace?: DiagTrace } {
  const debug = r?.debug ?? {};
  const x = debug.extracted ?? {};
  const errors: string[] = [];
  if (r?.cancelled) errors.push('CANCELLED');
  if (r?.timedOut) errors.push('TIMEOUT');
  if (r?.serviceUnavailable) errors.push('RECOGNITION_UNAVAILABLE');
  // What is provable about a service failure (recognitionOutcome); 'unavailable' = unknown.
  if (r?.failure === 'network') errors.push('NETWORK_ERROR');
  if (r?.failure === 'busy') errors.push('SERVICE_BUSY');
  if (r?.failure === 'timeout' && !r?.timedOut) errors.push('TIMEOUT');
  if (Number.isInteger(r?.httpStatus) && r.httpStatus >= 400 && r.httpStatus <= 599) errors.push(`HTTP_${r.httpStatus}`);
  if (typeof r?.imageRejected === 'string') errors.push(r.imageRejected);
  if (typeof r?.code === 'string') errors.push(r.code);
  if (r?.match?.status === 'no_match') errors.push('NO_MATCH');
  const legacy = !r?.match && !r?.trace && r?.debug;
  const status = r?.match?.status
    ?? (r?.serviceUnavailable ? 'service_unavailable' : r?.imageRejected ? 'not_uploaded' : legacy ? 'legacy_no_verdict' : undefined);
  const t = r?.trace;
  let trace: DiagTrace | undefined;
  if (t && t.schema === TRACE_SCHEMA) {
    trace = sanitizeTrace({ ...t, provenance: 'server_trace', traceSchema: t.schema, serverVerdict: t.verdict });
  } else if (r?.debug) {
    // Older backend: only what its debug block carried; absent ≠ "not read".
    const val = (v: unknown) => (typeof v === 'string' && v ? { state: 'parsed', received: v, value: v } : { state: 'not_provided' });
    // The number as received (cardNumberRaw, v37 sends it) next to the normalised value:
    // received but not normalisable → parse_error with the received text kept.
    const rawNum = typeof x.cardNumberRaw === 'string' && x.cardNumberRaw ? x.cardNumberRaw : null;
    const normNum = typeof debug.normalizedCardNumber === 'string' && debug.normalizedCardNumber ? debug.normalizedCardNumber : null;
    const number = normNum ? { state: 'parsed', received: rawNum ?? undefined, value: normNum }
      : rawNum ? { state: 'parse_error', received: rawNum } : { state: 'not_provided' };
    trace = sanitizeTrace({
      provenance: 'legacy_debug',
      serverVerdict: r?.match ? { status: r.match.status, reason: r.match.reason } : undefined,
      fields: {
        name: val(x.characterName), title: val(x.cardTitle), number,
        set: val(x.setCode), language: val(x.language), rarity: val(x.rarity),
      },
      candidateCount: Array.isArray(r?.candidates) ? r.candidates.length : null,
      top: (r?.candidates ?? []).slice(0, 5).map((c: any) => ({ id: c?.card?.id, score: null, evidence: c?.evidence ?? [], name: c?.card?.name })),
    });
  }
  return {
    model: debug.model ?? t?.model,
    trace,
    extracted: {
      name: x.characterName || x.cardTitle || undefined,
      number: debug.normalizedCardNumber || undefined,
      set: x.setCode || undefined,
      language: x.language || undefined,
    },
    match: {
      status,
      reason: r?.match?.reason ?? undefined,
      ruleScore: typeof r?.match?.ruleScore === 'number' ? r.match.ruleScore : null,
      evidence: r?.match?.evidence ?? [],
    },
    errors,
  };
}

/**
 * Sign-in failure → { stage, code } for the local log. Only the AuthError's short code
 * and the server's fixed-vocabulary `reason` are used — never the message, the token,
 * an email or a provider payload.
 */
export function authDiagnostic(err: any, provider: string): { stage: string; code: string } {
  const raw = typeof err?.code === 'string' ? err.code : '';
  const reason = typeof err?.reason === 'string' && /^[a-z_]{2,40}$/.test(err.reason) ? err.reason : '';
  let stage = 'unknown';
  if (raw === 'client_id_missing') stage = 'client_config';
  else if (raw === 'play_services_unavailable') stage = 'play_services';
  else if (raw === 'cancel' || raw === 'no_id_token' || raw === 'network_error' || raw.startsWith('google_')) stage = 'sdk_sign_in';
  else if (/^[A-Z][A-Z_]+$/.test(raw)) stage = 'backend_verify';
  const code = `${provider}_${raw || 'unknown'}${reason ? `_${reason}` : ''}`.toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 48);
  return { stage, code };
}
