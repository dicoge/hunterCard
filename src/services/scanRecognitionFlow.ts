/**
 * 相機掃描的辨識流程（web / native 各一支）。
 *
 * 這裡是 ScanScreen 相機路徑真正跑的程式碼，只把 I/O（fetch、OCR、搜尋）和 UI setState
 * 抽成參數，好讓 Node 回歸能執行到同一份分支，而不是另外寫一份模擬管線。
 *
 * 刻意不 import 任何瀏覽器／react-native 模組，型別一律 `import type`。
 */

import type { CardInfo, RecognitionResult, RecognizedCandidate } from './cardRecognition';
import { isRecognitionInfrastructureFailure, RECOGNITION_UNAVAILABLE_MESSAGE } from './recognitionOutcome';

/** 本地 OCR 也讀不到字時的一般引導；服務本身掛掉時不得使用。 */
export const NO_TEXT_GUIDANCE = '無法自動辨識卡牌文字。請使用手動搜尋或從下方搜尋結果中選擇。';

export interface RecognitionApiResponse {
  status: number;
  body: any;
}

export interface ScanFlowIo {
  /** 網路／逾時失敗時 reject；成功時必須帶回真正的 HTTP status。 */
  callRecognitionApi(): Promise<RecognitionApiResponse>;
  recognizeFromImage(imageUri: string): Promise<RecognitionResult>;
  ocrText(imageUri: string): Promise<string>;
  recognizeFromOcr(text: string): Promise<RecognitionResult>;
  searchCards(text: string, limit: number): Promise<CardInfo[]>;
  mapApiCard(raw: any): CardInfo;
  mapApiCandidates(raw: any): RecognizedCandidate[] | undefined;
}

export interface ScanFlowUi {
  setStatus(label: string, progress?: number): void;
  setBusy(busy: boolean): void;
  setScanError(message: string): void;
  setSearchError(message: string): void;
  setSearchResults(cards: CardInfo[]): void;
  setSuggestions(cards: CardInfo[]): void;
  setRecognizedText(text: string): void;
  setCandidateReason(reason: string): void;
  showLowConfidenceCandidates(candidates: RecognizedCandidate[]): void;
  onRecognized(card: CardInfo, confidence: number, candidates?: RecognizedCandidate[]): void;
  onVisionRecognized(card: CardInfo, confidence: number): void;
}

export async function runWebCameraScan(imageUri: string, io: ScanFlowIo, ui: ScanFlowUi): Promise<void> {
  ui.setStatus('🤖 AI 辨識中…', 3);

  let apiBody: any = null;
  let apiNetworkError = false;
  let backendFailed = false;
  try {
    const response = await io.callRecognitionApi();
    apiBody = response.body;
    // 未佈署金鑰（503）、vision 上游掛掉或資料庫載入失敗（502）都是「這個環境不能辨識」，
    // 不是「這張照片不好」。status 必須留到這裡判斷，先前把它丟掉，才會讓後端故障叫使用者
    // 去調光線（DIC-1013）。只有 404 才是排序器真的比對不到這張圖。
    backendFailed = isRecognitionInfrastructureFailure(response.status, apiBody);
  } catch (e: any) {
    apiNetworkError = true;
    console.warn('[scanFlow] recognition API unreachable:', e?.message);
  }

  if (apiBody?.success && apiBody?.card) {
    ui.setStatus('✅ 辨識完成', 4);
    const confidence = typeof apiBody.confidence === 'number' ? apiBody.confidence : 0.9;
    ui.onRecognized(io.mapApiCard(apiBody.card), confidence, io.mapApiCandidates(apiBody.candidates));
    ui.setBusy(false);
    return;
  }

  // 後端有回應且是「這張卡辨識不出來」→ 才可以請使用者重拍。
  if (apiBody && !apiBody.success && !backendFailed) {
    ui.setStatus('', 0);
    ui.setBusy(false);
    if (apiBody.raw) ui.setRecognizedText(apiBody.raw);
    const weakCandidates = io.mapApiCandidates(apiBody.candidates);
    if (weakCandidates && weakCandidates.length > 0) {
      ui.showLowConfidenceCandidates(weakCandidates.slice(0, 5));
    } else {
      const errMsg = apiBody.error || '無法辨識';
      ui.setScanError(`⚠️ 辨識失敗: ${errMsg}。請靠近卡號、避免反光、保持卡片平整後重試，或改用手動搜尋。`);
    }
    return;
  }

  if (!apiNetworkError && !backendFailed) {
    // 沒網路錯誤也沒 API 結果（不該發生，但兜底）
    ui.setScanError('無法完成掃描，請重試或使用手動搜尋');
    ui.setBusy(false);
    return;
  }

  // 後端不可用（掛掉或未佈署）→ 本地 OCR 仍要跑，它是這時唯一還能辨識的路。
  await runWebLocalFallback(imageUri, io, ui, backendFailed);
}

async function runWebLocalFallback(
  imageUri: string,
  io: ScanFlowIo,
  ui: ScanFlowUi,
  backendFailed: boolean,
): Promise<void> {
  const result = await io.recognizeFromImage(imageUri);
  ui.setBusy(false);

  if (result.success && result.card) {
    ui.onRecognized(result.card, result.confidence ?? 0.85, result.candidates);
    return;
  }

  const trimmedText = (await io.ocrText(imageUri)).trim();
  ui.setRecognizedText(trimmedText);

  if (trimmedText.length > 0) {
    const fallbackResult = await io.recognizeFromOcr(trimmedText);
    if (fallbackResult.success && fallbackResult.card) {
      ui.onRecognized(fallbackResult.card, fallbackResult.confidence ?? 0.85, fallbackResult.candidates);
      return;
    }
    ui.setSearchError(fallbackResult.error || '找不到匹配的卡牌');
    ui.setSearchResults(await io.searchCards(trimmedText, 10));
    return;
  }

  ui.setScanError(backendFailed || result.serviceUnavailable ? RECOGNITION_UNAVAILABLE_MESSAGE : NO_TEXT_GUIDANCE);
}

export async function runNativeCameraScan(imageUri: string, io: ScanFlowIo, ui: ScanFlowUi): Promise<void> {
  ui.setStatus('🤖 AI 辨識中…', 3);

  const vision = await io.recognizeFromImage(imageUri);
  if (vision.success && vision.card) {
    ui.setBusy(false);
    ui.setStatus('✅ 辨識完成', 4);
    ui.onVisionRecognized(vision.card, vision.confidence ?? 0.9);
    return;
  }

  if (vision.lowConfidence || vision.suggestions?.length) {
    ui.setBusy(false);
    const candidateCards = vision.suggestions || [];
    ui.setSearchResults(candidateCards);
    ui.setSuggestions(candidateCards);
    ui.setSearchError(vision.error || '辨識信心不足，請從候選卡中選擇');
    ui.setCandidateReason(`信心 ${Math.round((vision.confidence || 0) * 100)}%：${vision.reason || '需要人工確認'}`);
    if (vision.raw) ui.setRecognizedText(vision.raw);
    return;
  }

  // 後端不可用時這段本地 OCR 仍照跑；它失敗只代表本地讀不到字，不代表照片有問題。
  ui.setStatus('🔍 OCR 辨識中…');
  const trimmedText = (await io.ocrText(imageUri)).trim();
  ui.setRecognizedText(trimmedText);
  ui.setBusy(false);

  if (trimmedText.length > 0) {
    const result = await io.recognizeFromOcr(trimmedText);
    if (result.success && result.card) {
      ui.setStatus('✅ 辨識完成', 4);
      ui.onRecognized(result.card, result.confidence ?? 0.85, result.candidates);
      return;
    }
    ui.setSearchError(result.error || '找不到匹配的卡牌');
    ui.setSearchResults(await io.searchCards(trimmedText, 10));
    return;
  }

  ui.setScanError(vision.serviceUnavailable ? RECOGNITION_UNAVAILABLE_MESSAGE : NO_TEXT_GUIDANCE);
}
