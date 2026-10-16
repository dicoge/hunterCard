/**
 * Shared classification of a /api/recognize-card failure response.
 *
 * Deliberately dependency-free (no browser / react-native imports) so the scan
 * screen, the album-upload path and the Node regression all read the same rules.
 */

export const RECOGNITION_UNAVAILABLE_CODE = 'RECOGNITION_UNAVAILABLE';

/**
 * How long the scanner waits for /api/recognize-card before aborting the request.
 *
 * This is the real deadline the whole server-side provider chain has to finish inside:
 * a fallback leg that only succeeds after this has already been abandoned by the caller
 * (DIC-1020 CR). The handler sizes its own shared budget from it.
 */
export const RECOGNITION_REQUEST_TIMEOUT_MS = 15000;

/** Shown when the deployment cannot recognise anything — never a "retake the photo" hint. */
export const RECOGNITION_UNAVAILABLE_MESSAGE = '辨識服務暫時無法使用，請稍後再試或改用手動搜尋';

/**
 * True when the deployment itself cannot recognise — an unprovisioned or down
 * recognition backend, as opposed to a card the ranker simply could not match.
 * The two must not share an error message: a 503 told the user to adjust their
 * lighting on an environment with no API key at all (DIC-1013 QA).
 */
export function isRecognitionUnavailable(status: number, body?: any): boolean {
  return status === 503 || body?.code === RECOGNITION_UNAVAILABLE_CODE;
}

/**
 * True when the failure belongs to the deployment rather than to this photo: an
 * unprovisioned key (503), a dead vision upstream or a failed database load (502).
 * None of those ever looked at the image, so the UI has to fall through to local
 * OCR and must not suggest a retake.
 *
 * 404 is deliberately excluded — that one IS the ranker reporting it could not
 * match THIS image, and asking for a better shot is the correct advice there.
 */
export function isRecognitionInfrastructureFailure(status: number, body?: any): boolean {
  return status >= 500 || status === 429 || isRecognitionUnavailable(status, body);
}

/**
 * Why the recognition service could not answer (v39 user report 2026-10-16: a 503
 * ended as 「找不到匹配的卡牌」). Only what is provable is named:
 *   network      the request never got an HTTP response (fetch rejected, not by us)
 *   timeout      our RECOGNITION_REQUEST_TIMEOUT_MS deadline aborted it
 *   timeout      …or the server's own provider deadline (code PROVIDER_TIMEOUT)
 *   busy         HTTP 429, a 503 that is not our own RECOGNITION_UNAVAILABLE answer, or
 *                the provider answered 429 / 503 (code PROVIDER_BUSY)
 *   unavailable  anything else (our 503 code, 500, 502, …) — cause unknown, no guess
 * None of these is a verdict about the photo: never shown as "no match".
 */
export type RecognitionFailureKind = 'network' | 'timeout' | 'busy' | 'unavailable';

export function classifyHttpFailure(status: number, body?: any): RecognitionFailureKind {
  // The handler's bounded provider category (api/recognize-card ProviderFailureError).
  // A generic 502 from an older server has none and stays 'unavailable'.
  if (body?.code === 'PROVIDER_TIMEOUT') return 'timeout';
  if (body?.code === 'PROVIDER_BUSY') return 'busy';
  if (status === 429) return 'busy';
  if (status === 503 && body?.code !== RECOGNITION_UNAVAILABLE_CODE) return 'busy';
  return 'unavailable';
}

/** Diagnostic error code per kind (scanDiagnostics ERROR_CODE pattern). */
export const RECOGNITION_FAILURE_CODES: Record<RecognitionFailureKind, string> = {
  network: 'NETWORK_ERROR',
  timeout: 'TIMEOUT',
  busy: 'SERVICE_BUSY',
  unavailable: 'RECOGNITION_UNAVAILABLE',
};
