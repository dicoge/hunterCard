/**
 * 卡牌識別服務
 * Card Recognition Service
 *
 * 用於識別掃描的卡牌並返回價格資訊
 * 資料來源：database.json（統一資料庫）
 */

import { recognizeCardNumber } from './webOcr';
import { preprocessCardImage } from './imagePreprocessor';
import { mapApiCardToCardInfo } from '../utils/apiCardMapper';
import { stripDisabledCardFields } from '../utils/cardReleaseFilter';
import { releaseCardFlags, STORE_MVP } from '../config/releaseFlags';
import { PRODUCTION_ORIGIN } from '../config/apiOrigin';
import {
  isRecognitionInfrastructureFailure,
  RECOGNITION_REQUEST_TIMEOUT_MS,
  RECOGNITION_UNAVAILABLE_MESSAGE,
} from './recognitionOutcome';
import {
  buildRecognitionDataUrl,
  validateRecognitionDataUrl,
  validateRecognitionImages,
  type RecognitionImageErrorCode,
} from './recognitionImagePolicy';
import { SCAN_RUNTIME } from './scanRuntime';
import { findCardNumberTokens } from '../utils/cardNumberToken';
import { matchFromWire } from './scanPresentation';

// ── 類型定義 ──

export interface CardPrice {
  name: string;
  sellPrice: number | null;
  rarity?: string;
  buyPrice?: number | null; // 對齊到此版本的店家收購價（DIC-856）；對不到為 null
}

export interface CardVariant {
  series: string;
  seriesName: string;  // Human-readable series name
  sellPrice: number | null;
  prices: CardPrice[];
  rarity: string;
}

export interface CardInfo {
  id: string;
  name: string;
  nameZh?: string;       // Chinese name (if available)
  cardNumber: string;
  type: string;
  rarity: string;
  series: string;
  sellPrice: number | null;  // null = 無交易記錄
  buyPrice?: number | null;   // 店家收購價（賣出可得）
  yuyuName: string;
  color: string;
  imageUrl: string;
  prices?: CardPrice[];       // Detailed price variants from database
  variants?: CardVariant[];   // Same cardNumber in different series
  priceHistory?: Record<string, number>;
  ytStats?: any;              // YouTube 成員數據（訂閱/成長/觀看）
  normalized?: any;
}

/** A single ranked candidate returned for mid/low-confidence scans. */
export interface RecognizedCandidate {
  card: CardInfo;
  confidence: number; // 0-1
}

export interface RecognitionResult {
  success: boolean;
  card?: CardInfo;
  suggestions?: CardInfo[];
  error?: string;
  confidence?: number;
  reason?: string;
  raw?: string;
  debug?: any;
  lowConfidence?: boolean;
  /** The recognition backend failed (unprovisioned or 5xx) — not a card that failed to match. */
  serviceUnavailable?: boolean;
  /** Top 3-5 alternative matches for the candidate-confirmation UI. */
  candidates?: RecognizedCandidate[];
  /** The caller aborted (screen left / scan superseded). Nothing may be committed. */
  cancelled?: boolean;
  /** The recognition request ran past RECOGNITION_REQUEST_TIMEOUT_MS and was aborted. */
  timedOut?: boolean;
  /** The photo was refused locally by recognitionImagePolicy and was NOT uploaded. */
  imageRejected?: RecognitionImageErrorCode;
  /**
   * The server's explicit verdict (scan best-match fix 2026-10-15). `matched` = one
   * printing proven by the photo; `identity_only` = card known, printing (and price)
   * not; `no_match` = no valid answer, with optional evidence-backed alternatives.
   */
  match?: ScanMatch;
}

export interface ScanMatch {
  status: 'matched' | 'identity_only' | 'no_match';
  printingResolved: boolean;
  reason?: 'no_evidence' | 'no_card_number' | 'number_not_in_database' | 'number_name_conflict' | null;
  /** Evidence tokens such as 'cardNumber exact', 'rarity' — never a probability. */
  evidence: string[];
  alternatives: RecognizedCandidate[];
  /** Deterministic ranking score of the best card — diagnostics only, never shown as %. */
  ruleScore?: number | null;
}

/** How a photo reaches recognizeCardFromImage. */
export interface RecognizeImageOptions {
  /**
   * Native only: the capture's raw base64 (`takePictureAsync` / `launchImageLibraryAsync`
   * with `base64: true`). The uri alone is a device-local path and is never uploaded.
   */
  base64?: string | null;
  /** Native only: the scan-frame crop's raw base64 (nativeScanCapture). Sent second. */
  cropBase64?: string | null;
  /** Aborts the upload; the result then comes back `cancelled`. */
  signal?: AbortSignal;
}

// ── 資料庫快取 ──

interface DatabaseRecord {
  id: string;
  name: string;
  type: string;
  rarity: string;
  series: string;
  sellPrice: number | null;
  yuyuName: string;
  color: string;
  localImage?: string;
  officialImage?: string;
  prices?: any[];
  priceHistory?: Record<string, number>;
  [key: string]: any;
}

interface DatabaseSchema {
  cards: Record<string, DatabaseRecord>;
  totalCards: number;
  lastUpdated: string;
}

let cachedDb: CardInfo[] | null = null;
let dbFetchPromise: Promise<CardInfo[]> | null = null;
let seriesNamesCache: Record<string, string> | null = null;

/**
 * 載入 series-names.json 並快取
 */
async function loadSeriesNames(): Promise<Record<string, string>> {
  if (seriesNamesCache) return seriesNamesCache;
  try {
    const res = await fetch('/data/series-names.json');
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    seriesNamesCache = await res.json();
    return seriesNamesCache!;
  } catch (e: any) {
    console.error('[cardRecognition] Failed to load series names:', e.message);
    return {};
  }
}

/**
 * 載入 database.json 並轉換為 CardInfo 陣列
 * 同一 cardNumber 在不同系列時，自動合併為一筆並以 variants 列出
 */
export async function loadAllCards(): Promise<CardInfo[]> {
  if (cachedDb) return cachedDb;
  if (dbFetchPromise) return dbFetchPromise;

  dbFetchPromise = (async () => {
    try {
      const res = await fetch('/data/database.json');
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const db: DatabaseSchema = await res.json();
      const cards = db.cards || {};

      // Each compound-key entry (e.g. hBP04-005_hBP04, hBP04-005_ent07) is a separate CardInfo
      // This preserves correct series/category filtering unlike grouped-by-cardNumber
      const cardFlags = releaseCardFlags();
      const result: CardInfo[] = Object.values(cards).map(entry => stripDisabledCardFields({
        // The compound catalog key (hBP01-024_hBP01_C_hBP01-024_C) IS the
        // printing's identity. This used to be flattened to the bare cardNumber,
        // which made `id` non-unique across the 8 rows that share hBP01-024 and
        // turned every `find(c => c.id === cardNumber)` below into "whichever
        // printing happens to be first" — see resolvePrintingByCardNumber
        // (DIC-1325).
        id: entry.id || (entry as any).cardNumber || '',
        name: entry.name || '',
        nameZh: (entry as any).nameZh || '',
        cardNumber: (entry as any).cardNumber || entry.id || '',
        type: entry.type || '',
        rarity: entry.rarity || '',
        series: entry.series || '',
        sellPrice: entry.sellPrice != null && entry.sellPrice > 0 ? entry.sellPrice : null,
        buyPrice: (entry as any).buyPrice ?? null,
        yuyuName: entry.yuyuName || '',
        color: entry.color || '',
        imageUrl: entry.officialImage || entry.localImage || '',
        prices: (entry as any).prices || [],
        priceHistory: (entry as any).priceHistory || {},
        ytStats: (entry as any).ytStats ?? null,
      }, cardFlags));

      cachedDb = result;
      return result;
    } catch (e: any) {
      console.error('[cardRecognition] Failed to load database:', e.message);
      dbFetchPromise = null;
      return [];
    }
  })();

  return dbFetchPromise;
}

// ── 卡號 → 版本解析（DIC-1325 exact-printing 界線）──

/**
 * Resolve a cardNumber to ONE printing, or refuse.
 *
 * A cardNumber is not an identity: hBP01-024 has 8 catalog rows, and their sale
 * prices genuinely disagree (ent07/HR JPY 50, hBP01/C JPY 120, hPR/P unproven).
 * The recovery paths used to answer this with `find(c => c.id === cardNumber)`,
 * which returned whichever row the catalog happened to list first and presented
 * its price as the scanned card's exact price at confidence 0.9.
 *
 * When the evidence names only a cardNumber and several printings carry it,
 * there is no basis for choosing one, so this returns `ambiguous` and the caller
 * must surface the card WITHOUT a price and let the user pick the printing.
 * Quoting a sibling's number would be the cross-printing fallback the product
 * forbids (DIC-856 / DIC-1319).
 */
export type PrintingResolution =
  | { status: 'unique'; card: CardInfo }
  | { status: 'ambiguous'; cardNumber: string; printings: CardInfo[] }
  | { status: 'none' };

const flatten = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

export function resolvePrintingByCardNumber(
  allCards: CardInfo[],
  query: string,
  { fuzzy = false }: { fuzzy?: boolean } = {},
): PrintingResolution {
  const q = flatten(query || '');
  if (!q) return { status: 'none' };

  let matches = allCards.filter(c => flatten(c.cardNumber) === q);

  // `fuzzy` used to accept substring overlaps (q.includes(n) / n.includes(q)), which
  // turned a truncated or extended number into a different real card (CR 2026-10-15
  // P2_2). Numbers are now whole-token parsed upstream, so only exact equality counts.
  void fuzzy;

  if (matches.length === 0) return { status: 'none' };
  if (matches.length === 1) return { status: 'unique', card: matches[0] };
  return { status: 'ambiguous', cardNumber: matches[0].cardNumber, printings: matches };
}

/**
 * The card to show when only the cardNumber is known: shared identity, and
 * deliberately NO price. `sellPrice: null` is the same "no proven price" state
 * the UI already renders as 尚無交易, so this needs no new UI branch.
 */
export function ambiguousPrintingCard(printings: CardInfo[]): CardInfo {
  const base = printings[0];
  return {
    ...base,
    // Identity of the NUMBER, not of any one printing.
    id: base.cardNumber,
    series: '',
    rarity: '',
    sellPrice: null,
    prices: [],
    buyPrice: null,
    priceHistory: {},
  };
}

/**
 * Build the printing chooser. Each candidate is a real printing showing its OWN
 * price, which is what makes this a resolution step rather than a guess. Equal
 * confidence, because nothing in the evidence prefers one printing.
 */
export function ambiguousPrintingResult(res: { cardNumber: string; printings: CardInfo[] }): RecognitionResult {
  return {
    success: true,
    card: ambiguousPrintingCard(res.printings),
    lowConfidence: true,
    reason: 'ambiguous-printing',
    candidates: res.printings.map(card => ({ card, confidence: 1 / res.printings.length })),
  };
}

// ── 文字相似度 ──

/**
 * 正規化日文文字：全形轉半形、統一空白、移除常見 OCR 雜訊
 */
function normalizeText(text: string): string {
  let t = text.normalize('NFKC'); // 全形→半形
  t = t.replace(/[－‐-―−－]/g, '-'); // 統一連字號
  t = t.replace(/[　　]+/g, ' '); // 全形空白→半形
  t = t.replace(/[・･]+/g, ''); // 移除中黑點
  t = t.replace(/[→⇒]/g, ''); // 移除箭頭
  // 常見 OCR 誤認
  t = t.replace(/[oO〇]/g, '0')    // O→0（用於卡號）
       .replace(/[lI｜]/g, '1');   // lI→1（用於卡號）
  return t.trim();
}

/**
 * 計算兩個字符串的相似度 (Levenshtein 距離)
 */
function calculateSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase().replace(/[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, '');
  const s2 = str2.toLowerCase().replace(/[^\w\u3040-\u309f\u30a0-\u30ff\u4e00-\u9faf]/g, '');

  if (s1.length === 0 || s2.length === 0) return 0;

  const matrix: number[][] = [];
  for (let i = 0; i <= s1.length; i++) matrix[i] = [i];
  for (let j = 0; j <= s2.length; j++) matrix[0][j] = j;

  for (let i = 1; i <= s1.length; i++) {
    for (let j = 1; j <= s2.length; j++) {
      const cost = s1[i - 1] === s2[j - 1] ? 0 : 1;
      matrix[i][j] = Math.min(
        matrix[i - 1][j] + 1,
        matrix[i][j - 1] + 1,
        matrix[i - 1][j - 1] + cost,
      );
    }
  }

  const maxLen = Math.max(s1.length, s2.length);
  return 1 - matrix[s1.length][s2.length] / maxLen;
}

/**
 * 從名稱中提取關鍵字
 */
function extractKeywords(name: string): string[] {
  const cleanName = name.replace(/[（(][^)）]*[)）]/g, '');
  return cleanName.split(/[\s　]+/).filter(k => k.length > 0);
}

/**
 * 檢查關鍵字是否匹配
 */
function keywordsMatch(cardKeywords: string[], searchKeywords: string[]): number {
  let matches = 0;
  for (const search of searchKeywords) {
    for (const card of cardKeywords) {
      if (card.includes(search) || search.includes(card)) {
        matches++;
        break;
      }
    }
  }
  return searchKeywords.length > 0 ? matches / searchKeywords.length : 0;
}

// ── 主辨識邏輯 ──

/**
 * 從雜亂的 OCR 文字中提取可能的卡號（如 hBP04-001, hSD01-003 等）
 */
function extractCardIds(text: string): string[] {
  // Whole-token parse only (src/utils/cardNumberToken): extra digits / letters fail
  // closed instead of being trimmed into a different, real card number.
  // Raw text: the tokenizer applies the O/l → 0/1 confusions to digit groups only.
  return findCardNumberTokens(text);
}

/**
 * 正規化 OCR 輸出：分行清理、過濾雜訊、提取有意義的文字區塊
 */
function cleanOcrText(rawText: string): string[] {
  const text = rawText.normalize('NFKC');
  // 分行處理
  const lines = text.split(/[\n\r]+/).map(l => l.trim()).filter(l => l.length > 2);
  // 過濾常見的卡牌版面雜訊（HP、屬性、效果文字等）
  const noisePatterns = [
    /^(HP|LP|DMG|AP|DP|ATK|DEF)\s*\d+/i,
    /^[\d,，]+円$/,
    /^【.*】$/,
    /^(この|自分の|相手の|ターン)/,
    /^(白|黒|赤|青|黃|緑|紫|茶|無|color)/i,
    /^(white|black|red|blue|green|yellow|purple|brown)/i,
    /^(Oshi|推し|ホロメン|応援|サポート|バトル|ブースト)/,
    /^\d+[%％]/,
    /^(コスト|cost)/i,
  ];
  const meaningful = lines.filter(line =>
    !noisePatterns.some(p => p.test(line))
  );
  // 優先找行內包含卡號或看起來像名稱的
  const withId = meaningful.filter(l => /[a-z]{2,}\d/.test(l));
  const shortName = meaningful.filter(l => l.length >= 2 && l.length <= 30 && /[぀-ゟ゠-ヿ一-龯]/.test(l));
  // 回傳優先順序：有卡號的行 > 含日文的短行 > 其他
  return [...new Set([...withId, ...shortName, ...meaningful])];
}

/** Map a raw API card payload into the app's CardInfo shape (single shared mapper). */
function mapApiCard(apiCard: any): CardInfo {
  return stripDisabledCardFields(mapApiCardToCardInfo(apiCard), releaseCardFlags());
}

/** Map the API's raw candidate list into RecognizedCandidate[]. */
function mapApiCandidates(raw: any): RecognizedCandidate[] | undefined {
  if (!Array.isArray(raw) || raw.length === 0) return undefined;
  return raw
    .filter(c => c && c.cardNumber)
    .map(c => ({
      card: mapApiCard(c),
      confidence: typeof c.confidence === 'number' ? c.confidence : 0,
    }));
}

/**
 * The image to upload, as a validated data URL — or why there is none.
 *
 * Native: the capture's own base64, typed from its signature bytes. Web: the canvas
 * preprocessor's data URL. Either way the result has passed the same rules the handler
 * enforces, so a file:// / content:// path or a bare string is never sent.
 */
async function recognitionPayload(
  imageUri: string,
  options: RecognizeImageOptions,
): Promise<{ ok: true; images: string[] } | { ok: false; code: RecognitionImageErrorCode }> {
  if (SCAN_RUNTIME === 'native') {
    const built = buildRecognitionDataUrl(options.base64);
    const crop = options.cropBase64 ? buildRecognitionDataUrl(options.cropBase64) : null;
    // [context photo, frame crop] like the web scanner; if the pair would exceed the
    // request cap the crop (the card itself) goes alone; without a crop, the photo.
    if (built.ok && crop?.ok && validateRecognitionImages([built.dataUrl, crop.dataUrl]).ok) {
      return { ok: true, images: [built.dataUrl, crop.dataUrl] };
    }
    if (crop?.ok) return { ok: true, images: [crop.dataUrl] };
    return built.ok ? { ok: true, images: [built.dataUrl] } : built;
  }
  const processed = await preprocessCardImage(imageUri);
  const check = validateRecognitionDataUrl(processed);
  return check.ok ? { ok: true, images: [processed] } : check;
}

function mapMatch(raw: any): ScanMatch | undefined {
  return matchFromWire(raw, mapApiCandidates);
}

/**
 * Try to recognize card via server-side API (our backend → Google Gemini).
 * Falls back gracefully without throwing. Never logs the image, the payload or the
 * response body.
 */
async function recognizeViaApi(imageUri: string, options: RecognizeImageOptions = {}): Promise<RecognitionResult> {
  if (options.signal?.aborted) return { success: false, cancelled: true, error: '' };

  const payload = await recognitionPayload(imageUri, options);
  // Preparing the payload is async (web canvas re-encode; a microtask boundary on
  // native), so a cancel can land while it runs — before any listener exists. Re-check
  // here: a cancelled scan never uploads, never falls back to OCR, never charges.
  if (options.signal?.aborted) return { success: false, cancelled: true, error: '' };
  if (!payload.ok) {
    console.warn(`[cardRecognition] photo not uploaded: ${payload.code}`);
    return { success: false, imageRejected: payload.code, error: '' };
  }

  // From here the listener is attached synchronously after the check above, so no
  // abort can slip between them; the timer and listener are released in `finally`.
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => { timedOut = true; controller.abort(); }, RECOGNITION_REQUEST_TIMEOUT_MS);
  const forwardAbort = () => controller.abort();
  options.signal?.addEventListener('abort', forwardAbort);

  try {

    // Call the API — web uses current origin; native uses the canonical production
    // API host (DIC-1245). The old holocard-hunter.vercel.app alias must never
    // reach an executable native bundle: it does not serve the current KV auth /
    // recognition surfaces, so recognition would silently fail.
    const apiBase = typeof window !== 'undefined' && window.location?.origin
      ? window.location.origin
      : PRODUCTION_ORIGIN;
    const apiUrl = apiBase + '/api/recognize-card';
    const apiResponse = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: payload.images[0], images: payload.images, storeMvp: STORE_MVP }),
      signal: controller.signal,
    });

    if (!apiResponse.ok) {
      console.warn(`[cardRecognition] API returned ${apiResponse.status}`);
      const errorBody = await apiResponse.json().catch(() => null);
      // 5xx 一律算後端故障（未佈署 503、vision 上游或資料庫 502）；404 才是真的比對不到。
      if (isRecognitionInfrastructureFailure(apiResponse.status, errorBody)) {
        return { success: false, serviceUnavailable: true, error: RECOGNITION_UNAVAILABLE_MESSAGE };
      }
      // 404 = the backend looked at this photo and has no valid answer. Its verdict
      // (and any evidence-backed alternatives) is what the UI explains.
      return { success: false, error: '', match: mapMatch(errorBody?.match) };
    }

    const data = await apiResponse.json();

    if (!data.success) {
      // The handler's low-confidence shape is
      //   { success:false, lowConfidence:true, candidates:[...] }
      // where each candidate carries its own compound id + own price. Mapping
      // that to `suggestions: CardInfo[]` alone dropped the per-candidate
      // confidence AND the typed `candidates` field the gallery decision path
      // reads, so the gallery low-confidence branch had nothing to hand the
      // exact-printing picker (DIC-1339). Preserve BOTH shapes: typed
      // candidates for the decision path, suggestions for legacy consumers.
      return {
        success: false,
        error: data.error || '',
        suggestions: Array.isArray(data.candidates) ? data.candidates.map(mapApiCard) : undefined,
        candidates: mapApiCandidates(data.candidates),
        confidence: data.confidence,
        reason: data.reason,
        raw: data.raw,
        debug: data.debug,
        lowConfidence: !!data.lowConfidence,
        match: mapMatch(data.match),
        // identity_only: the card the backend identified (no printing → its price is
        // withheld by the UI until the user picks a printing).
        card: data.match?.status === 'identity_only' && data.card ? mapApiCard(data.card) : undefined,
      };
    }

    // API returned full card info — use it directly
    if (data.card) {
      const cardInfo = mapApiCard(data.card);
      return {
        success: true,
        card: cardInfo,
        confidence: typeof data.confidence === 'number' ? data.confidence : undefined,
        candidates: mapApiCandidates(data.candidates),
        match: mapMatch(data.match),
        debug: data.debug,
      };
    }

    // API only returned cardNumber — look up locally
    if (!data.cardNumber) {
      return { success: false, error: '' };
    }

    const allCards = await loadAllCards();
    const cardNumber = data.cardNumber.toLowerCase().replace(/[^a-z0-9-]/g, '');

    // The API gave us a NUMBER, not a printing. Resolve it or refuse — never
    // take the first sibling (DIC-1325).
    const resolved = resolvePrintingByCardNumber(allCards, cardNumber, { fuzzy: true });
    if (resolved.status === 'unique') {
      console.log(`[cardRecognition] API recognized: ${cardNumber} → ${resolved.card.name}`);
      return { success: true, card: resolved.card };
    }
    if (resolved.status === 'ambiguous') {
      console.log(`[cardRecognition] API gave only ${cardNumber}; ${resolved.printings.length} printings — asking the user`);
      return ambiguousPrintingResult(resolved);
    }

    console.warn(`[cardRecognition] API found cardNumber ${cardNumber} but no DB match`);
    return { success: false, error: '' };

  } catch (e: any) {
    if (options.signal?.aborted) return { success: false, cancelled: true, error: '' };
    if (timedOut) {
      console.warn('[cardRecognition] API call timed out');
      return { success: false, timedOut: true, serviceUnavailable: true, error: RECOGNITION_UNAVAILABLE_MESSAGE };
    }
    // Name only: a transport error never carries the request body, but keep it that way.
    console.warn(`[cardRecognition] API call failed: ${e?.name || 'Error'}`);
    return { success: false, serviceUnavailable: true, error: RECOGNITION_UNAVAILABLE_MESSAGE };
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener('abort', forwardAbort);
  }
}

/**
 * 用於 OCR 卡牌的智能識別（先裁切找卡號，再比對資料庫）
 * 從圖片直接辨識，優先找卡號（比全圖名稱匹配更可靠）
 */
export async function recognizeCardFromImage(
  imageUri: string,
  options: RecognizeImageOptions = {},
): Promise<RecognitionResult> {
  // Step 0: Try server-side Gemini Vision API first
  let serviceUnavailable = false;
  let apiFailure: Pick<RecognitionResult, 'timedOut' | 'imageRejected'> = {};
  try {
    const apiResult = await recognizeViaApi(imageUri, options);
    if (apiResult.cancelled) return apiResult;
    // An explicit backend verdict is final for this photo: local OCR is a fallback for
    // an AI path that could not answer, never a second opinion that could replace a
    // no-match with a weaker guess.
    if (apiResult.match) return apiResult;
    if (apiResult.success && apiResult.card) {
      return apiResult;
    }
    if (apiResult.lowConfidence || apiResult.suggestions?.length || apiResult.raw || apiResult.debug) {
      return apiResult;
    }
    serviceUnavailable = !!apiResult.serviceUnavailable;
    apiFailure = { timedOut: apiResult.timedOut, imageRejected: apiResult.imageRejected };
  } catch (e: any) {
    console.warn(`[cardRecognition] API recognition failed, falling back to local: ${e?.name || 'Error'}`);
  }

  // Native local OCR is expo-ocr-kit, run by the caller (scanRecognitionFlow / ScanScreen
  // `performOcr`). Tesseract is web-only; on native this returns so that fallback runs.
  if (SCAN_RUNTIME === 'native') {
    return {
      success: false,
      error: serviceUnavailable ? RECOGNITION_UNAVAILABLE_MESSAGE : '',
      serviceUnavailable,
      ...apiFailure,
    };
  }

  let cardId: string | null = null;
  try {
    ({ cardId } = await recognizeCardNumber(imageUri));
  } catch (e: any) {
    // A Tesseract load / run failure is "local OCR read nothing", not a crash.
    console.warn(`[cardRecognition] local OCR failed: ${e?.name || 'Error'}`);
  }

  if (!cardId || cardId.trim().length === 0) {
    // A down backend must not masquerade as a badly-lit photo — the local OCR pass
    // above is a best-effort fallback, not evidence about the user's image.
    return serviceUnavailable
      ? { success: false, serviceUnavailable: true, error: RECOGNITION_UNAVAILABLE_MESSAGE }
      : { success: false, error: '無法從卡牌識別到卡號，請調整角度或光線後重試' };
  }

  const allCards = await loadAllCards();
  if (allCards.length === 0) {
    return { success: false, error: '資料庫載入失敗' };
  }

  // OCR read a card NUMBER off the photo. That identifies a printing only when
  // the number has one; otherwise the user picks (DIC-1325).
  const exact = resolvePrintingByCardNumber(allCards, cardId);
  if (exact.status === 'unique') {
    return { success: true, card: exact.card, confidence: 0.95 };
  }
  if (exact.status === 'ambiguous') {
    return { ...ambiguousPrintingResult(exact), confidence: 0.95 };
  }

  // 模糊匹配（如 NP04 → hBP04 已在 extractCardId 處理，但仍可能有數位誤判）
  const fuzzy = resolvePrintingByCardNumber(allCards, cardId, { fuzzy: true });
  if (fuzzy.status === 'unique') {
    return { success: true, card: fuzzy.card, confidence: 0.72 };
  }
  if (fuzzy.status === 'ambiguous') {
    return { ...ambiguousPrintingResult(fuzzy), confidence: 0.72 };
  }

  return { success: false, error: `找到卡號 ${cardId} 但資料庫無匹配，請確認卡牌版本` };
}

/**
 * 用於 OCR 卡牌的智能識別（比一般搜尋更寬鬆）
 */
export async function recognizeCardFromOcr(rawText: string): Promise<RecognitionResult> {
  if (!rawText || rawText.trim().length === 0) {
    return { success: false, error: '無法識別到文字' };
  }

  const allCards = await loadAllCards();
  if (allCards.length === 0) {
    return { success: false, error: '資料庫載入失敗' };
  }

  // Step 1: 嘗試從文字中提取卡號直接匹配（最可靠）
  const extractedIds = extractCardIds(rawText);
  if (extractedIds.length > 0) {
    for (const cardId of extractedIds) {
      const exact = resolvePrintingByCardNumber(allCards, cardId);
      if (exact.status === 'unique') {
        return { success: true, card: exact.card, confidence: 0.9 };
      }
      if (exact.status === 'ambiguous') {
        return { ...ambiguousPrintingResult(exact), confidence: 0.9 };
      }
      // Try prefix match (e.g. "NP04" matches "hBP04-xxx" → not reliable, skip)
      // Try fuzzy card number (e.g. "hBPO4" → "hBP04")
      const fuzzy = resolvePrintingByCardNumber(allCards, cardId, { fuzzy: true });
      if (fuzzy.status === 'unique') {
        return { success: true, card: fuzzy.card, confidence: 0.68 };
      }
      if (fuzzy.status === 'ambiguous') {
        return { ...ambiguousPrintingResult(fuzzy), confidence: 0.68 };
      }
    }
  }

// Step 2: 對每一行進行獨立匹配 — 只接受卡號匹配或含日文的文字
  const textLines = cleanOcrText(rawText);
  for (const line of textLines) {
    const lineIds = extractCardIds(line);
    if (lineIds.length > 0) {
      for (const id of lineIds) {
        const perLine = resolvePrintingByCardNumber(allCards, id);
        if (perLine.status === 'unique') {
          return { success: true, card: perLine.card, confidence: 0.85 };
        }
        if (perLine.status === 'ambiguous') {
          return { ...ambiguousPrintingResult(perLine), confidence: 0.85 };
        }
      }
    }
    // Only try name match if the text contains Japanese characters (kana/kanji)
    // This avoids random ASCII OCR artifacts (like "SSRB") matching card names
    const hasJapanese = /[\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uff00-\uffef]/.test(line);
    if (!hasJapanese) continue;
    const strictResult = await recognizeCard(line);
    if (strictResult.success && strictResult.card) {
      // Double-check: only accept if similarity is high enough
      const query = line.toLowerCase().replace(/[^a-z0-9\u3040-\u9fff]/g, '');
      const cardName = strictResult.card.name.toLowerCase().replace(/[^a-z0-9\u3040-\u9fff]/g, '');
      const sim = calculateSimilarity(query, cardName);
      if (sim > 0.4) {
        // Name-only OCR match: report similarity as confidence (capped below auto-add
        // threshold) and expose suggestions as candidates for the confirmation UI.
        const nameConfidence = Math.min(0.8, sim);
        const candidates: RecognizedCandidate[] = [
          { card: strictResult.card, confidence: nameConfidence },
          ...(strictResult.suggestions || []).map(c => ({ card: c, confidence: Math.min(0.6, sim * 0.7) })),
        ];
        return { ...strictResult, confidence: nameConfidence, candidates };
      }
    }
  }

  // Step 3: 如果以上都沒找到，直接回傳失敗（不降級到模糊搜尋）
  return { success: false, error: '找不到匹配的卡牌，請確認卡牌在掃描框內' };
}

/**
 * 識別卡牌（通過文字搜索）
 * @param searchText - 從 OCR 或用戶輸入的文字
 * @returns 識別結果
 */
export async function recognizeCard(searchText: string): Promise<RecognitionResult> {
  if (!searchText || searchText.trim().length === 0) {
    return { success: false, error: '請輸入搜尋文字' };
  }

  const allCards = await loadAllCards();
  if (allCards.length === 0) {
    return { success: false, error: '資料庫載入失敗' };
  }

  const query = searchText.trim();

  // 1. 精確匹配卡號 (大小寫不敏感)
  const exactIdMatch = allCards.find(c => c.id.toLowerCase() === query.toLowerCase());
  if (exactIdMatch) {
    return { success: true, card: exactIdMatch };
  }

  // 2. 名稱完全匹配
  const exactNameMatch = allCards.find(c => c.name === query);
  if (exactNameMatch) {
    return { success: true, card: exactNameMatch };
  }

  // 3. 卡號前綴匹配 (如 "hBP04" 匹配所有 hBP04 系列)
  const idPrefixMatch = allCards.filter(c => c.id.toLowerCase().startsWith(query.toLowerCase()));
  if (idPrefixMatch.length === 1) {
    return { success: true, card: idPrefixMatch[0] };
  }
  if (idPrefixMatch.length > 1) {
    // Reached from the OCR path (Step 2 below calls recognizeCard per line), so
    // it is part of the scan recovery path. When every prefix hit is the SAME
    // cardNumber the query resolved to a number, not a printing — hand back the
    // chooser with no price instead of the first sibling and its price.
    // A prefix spanning several card numbers is an ordinary series search
    // ("hBP04"), which keeps its existing behaviour (DIC-1325).
    const numbers = new Set(idPrefixMatch.map(c => flatten(c.cardNumber)));
    if (numbers.size === 1) {
      return ambiguousPrintingResult({ cardNumber: idPrefixMatch[0].cardNumber, printings: idPrefixMatch });
    }
    return {
      success: true,
      card: idPrefixMatch[0],
      suggestions: idPrefixMatch.slice(1, 4),
    };
  }

  // 4. 名稱包含匹配
  const queryLower = query.toLowerCase();
  const containsMatch = allCards.filter(c => c.name.toLowerCase().includes(queryLower));
  if (containsMatch.length === 1) {
    return { success: true, card: containsMatch[0] };
  }
  if (containsMatch.length > 1) {
    return {
      success: true,
      card: containsMatch[0],
      suggestions: containsMatch.slice(1, 4),
    };
  }

  // 4b. 如果文字包含空格，嘗試用每個關鍵字分別搜尋
  const nameParts = query.split(/[\s,，、　]+/).filter(p => p.length > 1 && !/^\d+$/.test(p));
  if (nameParts.length > 1) {
    // 找同時有最多關鍵字的卡牌
    const scoredByNameParts = allCards
      .map(card => {
        const cardLower = card.name.toLowerCase();
        const score = nameParts.filter(p => cardLower.includes(p)).length;
        return { card, score: score / nameParts.length };
      })
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score);
    if (scoredByNameParts.length > 0 && scoredByNameParts[0].score >= 0.5) {
      return {
        success: true,
        card: scoredByNameParts[0].card,
        suggestions: scoredByNameParts.slice(1, 4).map(s => s.card),
      };
    }
  }

  // 4c. 反過來：搜尋哪些卡牌名稱包含查詢文字
  // （當 card.name 較長而 OCR 只命中一部分時有用）
  const reversedMatch = allCards.filter(c => {
    const cardLower = c.name.toLowerCase();
    return queryLower.includes(cardLower);
  }).sort((a, b) => b.name.length - a.name.length); // 最長（最精確）的優先
  if (reversedMatch.length === 1) {
    return { success: true, card: reversedMatch[0] };
  }
  if (reversedMatch.length > 1) {
    return {
      success: true,
      card: reversedMatch[0],
      suggestions: reversedMatch.slice(1, 4),
    };
  }

  // 4d. 嘗試用搜索卡號片段（如「BP04」）
  const idFragmentMatch = allCards.filter(c => c.id.toLowerCase().includes(queryLower));
  if (idFragmentMatch.length > 0) {
    // 取第一個（系列的代表）
    return {
      success: true,
      card: idFragmentMatch[0],
      suggestions: idFragmentMatch.slice(1, 4),
    };
  }

  // 5. 模糊相似度匹配
  const searchKeywords = extractKeywords(query);
  const scoredCards = allCards.map(card => {
    const cardKeywords = extractKeywords(card.name);
    const keywordScore = keywordsMatch(cardKeywords, searchKeywords);
    const similarityScore = Math.max(
      ...searchKeywords.map(search =>
        Math.max(...cardKeywords.map(c => calculateSimilarity(search, c))),
      ),
    );
    const totalScore = keywordScore * 0.5 + similarityScore * 0.5;
    return { card, score: totalScore };
  });

  scoredCards.sort((a, b) => b.score - a.score);
  const topResult = scoredCards[0];

  if (topResult && topResult.score > 0.3) {
    return {
      success: true,
      card: topResult.card,
      suggestions: scoredCards.slice(1, 4).map(s => s.card).filter(Boolean),
    };
  }

  return {
    success: false,
    error: '找不到匹配的卡牌',
    suggestions: scoredCards.slice(0, 5).map(s => s.card).filter(Boolean),
  };
}

/**
 * 根據卡牌 ID 獲取價格
 */
export async function getCardPrice(cardId: string): Promise<number | null> {
  const allCards = await loadAllCards();
  const card = allCards.find(c => c.id === cardId);
  return card?.sellPrice ?? null;
}

/**
 * 搜尋卡牌
 */
export async function searchCards(query: string, limit: number = 10): Promise<CardInfo[]> {
  const allCards = await loadAllCards();
  const queryLower = query.toLowerCase();

  return allCards
    .filter(card =>
      card.name.toLowerCase().includes(queryLower) ||
      card.id.toLowerCase().includes(queryLower) ||
      card.series.toLowerCase().includes(queryLower),
    )
    .slice(0, limit);
}

export default {
  recognizeCard,
  getCardPrice,
  searchCards,
  loadAllCards,
};
