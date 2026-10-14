/**
 * Native stand-in for webOcr.ts. Tesseract.js is a browser OCR engine: on iOS / Android
 * it is never imported, bundled or run. Native local OCR is expo-ocr-kit via
 * src/services/nativeOcr.ts, which ScanScreen and scanRecognitionFlow call directly.
 *
 * These exports exist only so shared modules keep one import path. Nothing on native
 * should reach them; if something does, it gets an empty result — never the Tesseract
 * load throw that used to escape recognizeCardFromImage and skip the native OCR fallback.
 */

export async function recognizeTextWeb(_imageUri: string): Promise<{ text: string }> {
  return { text: '' };
}

export async function recognizeCardNumber(_imageUri: string): Promise<{ cardId: string | null; rawText: string }> {
  return { cardId: null, rawText: '' };
}
