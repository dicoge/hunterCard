/**
 * @version 7
 * recognize-card.ts — Gemini Vision + deterministic candidate ranking for Hololive TCG cards.
 *
 * Accepts one or more image data URIs. The web scanner sends both a full-frame image
 * and a scan-area crop so the model can read tiny bottom-edge card numbers without
 * losing whole-card context.
 *
 * The vision call is served by the first working provider adapter: Google direct
 * (GEMINI_API_KEY), then OpenRouter (OPENROUTER_API_KEY), then 503.
 */

export const config = { runtime: 'edge' };

const GEMINI_MODEL = 'gemini-2.5-flash';
// Same underlying model as the Google-direct leg, reached through OpenRouter, so a
// fallback scan ranks identically to a primary one (DIC-1019).
const OPENROUTER_MODEL = 'google/gemini-2.5-flash';
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const VISION_MAX_TOKENS = 180;

// The scanner abandons the request after RECOGNITION_REQUEST_TIMEOUT_MS (15s, see
// src/services/recognitionOutcome). Every provider leg shares ONE budget sized below
// that, leaving room for the JSON round trip and ranking — otherwise a sequential
// fallback "succeeds" server-side after the caller has already aborted, which is a
// fallback the user can never receive (DIC-1020 CR).
export const VISION_TOTAL_BUDGET_MS = 11000;
// A leg that still has a fallback behind it may not spend the whole budget: it is
// capped, and must leave at least VISION_FALLBACK_RESERVE_MS for the next provider.
const VISION_PRIMARY_CAP_MS = 6500;
const VISION_FALLBACK_RESERVE_MS = 4500;
// Below this there is no point opening a connection at all.
const VISION_MIN_LEG_MS = 1500;
const DATABASE_URL = 'https://holocard-hunter.vercel.app/data/database.json';
const AUTO_ACCEPT_CONFIDENCE = 0.82;

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

const prefixMap: Record<string, string> = {
  np: 'hbp', bp: 'hbp', sd: 'hsd', pr: 'hpr',
  sp: 'hsp', ocg: 'hocg', pc: 'hpc', cs: 'hcs',
  co: 'hco', wf: 'hwf', ys: 'hys', ent: 'hent', bd: 'hbd',
};

export function normalizeCardNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let cleaned = raw.trim().replace(/^['"`\s]+|['"`\s]+$/g, '').replace(/\.$/, '').toLowerCase();
  if (!cleaned || cleaned === 'none' || cleaned === 'unknown') return null;
  cleaned = cleaned
    .normalize('NFKC')
    .replace(/[oO〇]/g, '0')
    .replace(/[lI｜]/g, '1')
    .replace(/[－‐‑‒–—―−_\s]+/g, '-');
  const m = cleaned.match(/(h?[a-z]{2,3}\d{0,2}-?\d{1,3})/i);
  if (!m) return null;
  let r = m[1].replace(/-+/g, '-');
  if (!r.includes('-')) r = r.replace(/(\d)(\d{2,3})$/, '$1-$2');
  if (!r.startsWith('h')) {
    const p = r.slice(0, 2), rest = r.slice(2);
    r = (prefixMap[p] || 'h' + p) + rest;
  }
  return r;
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

function parseField(reply: string, field: string): string {
  const match = reply.match(new RegExp(`^${field}:\\s*(.+)$`, 'im'));
  const value = match ? match[1].trim() : '';
  return /^(none|unknown|n\/a|-)?$/i.test(value) ? '' : value;
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
  let price = entry.sellPrice;
  if (entry.rarity === 'SEC' && entry.prices?.length > 0) {
    price = Math.max(...entry.prices.map((p: any) => p.sellPrice || 0));
  }
  const base = {
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

function dataUriToGeminiPart(image: string) {
  const match = image.match(/^data:([^;]+);base64,(.+)$/);
  return {
    inline_data: {
      mime_type: match?.[1] || 'image/jpeg',
      data: match?.[2] || image,
    },
  };
}

const visionPrompt = `You are identifying a real Hololive OFFICIAL CARD GAME card from camera photos.

You may receive two images: (1) full card/context and (2) a cropped scan area. Use both. Ignore phone UI overlays, scanner borders, reflections, and background.

Critical reading order:
1. CARD_NUMBER: tiny text near the bottom edge/bottom-right. Examples: hBP01-001, hBP08-024, hSD13-014, hBD24-007. Preserve prefix and digits exactly.
2. CHARACTER: main character/holomem name, usually top area.
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
TITLE: [title or NONE]`;

type VisionAdapter = {
  provider: string;
  model: string;
  request: (images: string[], timeoutMs: number) => Promise<Response>;
  extract: (data: any) => string;
};

// The key travels in x-goog-api-key rather than the ?key= query parameter: a URL is the
// part of a request that leaks into logs, error strings and referrers, and this handler
// must never expose a provider key value (DIC-1019).
const googleAdapter = (apiKey: string): VisionAdapter => ({
  provider: 'gemini',
  model: GEMINI_MODEL,
  request: (images, timeoutMs) => fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{
        role: 'user',
        parts: [{ text: visionPrompt }, ...images.map(dataUriToGeminiPart)],
      }],
      generationConfig: { temperature: 0, maxOutputTokens: VISION_MAX_TOKENS },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }),
  extract: (data) => (data?.candidates?.[0]?.content?.parts || [])
    .map((part: any) => part.text || '').join('\n').trim(),
});

const openRouterAdapter = (apiKey: string): VisionAdapter => ({
  provider: 'openrouter',
  model: OPENROUTER_MODEL,
  request: (images, timeoutMs) => fetch(OPENROUTER_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
      'HTTP-Referer': 'https://holohunter.dicoge.com',
      'X-Title': 'HoloHunter',
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: visionPrompt },
          ...images.map(url => ({ type: 'image_url', image_url: { url } })),
        ],
      }],
      temperature: 0,
      max_tokens: VISION_MAX_TOKENS,
    }),
    signal: AbortSignal.timeout(timeoutMs),
  }),
  extract: (data) => String(data?.choices?.[0]?.message?.content || '').trim(),
});

function readKey(name: string): string | null {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

// Runtime priority: Google direct, then OpenRouter, then nothing (→ 503). Both keys
// present is not ambiguous — Google direct always wins, and OpenRouter is only reached
// when Google is unconfigured or its leg fails.
function resolveAdapters(): VisionAdapter[] {
  const adapters: VisionAdapter[] = [];
  const geminiKey = readKey('GEMINI_API_KEY');
  if (geminiKey) adapters.push(googleAdapter(geminiKey));
  const openRouterKey = readKey('OPENROUTER_API_KEY');
  if (openRouterKey) adapters.push(openRouterAdapter(openRouterKey));
  return adapters;
}

async function callVision(images: string[]): Promise<{ reply: string; provider: string; model: string }> {
  const imageList = images.filter(Boolean).slice(0, 2).map(img => img.startsWith('data:') ? img : `data:image/jpeg;base64,${img}`);
  const adapters = resolveAdapters();
  if (adapters.length === 0) throw new RecognitionUnavailableError('no vision provider key configured');

  const deadline = Date.now() + VISION_TOTAL_BUDGET_MS;
  let lastError: Error | null = null;
  for (let i = 0; i < adapters.length; i++) {
    const adapter = adapters[i];
    const remaining = deadline - Date.now();
    // The last leg may use everything that is left; anything before it is capped and has
    // to hand the reserve on, so its timeout can never starve the fallback behind it.
    const legBudget = i === adapters.length - 1
      ? remaining
      : Math.min(VISION_PRIMARY_CAP_MS, remaining - VISION_FALLBACK_RESERVE_MS);
    if (legBudget < VISION_MIN_LEG_MS) {
      lastError = lastError || new Error('vision budget exhausted');
      console.error(`[recognize-card] provider ${adapter.provider} skipped: vision budget exhausted`);
      continue;
    }

    // Upstream bodies and raw transport errors never escape this block: a failing leg is
    // reduced to provider + HTTP status before it can reach a client response or a log.
    let reply: string;
    try {
      const res = await adapter.request(imageList, legBudget);
      if (!res.ok) throw new Error(`${adapter.provider} API error (${res.status})`);
      reply = adapter.extract(await res.json());
    } catch (e: any) {
      lastError = e instanceof Error && /^\w+ API error \(\d+\)$/.test(e.message)
        ? e
        : new Error(`${adapter.provider} API request failed`);
      console.error(`[recognize-card] provider ${adapter.provider} failed: ${lastError.message}`);
      continue;
    }
    // An empty reply is a failed leg too, but the last provider's empty answer still has
    // to surface as the existing "empty response" 502 rather than a transport error.
    if (reply) return { reply, provider: adapter.provider, model: adapter.model };
    lastError = null;
    console.error(`[recognize-card] provider ${adapter.provider} returned an empty reply`);
  }
  if (lastError) throw lastError;
  return { reply: '', provider: adapters[adapters.length - 1].provider, model: adapters[adapters.length - 1].model };
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

    const prefix = entryNumber.split('-')[0];
    if (String(entry.series || '').toLowerCase() === prefix) score += 1.5;
    else if (String(entry.series || '').toLowerCase() === 'hpr') score -= 1;

    return { entry, score, reasons };
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

  return {
    normalizedCardNumber: normalizedNumber,
    confidence: Math.round(confidence * 100) / 100,
    reason: ranked[0]?.reasons.join(', ') || 'no candidate',
    candidates,
  };
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

  try {
    const body = await req.json();
    const images = Array.isArray(body.images) ? body.images : [body.image];
    if (!images[0] || typeof images[0] !== 'string') return json({ success: false, error: 'Invalid image' }, 400);
    // Store MVP clients send `storeMvp: true` so forbidden fields never cross the wire.
    const storeMvp = body?.storeMvp === true;

    // A frame too small to hold a legible card number never reaches the model: it would
    // answer with an invented one rather than NONE. 404 keeps this a photo-level outcome,
    // so the client asks for a closer shot instead of reporting a broken backend.
    //
    // The provider check comes first on purpose: a deployment that cannot recognise
    // anything owes the user a 503 even for a bad photo. Answering "retake it" on an
    // unprovisioned backend is exactly the DIC-1013 defect.
    if (resolveAdapters().length > 0 && isBelowLegibleResolution(images)) {
      return json({
        success: false,
        error: '照片解析度太低，無法讀取卡號，請靠近卡片重新拍攝',
        candidates: [],
      }, 404);
    }

    const [{ reply, provider, model }, cards] = await Promise.all([
      callVision(images),
      getDatabase(),
    ]);
    if (!reply) return json({ success: false, error: '服務回傳空回應', debug: { provider, model } }, 502);
    if (!cards) return json({ success: false, error: '資料庫載入失敗', raw: reply }, 502);

    const extracted = {
      characterName: parseField(reply, 'CHARACTER'),
      hp: parseField(reply, 'HP'),
      rarity: parseField(reply, 'RARITY'),
      bloom: parseField(reply, 'BLOOM_LEVEL'),
      cardNumberRaw: parseField(reply, 'CARD_NUMBER'),
      cardTitle: parseField(reply, 'TITLE'),
    };
    const ranking = rankCandidates(cards, extracted, storeMvp);
    const debug = {
      provider,
      model,
      rawModelOutput: reply,
      extracted,
      normalizedCardNumber: ranking.normalizedCardNumber,
      candidates: ranking.candidates,
      confidence: ranking.confidence,
      reason: ranking.reason,
    };

    if (ranking.candidates.length === 0) {
      return json({ success: false, error: '無法辨識此卡牌', raw: reply, debug, candidates: [] }, 404);
    }

    const best = ranking.candidates[0];
    if (ranking.confidence < AUTO_ACCEPT_CONFIDENCE) {
      return json({
        success: false,
        lowConfidence: true,
        error: '辨識信心不足，請從候選卡中選擇',
        raw: reply,
        candidates: ranking.candidates,
        confidence: ranking.confidence,
        reason: ranking.reason,
        debug,
      }, 200);
    }

    return json({
      success: true,
      card: best,
      matchMethod: ranking.reason,
      confidence: ranking.confidence,
      candidates: ranking.candidates,
      reason: ranking.reason,
      raw: reply,
      debug,
    });
  } catch (e: any) {
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
    return json({ success: false, error: `Error: ${e.message}` }, 502);
  }
}
