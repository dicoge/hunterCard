/**\n * Web OCR Service\n * 在 web 版使用 Tesseract.js 替代 expo-ocr-kit\n *\n * Card number detection is handled server-side via Gemini Vision API.\n * Local Tesseract serves as fallback with fixed-position crop.\n */

import { findCardNumberTokens } from '../utils/cardNumberToken';

let Tesseract: any = null;

async function getTesseract() {
  if (!Tesseract) {
    Tesseract = await import('tesseract.js');
  }
  return Tesseract;
}

export async function recognizeTextWeb(imageUri: string): Promise<{ text: string }> {
  const t = await getTesseract();

  // data-uri 或 blob URL 皆可給 Tesseract
  const result = await t.recognize(imageUri, 'jpn+eng', {
    logger: (info: any) => {
      if (info.status === 'recognizing text') {
        console.log(`[webOcr] progress: ${Math.round(info.progress * 100)}%`);
      }
    },
  });

  return { text: result.data.text };
}

/**
 * 從圖片中裁切卡號區域（底部 20%，左右各留 10% 邊距）
 * hololive 卡牌的卡號固定印在卡片右下角，裁切後送 OCR 可大幅減少雜訊干擾。
 * @returns data URI of the cropped region
 */
async function cropCardNumberArea(imageUri: string): Promise<string> {
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Failed to load image for cropping'));
    image.src = imageUri;
  });

  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Failed to get 2D context for cropping');

  const w = Math.min(img.width, 2048);
  const h = Math.min(img.height, 2048);

  // 裁切區域：底部 20%，左右各裁 10%
  const cropX = Math.round(w * 0.1);
  const cropY = Math.round(h * 0.8);
  const cropW = Math.round(w * 0.8);
  const cropH = Math.round(h * 0.2);

  canvas.width = cropW;
  canvas.height = cropH;

  ctx.drawImage(img, cropX, cropY, cropW, cropH, 0, 0, cropW, cropH);
  try {
    return canvas.toDataURL('image/png');
  } catch {
    return imageUri;
  }
}

/**\n * 從裁切區 OCR 文字中提取卡號（支援 hBP04-005、BP04-005、NP04-005 等格式）
 */
function extractCardId(text: string): string | null {
  // Whole-token parse only (src/utils/cardNumberToken): `hBP04-0050` is not hBP04-005.
  return findCardNumberTokens(text)[0] ?? null;
}

/**
 * 卡號優先 OCR：先裁切底部區域找卡號，再 fallback 到全圖 OCR
 * @returns cardId 找到的卡號（如 hBP04-005），或 null；rawText 為 OCR 原始文字
 */
export async function recognizeCardNumber(imageUri: string): Promise<{ cardId: string | null; rawText: string }> {
  const t = await getTesseract();

  // Step 1: 裁切底部區域，對裁切區跑 OCR
  let croppedUri: string;
  try {
    croppedUri = await cropCardNumberArea(imageUri);
  } catch (e) {
    console.warn('[webOcr] crop failed, falling back to full image:', e);
    const full = await t.recognize(imageUri, 'jpn+eng');
    return { cardId: extractCardId(full.data.text), rawText: full.data.text };
  }

  const croppedResult = await t.recognize(croppedUri, 'jpn+eng', {
    logger: (info: any) => {
      if (info.status === 'recognizing text') {
        console.log(`[webOcr][crop] progress: ${Math.round(info.progress * 100)}%`);
      }
    },
  });

  // Step 2: 從裁切區 OCR 結果提取卡號
  const cardId = extractCardId(croppedResult.data.text);
  if (cardId) {
    return { cardId, rawText: croppedResult.data.text };
  }

  // Step 3: Fallback — 對全圖做 OCR 並提取卡號
  console.log('[webOcr] no card number in cropped area, falling back to full image OCR');
  try {
    const fullResult = await t.recognize(imageUri, 'jpn+eng');
    return { cardId: extractCardId(fullResult.data.text), rawText: fullResult.data.text };
  } catch (e) {
    console.warn('[webOcr] fallback OCR failed:', e);
    return { cardId: null, rawText: '' };
  }
}
