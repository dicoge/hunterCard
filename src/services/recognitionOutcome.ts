/**
 * Shared classification of a /api/recognize-card failure response.
 *
 * Deliberately dependency-free (no browser / react-native imports) so the scan
 * screen, the album-upload path and the Node regression all read the same rules.
 */

export const RECOGNITION_UNAVAILABLE_CODE = 'RECOGNITION_UNAVAILABLE';

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
