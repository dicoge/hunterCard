// webOcr stand-in: browser OCR (Tesseract) reads nothing, offline. With
// globalThis.__webOcrThrows it rejects like a worker / model-load failure.
export async function recognizeTextWeb() {
  if (globalThis.__webOcrThrows) throw new Error('tesseract worker failed to load');
  return { text: '' };
}
export async function recognizeCardNumber() {
  if (globalThis.__webOcrThrows) throw new Error('tesseract worker failed to load');
  return { cardId: null, rawText: '' };
}
