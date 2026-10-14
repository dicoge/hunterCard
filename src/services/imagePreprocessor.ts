/**
 * imagePreprocessor.ts — Lightweight image preprocessing for card recognition.
 *
 * Simple and fast: just resize + slight sharpen.
 * No heavy CLAHE — that was causing timeout on mobile browsers.
 * 
 * If preprocessing fails at any point, gracefully falls back to original image.
 *
 * Web only. Native bundles never call this: the photo's bytes come from the capture call
 * itself (`base64: true`) and are checked by recognitionImagePolicy. The output is only
 * uploaded if it is a valid image data URL, so a fallback to a blob: / file: uri is
 * refused by cardRecognition rather than sent.
 */

export async function preprocessCardImage(imageUri: string): Promise<string> {
  try {
    return await resizeAndSharpen(imageUri);
  } catch {
    // Fallback: return original image if processing fails
    return imageUri;
  }
}

function resizeAndSharpen(imageUri: string): Promise<string> {
  return new Promise<string>((resolve) => {
    const img = new Image();
    const timeout = setTimeout(() => {
      img.onload = null;
      img.onerror = null;
      resolve(imageUri); // timeout → use original
    }, 10000);

    img.onload = () => {
      clearTimeout(timeout);
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;

        // Keep tiny card numbers readable for vision/OCR matching.
        const MAX = 1536;
        if (w <= MAX && h <= MAX) {
          // Already small enough. A data URL can go as-is; anything else (a picker's
          // blob: uri) is re-encoded below so what gets uploaded is image data.
          if (/^data:image\//.test(imageUri)) {
            resolve(imageUri);
            return;
          }
        } else if (w > h) { h = Math.round((h / w) * MAX); w = MAX; }
        else { w = Math.round((w / h) * MAX); h = MAX; }

        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        if (!ctx) { resolve(imageUri); return; }

        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL('image/jpeg', 0.85));
      } catch {
        resolve(imageUri);
      }
    };

    img.onerror = () => {
      clearTimeout(timeout);
      resolve(imageUri);
    };

    img.src = imageUri;
  });
}

export default { preprocessCardImage };