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

export const DIAGNOSTICS_SCHEMA = 1;
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
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,47}$/;
const ID = /^[a-z0-9]{8,32}$/;
const VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const MODEL = /^[a-z0-9][a-z0-9.-]{1,47}$/;
const CARD_NUMBER = /^h[a-z]{1,2}(\d{2})?-\d{3}$/;
const CATALOG_ID = /^h[a-z]{1,2}\d{0,2}-\d{3}(_[a-z0-9-]{1,16}){0,8}$/i;
const SET_CODE = /^[a-z]{1,4}\d{0,3}$/i;
const LANGUAGE = /^[a-z]{2,3}$/i;
// A card / character name: letters of the scripts cards are printed in, spaces and
// the name punctuation used in the catalog. Digits, @, /, : and the like (what emails,
// phone numbers, urls or tokens need) are not allowed.
const NAME = /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}A-Za-zÀ-ɏ ・ー'’.&!?-]{1,40}$/u;
const STATUS = new Set(['matched', 'identity_only', 'no_match', 'service_unavailable', 'not_uploaded', 'local_ocr', 'unknown']);
const REASON = new Set(['no_evidence', 'no_card_number', 'number_not_in_database', 'number_name_conflict', 'low_evidence', 'none']);
const EVIDENCE = new Set(['cardNumber exact', 'character exact/contains', 'character fuzzy', 'title exact/contains', 'title fuzzy', 'rarity', 'hp', 'bloom/type', 'local OCR cardNumber']);
const OUTCOMES = new Set<ScanOutcome>(['pending', 'added', 'corrected', 'discarded', 'cancelled', 'failed', 'no_match']);
const AUTH_STAGE = /^[a-z][a-z_]{1,31}$/;

function pick(value: unknown, pattern: RegExp, missing = UNKNOWN): string {
  if (value === null || value === undefined || value === '' || value === 'NONE' || value === 'none') return missing;
  // Sentinels written by an earlier sanitise pass stay as they are (idempotent).
  if (value === UNKNOWN || value === REDACTED) return value;
  const s = String(value).trim();
  return pattern.test(s) ? s : REDACTED;
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
      name: pick(x.name, NAME),
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
    entries: clean,
  }, null, 2);
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
export function diagnosticsFromResult(r: any): { extracted: Partial<DiagEntry['extracted']>; match: Partial<NonNullable<DiagEntry['match']>>; errors: string[]; model?: string } {
  const debug = r?.debug ?? {};
  const x = debug.extracted ?? {};
  const errors: string[] = [];
  if (r?.cancelled) errors.push('CANCELLED');
  if (r?.timedOut) errors.push('TIMEOUT');
  if (r?.serviceUnavailable) errors.push('RECOGNITION_UNAVAILABLE');
  if (typeof r?.imageRejected === 'string') errors.push(r.imageRejected);
  if (typeof r?.code === 'string') errors.push(r.code);
  if (r?.match?.status === 'no_match') errors.push('NO_MATCH');
  const status = r?.match?.status
    ?? (r?.serviceUnavailable ? 'service_unavailable' : r?.imageRejected ? 'not_uploaded' : undefined);
  return {
    model: debug.model,
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
