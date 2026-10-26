/**
 * What counts as a recognisable card photo on the wire (native AI photo upload, 2026-10-14).
 *
 * Shared by the scanner (web + native) and api/recognize-card so both sides enforce the
 * SAME rules: the client refuses to send anything this rejects, and the handler answers
 * 400 for it before resolving a provider — a local `file://` / `content://` path, a bare
 * string, bad base64 or an unsupported type never reaches Google Gemini. The handler used
 * to wrap ANY string as `data:image/jpeg;base64,<string>`, which is how native scans were
 * sending an undecodable file path to Gemini on every capture.
 *
 * Deliberately dependency-free (no react-native, no DOM, no atob) so the edge handler,
 * the React Native bundle and the Node regressions all run this exact code.
 */

export const RECOGNITION_IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
export type RecognitionImageMimeType = typeof RECOGNITION_IMAGE_MIME_TYPES[number];

/** One decoded image. A 1536–2048px JPEG at the scanner's quality is well under this. */
export const MAX_RECOGNITION_IMAGE_BYTES = 2_500_000;
/** Base64 length of MAX_RECOGNITION_IMAGE_BYTES — checked first, before anything scans the payload. */
export const MAX_RECOGNITION_IMAGE_BASE64_CHARS = Math.ceil(MAX_RECOGNITION_IMAGE_BYTES / 3) * 4;
/** Full frame + scan-area crop (web). Native sends one. */
export const MAX_RECOGNITION_IMAGES = 2;
/** Whole request stays below the 4.5 MB platform body limit with JSON overhead to spare. */
export const MAX_RECOGNITION_TOTAL_BASE64_CHARS = 3_600_000;

export type RecognitionImageErrorCode =
  | 'IMAGE_MISSING'
  | 'IMAGE_TOO_MANY'
  | 'IMAGE_URI_NOT_ALLOWED'
  | 'IMAGE_NOT_DATA_URL'
  | 'IMAGE_UNSUPPORTED_TYPE'
  | 'IMAGE_INVALID_BASE64'
  | 'IMAGE_TYPE_MISMATCH'
  | 'IMAGE_TOO_LARGE';

export type RecognitionImageCheck =
  | { ok: true; mimeType: RecognitionImageMimeType; base64Chars: number }
  | { ok: false; code: RecognitionImageErrorCode };

// `data:image/jpeg;base64,` and friends are far shorter than this.
const DATA_URL_HEAD_CHARS = 64;
const DATA_URL_HEAD = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64$/i;
// Anything that names a resource instead of carrying it. Sending one of these is the
// native defect this module exists to stop.
const RESOURCE_URI = /^(file|content|ph|assets-library|blob|https?):/i;
const BASE64_BODY = /^[A-Za-z0-9+/]+={0,2}$/;

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Decode only the first few bytes — enough for a file signature, never the payload. */
function decodeHead(base64: string, bytes = 12): number[] {
  const chars = base64.slice(0, Math.ceil(bytes / 3) * 4);
  const out: number[] = [];
  for (let i = 0; i + 3 < chars.length; i += 4) {
    const n = (B64.indexOf(chars[i]) << 18) | (B64.indexOf(chars[i + 1]) << 12)
      | ((B64.indexOf(chars[i + 2]) & 63) << 6) | (B64.indexOf(chars[i + 3]) & 63);
    out.push((n >> 16) & 255, (n >> 8) & 255, n & 255);
  }
  return out.slice(0, bytes);
}

/** File type from its signature bytes; null for anything outside the allowlist. */
export function sniffRecognitionImageType(base64: string): RecognitionImageMimeType | null {
  const b = decodeHead(base64);
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'image/webp';
  return null;
}

function decodedBytes(base64: string): number {
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  return (base64.length / 4) * 3 - padding;
}

function checkBase64Body(body: string, declared: RecognitionImageMimeType): RecognitionImageCheck {
  // Length before content: an oversized payload is refused without being scanned.
  if (body.length > MAX_RECOGNITION_IMAGE_BASE64_CHARS) return { ok: false, code: 'IMAGE_TOO_LARGE' };
  if (body.length < 16 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    return { ok: false, code: 'IMAGE_INVALID_BASE64' };
  }
  if (decodedBytes(body) > MAX_RECOGNITION_IMAGE_BYTES) return { ok: false, code: 'IMAGE_TOO_LARGE' };
  if (sniffRecognitionImageType(body) !== declared) return { ok: false, code: 'IMAGE_TYPE_MISMATCH' };
  return { ok: true, mimeType: declared, base64Chars: body.length };
}

function isAllowedMime(value: string): value is RecognitionImageMimeType {
  return (RECOGNITION_IMAGE_MIME_TYPES as readonly string[]).includes(value);
}

/**
 * Accepts only `data:image/{jpeg,png,webp};base64,<strict base64>` whose signature bytes
 * match the declared type and whose size is inside the limits above.
 */
export function validateRecognitionDataUrl(value: unknown): RecognitionImageCheck {
  if (typeof value !== 'string' || value.length === 0) return { ok: false, code: 'IMAGE_MISSING' };
  if (RESOURCE_URI.test(value)) return { ok: false, code: 'IMAGE_URI_NOT_ALLOWED' };
  const comma = value.slice(0, DATA_URL_HEAD_CHARS).indexOf(',');
  const head = comma > 0 ? value.slice(0, comma).match(DATA_URL_HEAD) : null;
  if (!head) return { ok: false, code: 'IMAGE_NOT_DATA_URL' };
  const mime = head[1].toLowerCase();
  if (!isAllowedMime(mime)) return { ok: false, code: 'IMAGE_UNSUPPORTED_TYPE' };
  return checkBase64Body(value.slice(comma + 1), mime);
}

/** The request-level rules: 1..MAX images, each valid, and a bounded total. */
export function validateRecognitionImages(images: unknown): RecognitionImageCheck {
  if (!Array.isArray(images) || images.length === 0) return { ok: false, code: 'IMAGE_MISSING' };
  if (images.length > MAX_RECOGNITION_IMAGES) return { ok: false, code: 'IMAGE_TOO_MANY' };
  let total = 0;
  let first: RecognitionImageCheck | null = null;
  for (const image of images) {
    const check = validateRecognitionDataUrl(image);
    if (!check.ok) return check;
    total += check.base64Chars;
    if (total > MAX_RECOGNITION_TOTAL_BASE64_CHARS) return { ok: false, code: 'IMAGE_TOO_LARGE' };
    first ??= check;
  }
  return first!;
}

/**
 * Native capture → data URL. The camera / picker hand back raw base64; the type is taken
 * from the bytes themselves (a picker's `mimeType` can say HEIC while the base64 it
 * produced is JPEG, or the reverse), and the result is held to the same rules the
 * handler applies, so the device never sends what the server would refuse.
 */
export function buildRecognitionDataUrl(base64: unknown):
  | { ok: true; dataUrl: string; mimeType: RecognitionImageMimeType }
  | { ok: false; code: RecognitionImageErrorCode } {
  if (typeof base64 !== 'string' || base64.length === 0) return { ok: false, code: 'IMAGE_MISSING' };
  if (RESOURCE_URI.test(base64) || base64.startsWith('data:')) {
    // Callers pass the raw base64 field, never a uri or a ready-made data URL.
    return { ok: false, code: 'IMAGE_URI_NOT_ALLOWED' };
  }
  // Some platform encoders wrap lines; nothing else may be stripped.
  const body = base64.replace(/[\r\n]/g, '');
  if (body.length > MAX_RECOGNITION_IMAGE_BASE64_CHARS) return { ok: false, code: 'IMAGE_TOO_LARGE' };
  if (body.length < 16 || body.length % 4 !== 0 || !BASE64_BODY.test(body)) {
    return { ok: false, code: 'IMAGE_INVALID_BASE64' };
  }
  const mime = sniffRecognitionImageType(body);
  if (!mime) return { ok: false, code: 'IMAGE_UNSUPPORTED_TYPE' };
  const check = checkBase64Body(body, mime);
  if (!check.ok) return check;
  return { ok: true, dataUrl: `data:${mime};base64,${body}`, mimeType: mime };
}

/**
 * Pick a camera `pictureSize` whose long edge is large enough to read the tiny card number
 * but small enough that one JPEG stays inside MAX_RECOGNITION_IMAGE_BYTES. Native-only:
 * expo-camera returns "WxH" strings (plus named presets on iOS, which are ignored).
 * Returns undefined to keep the device default when nothing suitable is listed; the
 * payload is size-checked after capture regardless.
 */
export const TARGET_PICTURE_LONG_EDGE = { min: 1280, max: 2560 } as const;

export function chooseRecognitionPictureSize(sizes: readonly string[] | null | undefined): string | undefined {
  if (!Array.isArray(sizes)) return undefined;
  const parsed = sizes
    .map((size) => {
      const m = /^(\d{2,5})x(\d{2,5})$/.exec(String(size).trim());
      return m ? { size: String(size).trim(), long: Math.max(+m[1], +m[2]) } : null;
    })
    .filter((s): s is { size: string; long: number } => !!s
      && s.long >= TARGET_PICTURE_LONG_EDGE.min && s.long <= TARGET_PICTURE_LONG_EDGE.max)
    .sort((a, b) => a.long - b.long);
  // Smallest that is still >= 1600 reads card numbers like the web scanner's 1536–2048
  // frames; otherwise the largest in range.
  return (parsed.find((s) => s.long >= 1600) ?? parsed[parsed.length - 1])?.size;
}
