import { normalizeCardIdentity } from '../src/utils/cardNormalization';
import { parseCardNumberToken } from '../src/utils/cardNumberToken';
import { buildRecognitionTrace, isUnknownWord, readExpectedField, receivedCardText, safeCardText, type ExpectedLabel } from '../src/services/scanTrace';
import {
  validateRecognitionImages,
  type RecognitionImageErrorCode,
} from '../src/services/recognitionImagePolicy';

/**
 * @version 8
 * recognize-card.ts — Gemini Vision + deterministic candidate ranking for Hololive TCG cards.
 *
 * Accepts one or two image data URIs. The web scanner sends both a full-frame image
 * and a scan-area crop so the model can read tiny bottom-edge card numbers without
 * losing whole-card context; the native app sends one camera / library photo.
 *
 * Every image must pass src/services/recognitionImagePolicy (data:image/{jpeg,png,webp},
 * strict base64 whose signature matches the type, bounded size) BEFORE a provider is
 * resolved. A local file:// / content:// path or any other bare string is answered 400 —
 * it is never wrapped as base64 and forwarded to Gemini (native AI photo upload, 2026-10-14).
 *
 * The vision call is served exclusively by Google direct (GEMINI_API_KEY). Any other
 * provider — in particular OpenRouter — is a hard denylist (DIC-1185 FinOps repair):
 * an unprovisioned or failing Google leg fails closed at 503, never over to another
 * host. An inherited OPENROUTER_API_KEY in the runtime environment must not open a
 * connection to openrouter.ai, ever.
 */

export const config = { runtime: 'edge' };

/**
 * Owner choice 2026-10-15: speed first. Official model card (read 2026-10-15,
 * ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite): model code
 * `gemini-3.5-flash-lite`, Stable, inputs text + image. No fallback to another model —
 * a failure is a failure (503/502 → the app's local OCR), never a silent switch.
 */
export const GEMINI_MODEL = 'gemini-3.5-flash-lite';
/**
 * Gemini 3 models think by default; 3.5 Flash-Lite defaults to MINIMAL (thinking guide,
 * 2026-10-15). The REST GenerationConfig documents thinkingConfig.thinkingLevel
 * (ai.google.dev/api/generate-content), so MINIMAL is pinned explicitly — the documented
 * default, now immune to a server-side default change. The answer is ~6 short lines;
 * the cap leaves room for minimal thinking so the answer is not cut off (180 was sized
 * for a non-thinking 2.5 call). Temperature is left at the Gemini 3 default (1.0): the
 * Gemini 3 guide strongly recommends against lowering it (looping / degraded output).
 */
export const VISION_GENERATION_CONFIG = Object.freeze({
  maxOutputTokens: 1024,
  thinkingConfig: Object.freeze({ thinkingLevel: 'MINIMAL' }),
});

// The scanner abandons the request after RECOGNITION_REQUEST_TIMEOUT_MS (15s, see
// src/services/recognitionOutcome). The vision call shares ONE budget sized below
// that, leaving room for the JSON round trip and ranking (DIC-1020 CR).
export const VISION_TOTAL_BUDGET_MS = 11000;
// Below this there is no point opening a connection at all.
const VISION_MIN_LEG_MS = 1500;
// Canonical production database asset (DIC-1245). Kept as a literal so the
// recognition-provider AST guard can constant-fold the fetch URL against its
// host allowlist; the value must stay in lock-step with PRODUCTION_ORIGIN in
// src/config/apiOrigin.ts and is enforced by scripts/test-native-bundle-origin.
const DATABASE_URL = 'https://holohunter.dicoge.com/data/database.json';

// A card number occupies roughly 3% of a card's height, so a frame shorter than this
// cannot physically carry a legible one. Asked anyway, the model does not answer NONE —
// it invents a plausible number, which then scores as "cardNumber exact" (+100) and
// buries the real card under five confident wrong candidates (DIC-1021 QA). The scanner
// sends up to 1536px, so this floor is far below anything a real scan produces.
const MIN_LEGIBLE_IMAGE_PX = 320;

// Recognition stays unavailable until the operator provisions a vision provider key in
// the deployment environment. Raised as its own type so the handler can answer 503 with a
// stable code instead of a bare 500: the client has to tell "this deployment cannot
// recognise anything" apart from "this card has no match", otherwise an unprovisioned
// environment tells the user to fix their lighting (DIC-1013 QA).
class RecognitionUnavailableError extends Error {}

export const RECOGNITION_UNAVAILABLE_CODE = 'RECOGNITION_UNAVAILABLE';

let dbFetchPromise: Promise<Record<string, any> | null> | null = null;

async function getDatabase(): Promise<Record<string, any> | null> {
  if (dbFetchPromise) return dbFetchPromise;
  dbFetchPromise = (async () => {
    try {
      const res = await fetch(DATABASE_URL);
      if (!res.ok) { dbFetchPromise = null; return null; }
      return (await res.json())?.cards || null;
    } catch {
      dbFetchPromise = null;
      return null;
    }
  })();
  return dbFetchPromise;
}


/**
 * The model's CARD_NUMBER answer as a canonical catalog number, or null. The whole
 * answer must be one card number (src/utils/cardNumberToken): `hBP01-0100` is not
 * hBP01-010, and a reply with extra text is not a number (CR 2026-10-15 P2_2).
 */
export function normalizeCardNumber(raw: string | null | undefined): string | null {
  return parseCardNumberToken(raw);
}

function normalizeText(v: any): string {
  return String(v || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[・･\s'"`.,，、:：;；()（）\[\]【】]/g, '')
    .trim();
}

function editDistance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

function similarity(a: string, b: string): number {
  const x = normalizeText(a), y = normalizeText(b);
  if (!x || !y) return 0;
  if (x === y) return 1;
  if (x.includes(y) || y.includes(x)) return Math.min(0.95, Math.min(x.length, y.length) / Math.max(x.length, y.length) + 0.25);
  return Math.max(0, 1 - editDistance(x, y) / Math.max(x.length, y.length));
}

// One shared reader for the expected reply lines (src/services/scanTrace): the ranking
// and the trace can no longer disagree about an indented / spaced line (CR 2026-10-16 #3).
function parseField(reply: string, field: ExpectedLabel): string {
  const value = readExpectedField(reply, field) ?? '';
  return !value || isUnknownWord(value) ? '' : value;
}

// Store MVP fail-closed boundary (CR DIC-913 #2): when the client identifies as a
// Store MVP build (POST body `storeMvp: true`), the recognition response must not
// carry the advanced fields OVER THE WIRE — stripping them app-side is not enough.
// Mirrors the field set of src/utils/cardReleaseFilter + scripts sanitizer. Sale
// price (sellPrice / prices[].sellPrice) is always preserved.
function stripStoreMvpFields<T extends Record<string, any>>(card: T): T {
  const out: Record<string, any> = { ...card };
  delete out.buyPrice;
  delete out.buyPriceHistory;
  delete out.priceHistory;
  delete out.ytStats;
  if (Array.isArray(out.prices)) {
    out.prices = out.prices.map((p: any) => {
      if (p && typeof p === 'object') {
        const rest: Record<string, any> = { ...p };
        // per-version buyPrice + its merge-buy-prices provenance stamps
        for (const field of ['buyPrice', 'buyPriceVersion', 'buyPriceSource', 'buyPriceTimestamp']) {
          delete rest[field];
        }
        return rest;
      }
      return p;
    });
  }
  return out as T;
}

function fmt(entry: any, storeMvp = false) {
  // sellPrice is the recognized printing's OWN canonical price, passed through
  // untouched. There used to be a `rarity === 'SEC'` branch here that replaced
  // it with Math.max over entry.prices[] — the same cross-printing Math.max the
  // buyPrice comment below has forbidden since DIC-856, and it was serving a
  // sibling printing's number for every one of the 12 SEC entries that have
  // printings: hBP03-003 canonically sells for JPY 1,280 and was emitted as
  // JPY 128,000, the パラレル/サイン printing's price (DIC-1325 CR).
  //
  // Reaching for the most expensive sibling is never right here. The scan path
  // identifies ONE printing, and quoting a different printing's price is exactly
  // the cross-printing fallback the product forbids — latent while prices were
  // hidden, user-visible now that the scan surfaces them (DIC-1319).
  const price = entry.sellPrice;
  const normalized = normalizeCardIdentity(entry);
  const base = {
    // Compound printing identity (e.g. hBP01-024_hBP01_C_hBP01-024_C).
    // The database keys entries by this compound id, and cardRecognition
    // rehydrates it as `CardInfo.id`; dropping it on the wire collapses the
    // eight hBP01-024 printings into one at the client boundary — session /
    // duplicate identity then no longer reflects the printing the user chose
    // (DIC-1325 / DIC-1339). Fall back to cardNumber only when a legacy
    // catalog row genuinely has no `id`.
    id: entry.id || entry.cardNumber,
    cardNumber: entry.cardNumber,
    name: entry.name,
    sellPrice: price,
    // buyPrice 直接透傳 database 的 card 層級精確版本收購價（merge-buy-prices 已依版本精確對齊，
    // 對不到即缺欄位 → ?? null）。嚴禁在此做卡號 fallback / 跨版本 Math.max（DIC-856）。
    buyPrice: entry.buyPrice ?? null,
    series: entry.series,
    rarity: entry.rarity,
    imageUrl: entry.officialImage || entry.localImage || '',
    prices: entry.prices,
    priceHistory: entry.priceHistory || {},
    ytStats: entry.ytStats ?? null,
    type: normalized.category || '',
    grade: normalized.stage || '',
    normalized,
  };
  return storeMvp ? stripStoreMvpFields(base) : base;
}

function json(d: any, status = 200): Response {
  return new Response(JSON.stringify(d), {
    status,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    },
  });
}

// Size markers live near the front of a JPEG/PNG, so a bounded prefix is all this needs.
const HEADER_B64_CHARS = 24000;
// `data:image/jpeg;base64,` and friends are far shorter than this; a comma further out
// does not describe a data URI worth parsing.
const DATA_URI_HEAD_CHARS = 1024;
// Doubled so base64 broken across lines still yields a full HEADER_B64_CHARS prefix.
const HEADER_RAW_CHARS = HEADER_B64_CHARS * 2;

function decodeImageHeader(image: string): Uint8Array | null {
  // Every step below must stay bounded: this runs on the edge hot path against
  // multi-megabyte camera frames, so nothing may scan, copy, or sanitize the payload
  // tail (CR DIC-1020).
  const comma = image.slice(0, DATA_URI_HEAD_CHARS).indexOf(',');
  const start = comma >= 0 ? comma + 1 : 0;
  const prefix = image.slice(start, start + HEADER_RAW_CHARS)
    .replace(/[^A-Za-z0-9+/]/g, '')
    .slice(0, HEADER_B64_CHARS);
  const usable = prefix.slice(0, prefix.length - (prefix.length % 4));
  if (usable.length < 32) return null;
  try {
    const binary = atob(usable);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    return null;
  }
}

/**
 * Longest edge of a JPEG or PNG, read straight from its header bytes.
 *
 * Returns null whenever the size cannot be established, and every caller must then fail
 * OPEN: refusing to scan a real photo would be far worse than scanning a small one.
 */
export function imageLongestEdge(image: string): number | null {
  const b = decodeImageHeader(image);
  if (!b || b.length < 26) return null;

  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) {
    const at = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
    const width = at(16), height = at(20);
    return width && height ? Math.max(width, height) : null;
  }

  if (b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) { i++; continue; }
      const marker = b[i + 1];
      // Padding and standalone markers carry no length field.
      if (marker === 0xff || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; }
      const segment = (b[i + 2] << 8) | b[i + 3];
      // SOF0-SOF15 hold height then width; c4/c8/cc share the range but are not frames.
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const height = (b[i + 5] << 8) | b[i + 6];
        const width = (b[i + 7] << 8) | b[i + 8];
        return width && height ? Math.max(width, height) : null;
      }
      if (segment < 2) return null;
      i += 2 + segment;
    }
  }
  return null;
}

/**
 * True when the full-frame image is too small to contain a readable card number.
 *
 * Only the FIRST image counts, because that is the whole card by this endpoint's
 * contract and the scan-area crop is cut out of it: a crop is legitimately smaller than
 * the frame, so the smallest image proves nothing, and an upscaled crop would hide a
 * useless frame behind a large pixel count without adding a single readable digit.
 * An unmeasurable frame returns false — callers must fail open.
 */
export function isBelowLegibleResolution(images: any[]): boolean {
  const frame = images.find((image): image is string => typeof image === 'string' && image.length > 0);
  if (!frame) return false;
  const edge = imageLongestEdge(frame);
  return edge !== null && edge < MIN_LEGIBLE_IMAGE_PX;
}

// Only reached with images validateRecognitionImages accepted, so the head is a known
// `data:<allowed mime>;base64,` prefix. Slicing at the first comma keeps this bounded.
function dataUriToGeminiPart(image: string) {
  const comma = image.indexOf(',');
  return {
    inline_data: {
      mime_type: image.slice('data:'.length, comma - ';base64'.length),
      data: image.slice(comma + 1),
    },
  };
}

/** User-safe wording per rejection; the stable `code` is what clients branch on. */
const IMAGE_REJECTION_MESSAGES: Record<RecognitionImageErrorCode, string> = {
  IMAGE_MISSING: '未收到照片，請重新拍攝',
  IMAGE_TOO_MANY: '一次最多只能送出兩張照片',
  IMAGE_URI_NOT_ALLOWED: '照片格式錯誤，請重新拍攝',
  IMAGE_NOT_DATA_URL: '照片格式錯誤，請重新拍攝',
  IMAGE_UNSUPPORTED_TYPE: '僅支援 JPEG、PNG 或 WebP 照片',
  IMAGE_INVALID_BASE64: '照片資料損毀，請重新拍攝',
  IMAGE_TYPE_MISMATCH: '照片資料損毀，請重新拍攝',
  IMAGE_TOO_LARGE: '照片檔案過大，請靠近卡片重新拍攝',
};

const visionPrompt = `You are identifying a real Hololive OFFICIAL CARD GAME card from camera photos.

You may receive two images: (1) full card/context and (2) a cropped scan area. Use both. Ignore phone UI overlays, scanner borders, reflections, and background.

Critical reading order:
1. CARD_NUMBER: tiny text near the bottom edge/bottom-right. Examples: hBP01-001, hBP08-024, hSD13-014, hBD24-007. Preserve prefix and digits exactly.
2. CHARACTER: main character/holomem name, usually top area. Transcribe it exactly as printed on the card (normally Japanese); never translate or romanize it.
3. HP: number in top-right if present.
4. RARITY: C, U, R, RR, S, SR, SEC, OUR, P, etc. near card number.
5. BLOOM_LEVEL / card type: Spot, Debut, 1st, 2nd, Buzz, Oshi, Support, Event, etc.
6. TITLE: card title/support event name, if distinct from character.

CARD_NUMBER discipline: transcribe only characters you can actually read in this photo. If the bottom-edge code is blurred, cropped, or too small to read character by character, answer NONE. Never infer it from the artwork, the character, the set, or a card you remember — an invented number is far worse than NONE, because it is trusted as an exact match.

If a field is not clearly visible, write NONE. Do not guess missing digits. Return exactly:
CHARACTER: [name or NONE]
HP: [number only or NONE]
RARITY: [rarity or NONE]
BLOOM_LEVEL: [level/type or NONE]
CARD_NUMBER: [exact card number or NONE]
TITLE: [title or NONE]
SET: [set / product code printed next to the card number, e.g. hBP01, or NONE]
LANGUAGE: [JA, EN, ZH or another printed card language code, or NONE]`;

type VisionAdapter = {
  provider: string;
  model: string;
  request: (images: string[], timeoutMs: number, clientSignal?: AbortSignal) => Promise<Response>;
  extract: (data: any) => string;
};

// The key travels in x-goog-api-key rather than the ?key= query parameter: a URL is the
// part of a request that leaks into logs, error strings and referrers, and this handler
// must never expose a provider key value (DIC-1019).
const googleAdapter = (apiKey: string): VisionAdapter => ({
  provider: 'gemini',
  model: GEMINI_MODEL,
  request: (images, timeoutMs, clientSignal) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: visionPrompt }, ...images.map(dataUriToGeminiPart)],
      }],
      generationConfig: VISION_GENERATION_CONFIG,
    }),
    signal: withClientAbort(AbortSignal.timeout(timeoutMs), clientSignal),
  }),
  extract: (data) => {
    // A reply cut off at the token cap is not an answer: its CARD_NUMBER line may be
    // missing or partial. Fail like an upstream error instead of ranking half a reply.
    if (data?.candidates?.[0]?.finishReason === 'MAX_TOKENS') throw new Error('gemini API error (413)');
    return (data?.candidates?.[0]?.content?.parts || [])
      .filter((part: any) => part?.thought !== true)
      .map((part: any) => part.text || '').join('\n').trim();
  },
});

/**
 * The provider call is abandoned when the scanner abandons us: the runtime aborts
 * `request.signal` when the client disconnects (scan cancelled, screen left, client
 * timeout), and that abort is forwarded to the Gemini fetch so no vision work continues
 * for a scan nobody is waiting for. Quota is device-local and charged only when the app
 * commits a card, so an aborted request can never charge — the server holds no quota.
 */
export class ClientAbortedError extends Error {}

function withClientAbort(timeout: AbortSignal, clientSignal?: AbortSignal): AbortSignal {
  if (!clientSignal) return timeout;
  const anyFn = (AbortSignal as any).any as ((signals: AbortSignal[]) => AbortSignal) | undefined;
  if (anyFn) return anyFn([timeout, clientSignal]);
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (timeout.aborted || clientSignal.aborted) controller.abort();
  timeout.addEventListener('abort', forward, { once: true });
  clientSignal.addEventListener('abort', forward, { once: true });
  return controller.signal;
}

/** Random per-request id for correlating a scan's app log with the server verdict. */
function newRequestId(): string | null {
  try {
    const bytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(bytes);
    return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

function readKey(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Only Google direct is a permitted vision provider. OPENROUTER_API_KEY is never
// read: an inherited key in the runtime environment must not open a connection to
// openrouter.ai (DIC-1185 FinOps repair).
function resolveAdapters(): VisionAdapter[] {
  const geminiKey = readKey('GEMINI_API_KEY');
  return geminiKey ? [googleAdapter(geminiKey)] : [];
}

async function callVision(images: string[], clientSignal?: AbortSignal): Promise<{ reply: string; provider: string; model: string }> {
  // Already validated by the handler; nothing is coerced into a data URI here.
  const imageList = images;
  const adapters = resolveAdapters();
  if (adapters.length === 0) throw new RecognitionUnavailableError('no vision provider key configured');

  const adapter = adapters[0];
  const legBudget = VISION_TOTAL_BUDGET_MS;
  if (legBudget < VISION_MIN_LEG_MS) {
    throw new Error(`${adapter.provider} API request failed`);
  }

  // Upstream bodies and raw transport errors never escape this block: a failing leg is
  // reduced to provider + HTTP status before it can reach a client response or a log.
  let reply: string;
  try {
    if (clientSignal?.aborted) throw new ClientAbortedError('client aborted');
    const res = await adapter.request(imageList, legBudget, clientSignal);
    if (!res.ok) throw new Error(`${adapter.provider} API error (${res.status})`);
    reply = adapter.extract(await res.json());
  } catch (e: any) {
    if (e instanceof ClientAbortedError || clientSignal?.aborted) {
      console.warn(`[recognize-card] client aborted; provider ${adapter.provider} call abandoned`);
      throw new ClientAbortedError('client aborted');
    }
    const safeError = e instanceof Error && /^\w+ API error \(\d+\)$/.test(e.message)
      ? e
      : new Error(`${adapter.provider} API request failed`);
    console.error(`[recognize-card] provider ${adapter.provider} failed: ${safeError.message}`);
    throw safeError;
  }
  if (!reply) {
    console.error(`[recognize-card] provider ${adapter.provider} returned an empty reply`);
  }
  return { reply, provider: adapter.provider, model: adapter.model };
}

export function rankCandidates(cards: Record<string, any>, extracted: any, storeMvp = false) {
  const entries = Object.values(cards) as any[];
  const normalizedNumber = normalizeCardNumber(extracted.cardNumberRaw);
  const normalizedNumberFlat = normalizedNumber?.replace(/[^a-z0-9]/g, '') || '';
  const character = normalizeText(extracted.characterName);
  const title = normalizeText(extracted.cardTitle);
  const rarity = normalizeText(extracted.rarity).toUpperCase();
  const hp = String(extracted.hp || '').replace(/\D/g, '');
  const bloom = normalizeText(extracted.bloom);

  const ranked = entries.map(entry => {
    let score = 0;
    const reasons: string[] = [];
    const entryNumber = String(entry.cardNumber || '').toLowerCase();
    const entryFlat = entryNumber.replace(/[^a-z0-9]/g, '');
    const entryName = normalizeText(entry.name);
    const entryRarity = normalizeText(entry.rarity).toUpperCase();
    const entryHp = String(entry.hp || '').replace(/\D/g, '');
    const entryBloom = normalizeText(entry.bloomLevel || entry.type || '');

    if (normalizedNumber && entryNumber === normalizedNumber) {
      score += 100; reasons.push('cardNumber exact');
    } else if (normalizedNumberFlat && entryFlat) {
      const distance = editDistance(entryFlat, normalizedNumberFlat);
      if (distance <= 1) { score += 78; reasons.push('cardNumber fuzzy-1'); }
      else if (distance <= 2 && normalizedNumberFlat.length >= 8) { score += 62; reasons.push('cardNumber fuzzy-2'); }
    }

    const charScore = character ? similarity(character, entryName) : 0;
    if (charScore >= 0.9) { score += 26; reasons.push('character exact/contains'); }
    else if (charScore >= 0.55) { score += 14 * charScore; reasons.push('character fuzzy'); }

    const titleScore = title ? similarity(title, entryName) : 0;
    if (titleScore >= 0.9) { score += 18; reasons.push('title exact/contains'); }
    else if (titleScore >= 0.55) { score += 10 * titleScore; reasons.push('title fuzzy'); }

    if (rarity && entryRarity === rarity) { score += 8; reasons.push('rarity'); }
    if (hp && entryHp && entryHp === hp) { score += 8; reasons.push('hp'); }
    if (bloom && entryBloom && (entryBloom.includes(bloom) || bloom.includes(entryBloom))) { score += 5; reasons.push('bloom/type'); }

    // Only photo evidence makes a candidate: a card number, or a character / title
    // reading. Rarity / HP / type alone match hundreds of cards and are tie-breakers,
    // never grounds for a candidate (scan best-match fix 2026-10-15).
    const photoEvidence = reasons.some(r => r.startsWith('cardNumber') || r.startsWith('character') || r.startsWith('title'));
    if (!photoEvidence) return { entry, score: 0, reasons, charScore, titleScore };

    // Series self-consistency is a tie-break between equally evidenced printings
    // only. It used to be added unconditionally, which let a scan that extracted
    // nothing still rank every original-print card as a "candidate".
    const prefix = entryNumber.split('-')[0];
    if (String(entry.series || '').toLowerCase() === prefix) score += 1.5;
    else if (String(entry.series || '').toLowerCase() === 'hpr') score -= 1;

    return { entry, score, reasons, charScore, titleScore };
  }).filter(c => c.score > 0).sort((a, b) => b.score - a.score);

  const topScore = ranked[0]?.score || 0;
  const secondScore = ranked[1]?.score || 0;
  const confidence = Math.max(0, Math.min(0.99, (topScore / 118) * Math.min(1, (topScore - secondScore + 18) / 38)));
  const candidates = ranked.slice(0, 5).map(item => ({
    ...fmt(item.entry, storeMvp),
    confidence: Math.round(Math.max(0.05, Math.min(0.99, item.score / 118)) * 100) / 100,
    reason: item.reasons.join(', '),
    score: Math.round(item.score * 10) / 10,
  }));

  const toCandidate = (item: typeof ranked[number]) => ({
    ...fmt(item.entry, storeMvp),
    confidence: Math.round(Math.max(0.05, Math.min(0.99, item.score / 118)) * 100) / 100,
    reason: item.reasons.join(', '),
    score: Math.round(item.score * 10) / 10,
  });

  return {
    normalizedCardNumber: normalizedNumber,
    candidateCount: ranked.length,
    confidence: Math.round(confidence * 100) / 100,
    reason: ranked[0]?.reasons.join(', ') || 'no candidate',
    candidates,
    match: decideMatch(ranked, {
      normalizedNumber, rarity, hasCharacter: !!character, hasTitle: !!title,
      characterScript: character ? scriptOf(String(extracted.characterName || '')) : null,
    }, toCandidate),
  };
}

type Script = 'japanese' | 'latin' | 'other';
/** Kana/kanji anywhere → japanese; only ASCII letters/digits/punctuation → latin. */
function scriptOf(text: string): Script {
  if (/[\u3040-\u30ff\u3400-\u9fff\uff66-\uff9f]/.test(text)) return 'japanese';
  if (/^[\x20-\x7e\u00c0-\u024f]+$/.test(text.trim())) return 'latin';
  return 'other';
}

export type MatchStatus = 'matched' | 'identity_only' | 'no_match';
export type NoMatchReason = 'no_evidence' | 'no_card_number' | 'number_not_in_database' | 'number_name_conflict';

export interface MatchVerdict<C = any> {
  status: MatchStatus;
  /** matched: the one printing. identity_only: the card (no printing → no price). */
  best: C | null;
  /** Printing resolved, so the price on `best` belongs to the card in hand. */
  printingResolved: boolean;
  reason?: NoMatchReason;
  /** Human-checkable evidence tokens, e.g. ['cardNumber exact', 'rarity']. */
  evidence: string[];
  /** Secondary correction options; each carries its own printing id and price. */
  alternatives: C[];
}

/**
 * Highest score is not an answer. A best match needs the card number read off the
 * photo and found in the catalog, not contradicted by the character reading, and —
 * to carry a price — one printing singled out (unique, or by the rarity read).
 * Everything else is an explicit outcome the client can explain.
 */
function decideMatch<C>(
  ranked: { entry: any; score: number; reasons: string[]; charScore: number; titleScore: number }[],
  read: { normalizedNumber: string | null; rarity: string; hasCharacter: boolean; hasTitle: boolean; characterScript: Script | null },
  toCandidate: (item: any) => C,
): MatchVerdict<C> {
  const none = (reason: NoMatchReason, alternatives: C[] = []): MatchVerdict<C> =>
    ({ status: 'no_match', best: null, printingResolved: false, reason, evidence: [], alternatives });
  if (ranked.length === 0) return none(read.normalizedNumber ? 'number_not_in_database' : 'no_evidence');

  // A character reading can only contradict (or corroborate) a catalog name written in
  // the same script: Gemini may answer in romaji ("Amane Kanata") for a name the
  // catalog stores in Japanese, and edit distance across scripts says nothing.
  const comparable = (r: { entry: any }) => read.characterScript !== null
    && read.characterScript === scriptOf(String(r.entry.name || ''));

  const nameEvidenced = ranked.filter(r => r.charScore >= 0.55 || r.titleScore >= 0.55).slice(0, 5).map(toCandidate);
  if (!read.normalizedNumber) return none('no_card_number', nameEvidenced);

  const numbered = ranked.filter(r => r.reasons.includes('cardNumber exact'));
  if (numbered.length === 0) {
    // Fail closed on any number the catalog does not hold. A one-character-off number
    // with the same character is NOT promoted to a match: one holomem has many cards per
    // set, so a valid-but-uncovered card (or a new set) would be fabricated into a
    // sibling. Known OCR confusions (O/0, l/I/1, dash variants) are already folded in
    // normalizeCardNumber; near-number cards with name evidence stay correction options.
    const near = ranked.filter(r => r.reasons.some(x => x.startsWith('cardNumber fuzzy')) && r.charScore >= 0.55);
    const suggestions = [...near, ...ranked.filter(r => !near.includes(r) && (r.charScore >= 0.55 || r.titleScore >= 0.55))]
      .slice(0, 5).map(toCandidate);
    return none('number_not_in_database', suggestions);
  }

  // A number that names someone else than the character read is a misread, not a match.
  if (read.hasCharacter && numbered.every(r => comparable(r) && r.charScore < 0.55)
      && !(read.hasTitle && numbered.some(r => r.titleScore >= 0.55))) {
    return none('number_name_conflict', numbered.slice(0, 5).map(toCandidate));
  }

  const evidence = (r: { reasons: string[] }) => r.reasons.filter(x => x !== 'bloom/type');
  if (numbered.length === 1) {
    return { status: 'matched', best: toCandidate(numbered[0]), printingResolved: true, evidence: evidence(numbered[0]), alternatives: [] };
  }
  const byRarity = read.rarity ? numbered.filter(r => normalizeText(r.entry.rarity).toUpperCase() === read.rarity) : [];
  if (byRarity.length === 1) {
    const others = numbered.filter(r => r !== byRarity[0]).slice(0, 4).map(toCandidate);
    return { status: 'matched', best: toCandidate(byRarity[0]), printingResolved: true, evidence: evidence(byRarity[0]), alternatives: others };
  }
  const printings = numbered.slice(0, 8).map(toCandidate);
  return { status: 'identity_only', best: printings[0], printingResolved: false, evidence: evidence(numbered[0]), alternatives: printings };
}


// Build a ranked candidate list (top N) from scored entries, deduped by cardNumber.
// Each candidate carries its own confidence relative to the best score so the client
// can show a "top 3-5 候選" picker for mid/low-confidence scans.
function buildCandidates(
  scored: { entry: any; score: number }[],
  topConfidence: number,
  limit = 5,
  storeMvp = false,
) {
  const bestScore = scored.length > 0 ? scored[0].score : 0;
  const seen = new Set<string>();
  const out: any[] = [];
  for (const { entry, score } of scored) {
    const key = (entry.cardNumber || entry.name || '').toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const rel = bestScore > 0 ? score / bestScore : 0;
    const confidence = Math.max(0.15, Math.min(topConfidence, rel * topConfidence));
    out.push({ ...fmt(entry, storeMvp), confidence: Math.round(confidence * 100) / 100 });
    if (out.length >= limit) break;
  }
  return out;
}

// ── Main handler ──
export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204 });
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405);

  // A parse failure's message can quote the request body (i.e. image data), so it is
  // never echoed or logged.
  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ success: false, code: 'INVALID_REQUEST_BODY', error: '請求格式錯誤' }, 400);
  }

  try {
    const images = Array.isArray(body?.images) ? body.images : [body?.image];
    // Image rules run before the provider is resolved: a malformed or oversized image is
    // the client's fault on every deployment and must not cost a vision call.
    const imageCheck = validateRecognitionImages(images);
    if (!imageCheck.ok) {
      return json({ success: false, code: imageCheck.code, error: IMAGE_REJECTION_MESSAGES[imageCheck.code] }, 400);
    }
    // Store MVP clients send `storeMvp: true` so forbidden fields never cross the wire.
    const storeMvp = body?.storeMvp === true;

    // A frame too small to hold a legible card number never reaches the model: it would
    // answer with an invented one rather than NONE. 404 keeps this a photo-level outcome,
    // so the client asks for a closer shot instead of reporting a broken backend.
    //
    // The provider check comes first on purpose: a deployment that cannot recognise
    // anything owes the user a 503 even for a bad photo. Answering "retake it" on an
    // unprovisioned backend is exactly the DIC-1013 defect. (The 400 image-contract
    // check above is not a photo-quality verdict: a well-formed photo always passes it,
    // including the deploy probe's 64×89 PNG.)
    if (resolveAdapters().length > 0 && isBelowLegibleResolution(images)) {
      return json({
        success: false,
        error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝',
        candidates: [],
      }, 404);
    }

    const [{ reply, provider, model }, cards] = await Promise.all([
      callVision(images, req.signal),
      getDatabase(),
    ]);
    if (!reply) return json({ success: false, error: '服務回傳空回應', debug: { provider, model } }, 502);
    if (!cards) return json({ success: false, error: '資料庫載入失敗' }, 502);

    const extracted = {
      characterName: parseField(reply, 'CHARACTER'),
      hp: parseField(reply, 'HP'),
      rarity: parseField(reply, 'RARITY'),
      bloom: parseField(reply, 'BLOOM_LEVEL'),
      cardNumberRaw: parseField(reply, 'CARD_NUMBER'),
      cardTitle: parseField(reply, 'TITLE'),
      // Diagnostics only (local scan log); not used for ranking.
      setCode: parseField(reply, 'SET'),
      language: parseField(reply, 'LANGUAGE'),
    };
    const ranking = rankCandidates(cards, extracted, storeMvp);
    const { match } = ranking;
    // Sanitised diagnostics only: what was read and why, never the image.
    // Wire copy of what was read: each value through the same safe-text rule as the trace
    // (unsafe → ''), bounded — the ranking above used the parsed values.
    const debug = {
      provider,
      model,
      extracted: {
        characterName: safeCardText('name', extracted.characterName) ?? '',
        hp: /^\d{1,4}$/.test(extracted.hp) ? extracted.hp : '',
        rarity: safeCardText('rarity', extracted.rarity) ?? '',
        bloom: safeCardText('title', extracted.bloom) ?? '',
        // As received (safe card-code text only), so normalisation stays diagnosable.
        cardNumberRaw: receivedCardText('number', extracted.cardNumberRaw) ?? '',
        cardTitle: safeCardText('title', extracted.cardTitle) ?? '',
        setCode: safeCardText('set', extracted.setCode) ?? '',
        language: safeCardText('language', extracted.language) ?? '',
      },
      normalizedCardNumber: ranking.normalizedCardNumber,
      reason: ranking.reason,
      matchStatus: match.status,
      matchReason: match.reason ?? null,
    };
    // Typed, allowlisted trace (src/services/scanTrace): per-field state from the
    // expected reply lines, top candidates with evidence, verdict, rejection. Never the
    // raw reply. requestId is random per request; backendSha is the deployed commit
    // when Vercel provides it as 40 hex, else null. No other env is read.
    const trace = buildRecognitionTrace({
      reply,
      requestId: newRequestId(),
      backendSha: process.env.VERCEL_GIT_COMMIT_SHA,
      model,
      candidates: ranking.candidates,
      candidateCount: ranking.candidateCount,
      verdict: { status: match.status, reason: match.reason ?? null },
    });
    const matchWire = {
      status: match.status,
      printingResolved: match.printingResolved,
      reason: match.reason ?? null,
      evidence: match.evidence,
      alternatives: match.alternatives,
      // Deterministic rule score of the best card (diagnostics only — not a probability).
      ruleScore: typeof (match.best as any)?.score === 'number' ? (match.best as any).score : null,
    };

    // No valid match is an explicit failure — never a list of filler candidates.
    // `candidates: []` keeps released clients (which open a picker on any list) honest;
    // evidence-backed suggestions travel in match.alternatives for the new UI.
    if (match.status === 'no_match') {
      return json({ success: false, error: '無法辨識此卡牌', debug, trace, candidates: [], match: matchWire }, 404);
    }

    // Card known, printing not: no price may be shown for it. Released clients see
    // the legacy low-confidence picker shape; new clients show the identity first.
    if (match.status === 'identity_only') {
      return json({
        success: false,
        lowConfidence: true,
        error: '已辨識卡牌，但無法確認版本，請選擇手上的版本',
        card: match.best,
        candidates: match.alternatives,
        confidence: ranking.confidence,
        reason: ranking.reason,
        debug,
        trace,
        match: matchWire,
      }, 200);
    }

    return json({
      success: true,
      card: match.best,
      matchMethod: match.evidence.join(', '),
      confidence: ranking.confidence,
      candidates: [match.best, ...match.alternatives],
      reason: ranking.reason,
      debug,
      trace,
      match: matchWire,
    });
  } catch (e: any) {
    if (e instanceof ClientAbortedError) {
      // Nobody is listening; a stable code for logs / tests, no body content.
      return json({ success: false, code: 'CLIENT_ABORTED', error: '請求已取消' }, 499);
    }
    if (e instanceof RecognitionUnavailableError) {
      // Operator-facing detail (which variable is missing) stays in the runtime log;
      // the wire only carries the stable code + a user-safe message.
      console.error(`[recognize-card] recognition unavailable: ${e.message}`);
      return json({
        success: false,
        code: RECOGNITION_UNAVAILABLE_CODE,
        error: '辨識服務暫時無法使用，請稍後再試或改用手動搜尋',
      }, 503);
    }
    // Internal error text can quote request or upstream detail; log the type only.
    console.error(`[recognize-card] handler failed: ${e?.name || 'Error'}`);
    return json({ success: false, error: '辨識服務發生錯誤，請稍後再試' }, 502);
  }
}
