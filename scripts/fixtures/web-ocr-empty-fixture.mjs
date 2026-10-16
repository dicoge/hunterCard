// webOcr stand-in: browser OCR (Tesseract) reads nothing, offline.
export async function recognizeTextWeb() { return { text: '' }; }
export async function recognizeCardNumber() { return { cardId: null, rawText: '' }; }
