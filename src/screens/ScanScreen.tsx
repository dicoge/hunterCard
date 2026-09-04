import React, { useState, useEffect, useRef } from 'react';
import { 
  View, 
  Text, 
  StyleSheet, 
  TouchableOpacity, 
  Animated,
  Dimensions,
  Alert,
  Platform,
  Linking,
  ScrollView,
  TextInput,
  Modal,
  SafeAreaView,
  LayoutChangeEvent,
} from 'react-native';
import { CameraView, useCameraPermissions, CameraType } from 'expo-camera';
import WebCamera, { WebCameraHandle } from '../components/WebCamera';
import CameraPermissionDeniedView from '../components/CameraPermissionDeniedView';
import ScanSessionPanel from '../components/ScanSessionPanel';
import { nativeOcrRecognize } from '../services/nativeOcr';
import { useScanSessionStore } from '../stores/scanSessionStore';
import * as ImagePicker from 'expo-image-picker';
import { COLORS, convertPrice } from '../constants';
import { recognizeCard, recognizeCardFromOcr, recognizeCardFromImage, searchCards, CardInfo, RecognizedCandidate } from '../services/cardRecognition';
import { RECOGNITION_REQUEST_TIMEOUT_MS } from '../services/recognitionOutcome';
import {
  runWebCameraScan,
  runNativeCameraScan,
  isAmbiguousPrinting,
  decideRecognizedOutcome,
  type ScanFlowIo,
  type ScanFlowUi,
} from '../services/scanRecognitionFlow';
import { recognizeTextWeb } from '../services/webOcr';
import ScanOverlay from '../components/ScanOverlay';
import ScanResultCard from '../components/ScanResultCard';
import ScanCandidateSelector from '../components/ScanCandidateSelector';
import { analyzeFrameWithStability, resetAutoScan } from '../services/autoScanService';
import { useSettingsStore } from '../store/settingsStore';
import { mapViewportRectToSource, Rect } from '../utils/scanGeometry';
import { mapApiCardToCardInfo } from '../utils/apiCardMapper';
import { useAuthStore } from '../store/authStore';
import { useScanQuotaStore } from '../store/scanQuotaStore';
import { effectiveRole } from '../services/permissionService';
import { stripDisabledCardFields } from '../utils/cardReleaseFilter';
import ScanQuotaBanner from '../components/ScanQuotaBanner';
import { FEATURES, releaseCardFlags, STORE_MVP } from '../config/releaseFlags';
import { useTranslation, type TranslationKey } from '../i18n';

// iOS Safari: getUserMedia 需直接從使用者手勢觸發
// 所以 web 版跳過 expo-camera 的 useCameraPermissions，改用 WebCamera 直接管
const isWeb = Platform.OS === 'web';
const SCAN_COOLDOWN_MS = 3000; // Don't re-scan same card within 3s

// Confidence tiers for the scan result (avoid auto-adding wrong cards):
//  ≥ AUTO_ADD          → high: auto-add + show result card
//  MIN_CANDIDATE..AUTO → mid: show candidate picker, add only after user confirms
//  < MIN_CANDIDATE     → low: guidance + weak candidates, steer to re-shoot / manual
const CONFIDENCE_AUTO_ADD = 0.85;
const CONFIDENCE_MIN_CANDIDATE = 0.55;

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCAN_AREA_SIZE = SCREEN_WIDTH * 0.75;

export default function ScanScreen({ navigation }: any) {
  const { t } = useTranslation();
  // iOS web 不用 expo-camera 權限系統（避免 getUserMedia 手勢鏈中斷）
  // DIC-1301 CR fix: also destructure the third element — expo-camera's
  // silent GETTER (get-without-prompting). Passed to
  // CameraPermissionDeniedView so it can re-query CAMERA on AppState
  // 'active' transitions after the user grants CAMERA in system settings,
  // without ever surfacing a duplicate OS prompt.
  const [permission, requestPermission, getCameraPermissions] = isWeb
    ? [null, null, null] as any
    : useCameraPermissions();
  const [webCameraStarted, setWebCameraStarted] = useState(false);
  // Web 相簿上傳模式：相機無法使用（權限卡住/裝置無鏡頭）時的 fallback，不掛載 WebCamera
  const [webGalleryMode, setWebGalleryMode] = useState(false);
  // Card scanning always uses the rear camera; the flip control was removed from
  // the focused scan flow (DIC-1319), so this is a constant rather than state.
  const facing: CameraType = 'back';
  const cameraRef = useRef<CameraView>(null);
  const webCameraRef = useRef<WebCameraHandle>(null);
  const scanAreaViewportRef = useRef<Rect | null>(null);
  // 在手勢鏈中取得的 stream，避免 iOS Safari 阻擋 getUserMedia
  const webStreamRef = useRef<MediaStream | null>(null);
  const addCard = useScanSessionStore(s => s.addCard);
  const [lastScannedCard, setLastScannedCard] = useState<CardInfo | null>(null);
  
  // 相機狀態
  const [isCameraReady, setIsCameraReady] = useState<boolean>(false);
  const [cameraError, setCameraError] = useState<string | null>(null);
  const [permissionJustGranted, setPermissionJustGranted] = useState<boolean>(false);
  
  // 辨識結果狀態
  const [recognizedText, setRecognizedText] = useState<string>('');
  const [isProcessingOCR, setIsProcessingOCR] = useState<boolean>(false);
  const [flash, setFlash] = useState<boolean>(false);
  const [isScanning, setIsScanning] = useState<boolean>(false);
  const [scanningStatus, setScanningStatus] = useState<string>('');
  const [scanProgress, setScanProgress] = useState<number>(0); // 0=none, 1=capturing, 2=processing, 3=ai, 4=done
  const [scanComplete, setScanComplete] = useState<boolean>(false);
  
  // 辨識結果狀態
  const [recognizedCard, setRecognizedCard] = useState<CardInfo | null>(null);
  const [suggestions, setSuggestions] = useState<CardInfo[]>([]);
  const [candidateReason, setCandidateReason] = useState<string>('');
  const [searchError, setSearchError] = useState<string | null>(null);
  
  // 掃描錯誤狀態
  const [scanError, setScanError] = useState<string | null>(null);

  // 已拍下的照片預覽 uri（OCR 失敗時顯示給使用者）
  const [capturedPhotoUri, setCapturedPhotoUri] = useState<string | null>(null);

  // 手動搜尋
  const [showSearch, setShowSearch] = useState<boolean>(false);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [searchResults, setSearchResults] = useState<CardInfo[]>([]);
  
  // 动画 refs
  const scanLineAnim = useRef(new Animated.Value(0)).current;
  const pulseAnim = useRef(new Animated.Value(1)).current;
  const borderAnim = useRef(new Animated.Value(0)).current;

	// Auto-scan refs. Auto-scan is a web-only frame-stability loop, so whether it
  // runs is decided by the platform, not by a user-facing mode switch — the
  // toggle that used to sit under the viewfinder did nothing on Android
  // (DIC-1319).
  const autoScanActive = isWeb;
  const autoScanRef = useRef<number | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  // Currency preference (from global settings)
  const { preferredCurrency, preferredLanguage } = useSettingsStore();
  const localizedError = (message: string | null | undefined, fallback: TranslationKey) =>
    preferredLanguage === 'ja' ? t(fallback) : (message || t(fallback));
  const incrementScan = useScanQuotaStore((s) => s.incrementScan);
  const getRemaining = useScanQuotaStore((s) => s.getRemaining);

  // Scan result card (floating overlay)
  const [resultCard, setResultCard] = useState<{
    visible: boolean;
    card: CardInfo | null;
    confidence: number;
  }>({ visible: false, card: null, confidence: 0 });

  // Candidate selector (mid/low confidence — user must confirm before adding)
  const [candidateSelector, setCandidateSelector] = useState<{
    visible: boolean;
    tier: 'mid' | 'low';
    candidates: RecognizedCandidate[];
  }>({ visible: false, tier: 'mid', candidates: [] });

  // Single point where a card is committed to the session. This is where a scan
  // quota should be charged in future — only confirmed/high-confidence adds count,
  // never error retries. Guards against recording the same card twice in one session.
  const commitCard = (card: CardInfo): boolean => {
    const existing = useScanSessionStore.getState().cards;
    if (existing.some(c => c.id === card.id)) {
      Alert.alert(
        t('scan_duplicate_title'),
        t('scan_duplicate_body', { name: card.name || card.cardNumber }),
      );
      return false;
    }
    // Charge quota BEFORE recording; a denied credit must add nothing.
    if (!incrementScan()) {
      promptScanBlocked();
      return false;
    }
    addCard(card);
    setLastScannedCard(card);
    return true;
  };

  // Route a recognition result through the confidence tiers.
  //
  // The classification itself lives in `decideRecognizedOutcome` so a Node
  // harness can drive the SAME rules end-to-end without booting the screen
  // (DIC-1339). This wrapper handles the setState side effects only.
  //
  // Rules:
  //  - Unresolved printing → picker, never commit at ANY confidence (DIC-1325).
  //    The confidence describes how sure we are of the CARD; when a cardNumber
  //    carries several printings it says nothing about which one is in hand,
  //    and the result deliberately has no price. Auto-adding here is what put
  //    a priceless placeholder into the session instead of showing the chooser.
  //  - High confidence → auto-add and show the floating result card.
  //  - Mid/low → require explicit confirmation via the candidate picker.
  const handleRecognized = (
    card: CardInfo,
    confidence: number,
    candidates?: RecognizedCandidate[],
    ambiguousPrinting = false,
  ) => {
    setSearchResults([]);
    setSearchError(null);
    setSuggestions([]);
    setScanError(null);
    setCapturedPhotoUri(null);
    resetAutoScan();

    const decision = decideRecognizedOutcome(card, confidence, candidates, ambiguousPrinting, {
      autoAdd: CONFIDENCE_AUTO_ADD,
      minCandidate: CONFIDENCE_MIN_CANDIDATE,
    });

    if (decision.action === 'commit') {
      if (commitCard(decision.card)) {
        setResultCard({ visible: true, card: decision.card, confidence: decision.confidence });
      }
      return;
    }

    setCandidateSelector({
      visible: true,
      tier: decision.action === 'ambiguous-picker' ? 'mid' : decision.tier,
      candidates: decision.candidates,
    });
  };

  // Map a raw API card payload to CardInfo via the single shared mapper so the
  // scan → CardDetail path keeps buyPrice / priceHistory / ytStats (DIC-361 / DIC-856).
  const mapApiCard = (c: any): CardInfo => stripDisabledCardFields(mapApiCardToCardInfo(c), releaseCardFlags());

  const mapApiCandidates = (raw: any): RecognizedCandidate[] | undefined => {
    if (!Array.isArray(raw) || raw.length === 0) return undefined;
    return raw
      .filter((c: any) => c && c.cardNumber)
      .map((c: any) => ({
        card: mapApiCard(c),
        confidence: typeof c.confidence === 'number' ? c.confidence : 0,
      }));
  };

  const closeCandidateSelector = () =>
    setCandidateSelector({ visible: false, tier: 'mid', candidates: [] });

  const handleConfirmCandidate = (card: CardInfo) => {
    closeCandidateSelector();
    if (commitCard(card)) {
      setResultCard({ visible: true, card, confidence: 1 });
    }
  };

  // 显式请求相机权限 - 修复 Android/iOS 权限问题（web 版跳過，由 WebCamera 直接處理）
  useEffect(() => {
    if (isWeb) return;
    const requestPermissionExplicitly = async () => {
      if (!permission?.granted) {
        try {
          const { status } = await requestPermission();
          console.log('Camera permission status:', status);
        } catch (error) {
          console.error('Error requesting camera permission:', error);
        }
      }
    };
    requestPermissionExplicitly();
  }, []);

  // 扫描线动画
  useEffect(() => {
    const scanAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(scanLineAnim, {
          toValue: 1,
          duration: 2000,
          useNativeDriver: true,
        }),
        Animated.timing(scanLineAnim, {
          toValue: 0,
          duration: 2000,
          useNativeDriver: true,
        }),
      ])
    );
    scanAnimation.start();
    return () => scanAnimation.stop();
  }, [scanLineAnim]);

  // 边框脉冲动画
  useEffect(() => {
    const pulseAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(pulseAnim, {
          toValue: 1.02,
          duration: 1000,
          useNativeDriver: true,
        }),
        Animated.timing(pulseAnim, {
          toValue: 1,
          duration: 1000,
          useNativeDriver: true,
        }),
      ])
    );
    pulseAnimation.start();
    return () => pulseAnimation.stop();
  }, [pulseAnim]);

  // 边框颜色动画
  useEffect(() => {
    const borderAnimation = Animated.loop(
      Animated.sequence([
        Animated.timing(borderAnim, {
          toValue: 1,
          duration: 1500,
          useNativeDriver: false,
        }),
        Animated.timing(borderAnim, {
          toValue: 0,
          duration: 1500,
          useNativeDriver: false,
        }),
      ])
    );
    borderAnimation.start();
    return () => borderAnimation.stop();
  }, [borderAnim]);

  // Auto-scan rAF loop (web only) — detects card in frame and auto-triggers OCR
  useEffect(() => {
    // Auto-scan only works on web; native keeps manual scan
    if (!autoScanActive) return;
    if (!isCameraReady) return;
    if (isScanning || isProcessingOCR) return;
    if (candidateSelector.visible || resultCard.visible) return;

    let mounted = true;
    const scanArea = {
      x: Math.round((SCREEN_WIDTH - SCAN_AREA_SIZE) / 2),
      y: Math.round(SCREEN_HEIGHT * 0.15),
      width: Math.round(SCAN_AREA_SIZE),
      height: Math.round(SCAN_AREA_SIZE * 0.63),
    };

    const loop = () => {
      if (!mounted) return;

      const video = document.querySelector('video');
      if (video && video.readyState >= 2) {
        const result = analyzeFrameWithStability(video, scanArea);
        // Gate auto-scan through the same role/quota check as manual scan so a
        // guest / over-quota user in the scanner UI can't auto-record cards.
        if (result.isStable && result.confidence > 0.85 && canScanNow()) {
          const now = Date.now();
          if (now - lastScanTimeRef.current > SCAN_COOLDOWN_MS) {
            lastScanTimeRef.current = now;
            captureAndRecognize();
          }
        }
      }

      autoScanRef.current = requestAnimationFrame(loop);
    };

    autoScanRef.current = requestAnimationFrame(loop);
    return () => {
      mounted = false;
      if (autoScanRef.current) {
        cancelAnimationFrame(autoScanRef.current);
      }
    };
  }, [isCameraReady, autoScanActive, isScanning, isProcessingOCR, candidateSelector.visible, resultCard.visible]);

  const toggleFlash = () => {
    setFlash(current => !current);
  };

  const handleScanAreaLayout = (event: LayoutChangeEvent) => {
    if (!isWeb) return;
    const target: any = (event.nativeEvent as any).target;
    if (target && typeof target.getBoundingClientRect === 'function') {
      const rect = target.getBoundingClientRect();
      scanAreaViewportRef.current = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height,
      };
      return;
    }
    const { x, y, width, height } = event.nativeEvent.layout;
    scanAreaViewportRef.current = { x, y, width, height };
  };

  // Web 版無法使用 expo-ocr-kit，用 Tesseract.js 兜底。
  // Native branch delegates to nativeOcrRecognize (src/services/nativeOcr.ts)
  // so the require-throw / missing-export / recognizeText-throws /
  // recognizeText-rejects failure modes each resolve to '' from ONE tested
  // choke point. DIC-1289 CR called out that inline try/catch shape here
  // was not mutation-sensitive; the extracted module is covered by
  // behavioural tests in scripts/test-scan-screen-fail-safe.mjs that
  // invoke every branch through injected requireImpl mocks.
  const performOcr = async (uri: string): Promise<string> => {
    if (isWeb) {
      const result = await recognizeTextWeb(uri);
      return typeof result?.text === 'string' ? result.text : '';
    }
    return nativeOcrRecognize(uri);
  };

  const captureWebRecognitionImages = async (photoUri: string): Promise<string[]> => {
    const video = document.querySelector('video') as HTMLVideoElement | null;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) {
      return [photoUri];
    }

    const makeDataUrl = (
      sourceX: number,
      sourceY: number,
      sourceW: number,
      sourceH: number,
      maxDim: number,
    ) => {
      let w = sourceW;
      let h = sourceH;
      if (w > maxDim || h > maxDim) {
        if (w > h) { h = Math.round((h / w) * maxDim); w = maxDim; }
        else { w = Math.round((w / h) * maxDim); h = maxDim; }
      }
      const c = document.createElement('canvas');
      c.width = Math.round(w);
      c.height = Math.round(h);
      const ctx = c.getContext('2d');
      if (!ctx) return photoUri;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(video, sourceX, sourceY, sourceW, sourceH, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.92);
    };

    const fullImage = makeDataUrl(0, 0, video.videoWidth, video.videoHeight, 2048);
    const videoRect = video.getBoundingClientRect();
    const overlayRect = scanAreaViewportRef.current || {
      x: videoRect.left + (videoRect.width - SCAN_AREA_SIZE) / 2,
      y: videoRect.top + SCREEN_HEIGHT * 0.15,
      width: SCAN_AREA_SIZE,
      height: SCAN_AREA_SIZE * 0.63,
    };
    const crop = mapViewportRectToSource(
      { x: videoRect.left, y: videoRect.top, width: videoRect.width || SCREEN_WIDTH, height: videoRect.height || SCREEN_HEIGHT },
      { width: video.videoWidth, height: video.videoHeight },
      overlayRect,
      { padXRatio: 0.14, padYRatio: 0.28 },
    );
    const cropImage = makeDataUrl(crop.x, crop.y, crop.width, crop.height, 1536);
    return [fullImage, cropImage];
  };

  // Single role/quota gate, read from live store state (no stale closures — the
  // auto-scan rAF loop calls this outside the render cycle).
  const canScanNow = (): boolean => {
    // effectiveRole collapses subscriber→free_user in Store MVP, so unlimited
    // scan is never granted when premium is disabled (CR DIC-913 #2).
    const currentRole = effectiveRole(useAuthStore.getState().role);
    if (currentRole === 'guest') return false;
    if (currentRole === 'subscriber') return true;
    return getRemaining() > 0;
  };

  const promptScanBlocked = () => {
    const currentRole = effectiveRole(useAuthStore.getState().role);
    if (currentRole === 'guest') {
      // Route to the real login flow: clearing the guest session drops the app
      // back to LoginScreen (no-op CTA removed — CR DIC-913 #4).
      Alert.alert(t('scan_login_title'), t('scan_login_body'), [
        { text: t('common_cancel'), style: 'cancel' },
        { text: t('scan_login_action'), onPress: () => useAuthStore.getState().logout() },
      ]);
      return;
    }
    // Store MVP 不賣訂閱，額度已滿時不露出升級/付費入口（DIC-908）。
    if (FEATURES.premium) {
      Alert.alert(t('scan_quota_title'), t('scan_quota_premium_body'), [
        { text: t('scan_later'), style: 'cancel' },
        { text: t('scan_upgrade'), onPress: () => {} },
      ]);
      return;
    }
    Alert.alert(t('scan_quota_title'), t('scan_quota_body'), [
      { text: t('scan_ok'), style: 'cancel' },
    ]);
  };

  // 相機辨識流程本身住在 scanRecognitionFlow，這兩個 adapter 只把 I/O 與 setState 接上，
  // 所以 Node 回歸能執行到與相機完全相同的分支。
  const buildScanFlowIo = (recognitionImages?: string[]): ScanFlowIo => ({
    callRecognitionApi: async () => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RECOGNITION_REQUEST_TIMEOUT_MS);
      try {
        const resp = await fetch(window.location.origin + '/api/recognize-card', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            image: recognitionImages?.[0],
            images: recognitionImages,
            storeMvp: STORE_MVP,
          }),
          signal: controller.signal,
        });
        return { status: resp.status, body: await resp.json() };
      } finally {
        clearTimeout(timeoutId);
      }
    },
    recognizeFromImage: (uri) => recognizeCardFromImage(uri),
    ocrText: (uri) => performOcr(uri),
    recognizeFromOcr: (text) => recognizeCardFromOcr(text),
    searchCards: (text, limit) => searchCards(text, limit),
    mapApiCard,
    mapApiCandidates,
  });

  const scanFlowUi: ScanFlowUi = {
    setStatus: (label, progress) => {
      setScanningStatus(label);
      if (progress !== undefined) setScanProgress(progress);
    },
    setBusy: (busy) => {
      setIsProcessingOCR(busy);
      setIsScanning(busy);
    },
    setScanError,
    setSearchError,
    setSearchResults,
    setSuggestions,
    setRecognizedText,
    setCandidateReason,
    showLowConfidenceCandidates: (candidates) => {
      resetAutoScan();
      setCandidateSelector({ visible: true, tier: 'low', candidates });
    },
    onRecognized: handleRecognized,
    onVisionRecognized: (card, confidence) => {
      if (!commitCard(card)) return;
      setResultCard({ visible: true, card, confidence });
      setSearchResults([]);
      setSearchError(null);
      setSuggestions([]);
      setCapturedPhotoUri(null);
      resetAutoScan();
    },
  };

  // OCR 識別功能（支援 web/native，自動降級）
  const captureAndRecognize = async () => {
    // Enforce the same role/quota gate as handleScan. Auto-scan and retry paths
    // funnel through here, so guests / over-quota users can't trigger recognition.
    // Silent by design — auto-scan must not spam alerts; interactive callers
    // prompt via handleScan.
    if (!canScanNow()) return;
    if (isWeb) {
      if (!webCameraRef.current) {
        Alert.alert(t('scan_error_title'), t('scan_camera_not_ready'));
        return;
      }
    } else if (!cameraRef.current) {
      Alert.alert(t('scan_error_title'), t('scan_camera_not_ready'));
      return;
    }

    try {
      setIsProcessingOCR(true);
      setIsScanning(true);
      setScanningStatus(t('scan_taking_photo'));
      setScanProgress(1);
      setScanError(null);
      setCapturedPhotoUri(null);

      // 拍攝照片
      let photo;
      if (isWeb) {
        photo = await webCameraRef.current?.takePictureAsync({
          quality: 0.8,
        });
      } else {
        photo = await cameraRef.current?.takePictureAsync({
          quality: 0.8,
        });
      }

      if (!photo?.uri) {
        throw new Error(t('scan_capture_failed'));
      }

      // 儲存照片 uri 用於預覽
      setCapturedPhotoUri(photo.uri);

      if (isWeb) {
        setScanningStatus(t('scan_processing_image'));
        setScanProgress(2);
        const recognitionImages = await captureWebRecognitionImages(photo.uri);
        await runWebCameraScan(photo.uri, buildScanFlowIo(recognitionImages), scanFlowUi);
      } else {
        await runNativeCameraScan(photo.uri, buildScanFlowIo(), scanFlowUi);
      }
    } catch (error) {
      console.error('OCR Error:', error);
      setIsProcessingOCR(false);
      setIsScanning(false);
      setScanningStatus('');
      setScanProgress(0);

      setScanError(t('scan_failed_retry_manual'));
    } finally {
      // Reset auto-scan stability buffer on every exit (success or failure) so the
      // same still frame can't immediately re-trigger a scan. Combined with the
      // store-level dedup, this keeps a single card from being recorded twice.
      resetAutoScan();
    }
  };

  // 從相冊選擇圖片進行識別
  const pickFromGallery = async () => {
    if (!canScanNow()) {
      promptScanBlocked();
      return;
    }
    try {
      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]?.uri) {
        setIsProcessingOCR(true);
        setIsScanning(true);

        setScanError(null);
        setCapturedPhotoUri(result.assets[0].uri);

        const galleryVisionResult = await recognizeCardFromImage(result.assets[0].uri);
        if (galleryVisionResult.success && galleryVisionResult.card) {
          setIsProcessingOCR(false);
          setIsScanning(false);
          // Route through handleRecognized rather than committing here. This
          // branch used to call commitCard directly, ahead of its own
          // lowConfidence check below, so an unresolved printing was auto-added
          // before anything could offer the picker (DIC-1325). handleRecognized
          // is the single place that decides commit-vs-confirm, and it already
          // clears the search/suggestion state this block used to reset by hand.
          handleRecognized(
            galleryVisionResult.card,
            galleryVisionResult.confidence ?? 0.9,
            galleryVisionResult.candidates,
            isAmbiguousPrinting(galleryVisionResult),
          );
          return;
        }
        if (galleryVisionResult.lowConfidence || galleryVisionResult.suggestions?.length) {
          setIsProcessingOCR(false);
          setIsScanning(false);
          // Route through handleRecognized so the exact-printing picker opens
          // and commitCard stays at zero until the user picks — same decision
          // point the success branch above uses (DIC-1325 / DIC-1339). The
          // typed candidates carry their own compound printing ids so
          // whichever the user picks resolves to an exact printing at commit.
          const typedCandidates = galleryVisionResult.candidates;
          if (typedCandidates && typedCandidates.length > 0) {
            const first = typedCandidates[0];
            handleRecognized(
              first.card,
              galleryVisionResult.confidence ?? first.confidence ?? 0,
              typedCandidates,
              isAmbiguousPrinting(galleryVisionResult),
            );
            return;
          }
          // The API always populates candidates alongside `lowConfidence`, so
          // this fallback only fires for legacy shapes (local-OCR suggestions
          // without a typed candidate list). Still no commit — surface the
          // suggestions in the search panel for manual selection.
          const candidateCards = galleryVisionResult.suggestions || [];
          setSearchResults(candidateCards);
          setSuggestions(candidateCards);
          setSearchError(localizedError(galleryVisionResult.error, 'scan_confidence_low'));
          setCandidateReason(t('scan_confidence_reason', {
            percent: Math.round((galleryVisionResult.confidence || 0) * 100),
            reason: preferredLanguage === 'ja' ? t('scan_manual_review') : (galleryVisionResult.reason || t('scan_manual_review')),
          }));
          if (galleryVisionResult.raw) setRecognizedText(galleryVisionResult.raw);
          return;
        }

        // When the recognition backend is unavailable the local OCR passes below are
        // only a best-effort fallback, so their failure says nothing about the photo.
        const noTextError = galleryVisionResult.serviceUnavailable
          ? t('scan_service_unavailable')
          : t('scan_no_text_guidance');

        if (isWeb) {
          // Web: 卡號優先 OCR
          const cardResult = await recognizeCardFromImage(result.assets[0].uri);

          setIsProcessingOCR(false);
          setIsScanning(false);

          if (cardResult.success && cardResult.card) {
            handleRecognized(cardResult.card, cardResult.confidence ?? 0.85, cardResult.candidates, isAmbiguousPrinting(cardResult));
          } else {
            // Fallback 到全圖 OCR
            const recognizedText = await recognizeTextWeb(result.assets[0].uri);
            const trimmedText = recognizedText.text.trim();
            setRecognizedText(trimmedText);

            if (trimmedText.length > 0) {
              const fallbackResult = await recognizeCardFromOcr(trimmedText);
              if (fallbackResult.success && fallbackResult.card) {
                handleRecognized(fallbackResult.card, fallbackResult.confidence ?? 0.85, fallbackResult.candidates, isAmbiguousPrinting(fallbackResult));
                return;
              }
              setSearchError(localizedError(fallbackResult.error, 'scan_no_match'));
              const searchResult = await searchCards(trimmedText, 10);
              setSearchResults(searchResult);
            } else {
              setScanError(noTextError);
            }
          }
        } else {
          const recognizedText = await performOcr(result.assets[0].uri);
          const trimmedText = recognizedText.trim();
          setRecognizedText(trimmedText);

          setIsProcessingOCR(false);
          setIsScanning(false);

          if (trimmedText.length > 0) {
            const cardResult = await recognizeCardFromOcr(trimmedText);
            if (cardResult.success && cardResult.card) {
              handleRecognized(cardResult.card, cardResult.confidence ?? 0.85, cardResult.candidates, isAmbiguousPrinting(cardResult));
            } else {
              setSearchError(localizedError(cardResult.error, 'scan_no_match'));
              const searchResult = await searchCards(trimmedText, 10);
              setSearchResults(searchResult);
            }
          } else {
            setScanError(noTextError);
          }
        }
      }
    } catch (error) {
      console.error('Gallery OCR Error:', error);
      setIsProcessingOCR(false);
      setIsScanning(false);
      setScanError(t('scan_image_failed'));
    }
  };

  const handleScan = () => {
    if (isScanning || isProcessingOCR) return;
    if (!canScanNow()) {
      promptScanBlocked();
      return;
    }
    captureAndRecognize();
  };

  // 當權限被授予時，設置標記並等待相機準備
  useEffect(() => {
    if (permission?.granted && !permissionJustGranted) {
      setPermissionJustGranted(true);
      setIsCameraReady(false);
      setCameraError(null);
    }
  }, [permission?.granted]);

  // 相機準備好的回調
  const handleCameraReady = () => {
    setIsCameraReady(true);
    setCameraError(null);
  };

  // 相機載入錯誤的回調
  const handleMountError = (error: { message?: string }) => {
    const errorMessage = preferredLanguage === 'ja'
      ? t('scan_camera_load_failed')
      : (error?.message || t('scan_camera_load_failed'));
    setCameraError(errorMessage);
    setIsCameraReady(false);
  };

  const handleRetry = () => {
    setCameraError(null);
    if (isWeb && webCameraRef.current) {
      webCameraRef.current.retry();
    } else {
      setIsCameraReady(false);
    }
  };
  
  // 演示識別功能
  const demoRecognition = async () => {
    const demoNames = ['博衣こより', '雪花ラミィ', 'ラプラス・ダークネス', '大空スバル'];
    const randomName = demoNames[Math.floor(Math.random() * demoNames.length)];
    
    const result = await recognizeCard(randomName);
    if (result.success && result.card) {
      setSearchResults([]);
      setSearchError(null);
      setRecognizedCard(result.card);
      setSuggestions(result.suggestions || []);
    } else {
      setSearchError(localizedError(result.error, 'scan_recognition_failed'));
    }
  };
  
  // 執行搜尋
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      Alert.alert(t('scan_input_required'));
      return;
    }
    
    const result = await recognizeCard(searchQuery);
    if (result.success && result.card) {
      setSearchResults([]);
      setSearchError(null);
      setRecognizedCard(result.card);
      setSuggestions(result.suggestions || []);
      setShowSearch(false);
      setSearchQuery('');
    } else {
      setSearchError(localizedError(result.error, 'scan_no_match'));
      // 顯示搜尋結果作為建議
      const searchResult = await searchCards(searchQuery, 5);
      setSearchResults(searchResult);
    }
  };
  
  // 選擇建議的卡牌（使用者已確認 → 加入，帶重複防護）
  const handleSelectSuggestion = (card: CardInfo) => {
    // Route through the single record choke point: selecting a search/OCR
    // suggestion records a card into the scan session.
    setSuggestions([]);
    setSearchResults([]);
    if (commitCard(card)) {
      setRecognizedCard(card);
      setResultCard({ visible: true, card, confidence: 1 });
    }
  };
  
  // 清除結果
  const clearResult = () => {
    setRecognizedCard(null);
    setSuggestions([]);
    setSearchError(null);
    setScanComplete(false);
  };

  // DIC-1286 CR fix: use RN's cross-platform Linking.openSettings() so the
  // "打開設定 / 設定を開く" button really opens the app settings screen on
  // Android too (Linking.openURL('app-settings:') is an iOS-only URL
  // scheme, and did nothing on Android — leaving users with
  // canAskAgain === false unable to recover). Wrapped in try/catch so a
  // rare native throw from a broken Linking module never bubbles out of
  // an event handler. Non-Android/iOS platforms (web) still fall through
  // via the iOS scheme for backwards compatibility.
  const openSettings = () => {
    try {
      if (Platform.OS === 'ios' || Platform.OS === 'android') {
        const maybe = Linking.openSettings();
        if (maybe && typeof (maybe as Promise<void>).catch === 'function') {
          (maybe as Promise<void>).catch((err) => {
            console.warn('[ScanScreen] Linking.openSettings rejected', err);
          });
        }
        return;
      }
      Linking.openURL('app-settings:');
    } catch (err) {
      console.warn('[ScanScreen] openSettings failed', err);
    }
  };

  // === Web 版：不用 expo-camera 權限，直接讓 WebCamera 處理 getUserMedia ===
  if (isWeb && !webCameraStarted) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionIcon}>📷</Text>
          <Text style={styles.permissionTitle}>{t('scan_permission_title')}</Text>
          <Text style={styles.permissionText}>{t('scan_permission_web_body')}</Text>
          <TouchableOpacity 
            style={styles.permissionButton}
            onPress={async () => {
              // iOS Safari 的 getUserMedia 必須在點擊事件手勢鏈中直接呼叫
              // 先等 stream 拿到再 mount WebCamera，避免 timing 競爭
              try {
                const stream = await navigator.mediaDevices.getUserMedia({
                  video: { facingMode: 'environment' },
                  audio: false,
                });
                webStreamRef.current = stream;
                setWebCameraStarted(true);
              } catch (e: any) {
                setCameraError(preferredLanguage === 'ja' ? t('scan_camera_open_failed') : (e?.message || t('scan_camera_open_failed')));
                setIsCameraReady(false);
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.permissionButtonText}>{t('scan_permission_allow')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={openSettings}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsButtonText}>{t('scan_open_settings')}</Text>
          </TouchableOpacity>
          {/* 相機權限卡住或裝置無鏡頭時的 fallback：改用相簿上傳 */}
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => {
              setWebGalleryMode(true);
              setWebCameraStarted(true);
              pickFromGallery();
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsButtonText}>{t('scan_use_gallery')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  // === Native 版：用 expo-camera 權限系統 ===
  if (!isWeb) {
    // 权限请求中
    if (!permission) {
      return (
        <View style={styles.container}>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>{t('scan_camera_loading')}</Text>
          </View>
        </View>
      );
    }

    // 权限被拒绝 — DIC-1286 CR: delegate to CameraPermissionDeniedView so
    // Android permanent denial (canAskAgain === false) really has a working
    // recovery path (opens system settings) and the retry button is only
    // shown when it can actually reopen the OS prompt.
    if (!permission.granted) {
      return (
        <View style={styles.container}>
          <CameraPermissionDeniedView
            permission={permission}
            onRequestPermission={requestPermission}
            openSettingsImpl={openSettings}
            refreshPermission={getCameraPermissions}
            onPickGallery={pickFromGallery}
          />
        </View>
      );
    }
  }

  return (
    <View style={styles.container}>
      <ScanQuotaBanner />
      {/* 初始化中遮罩 — 相機在下面照常 mount，讓 getUserMedia 有機會啟動 */}
      {!isCameraReady && !webGalleryMode && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>{t('scan_camera_initializing')}</Text>
            {cameraError && (
              <View style={resultStyles.errorContainer}>
                <Text style={resultStyles.errorText}>❌ {cameraError}</Text>
                <TouchableOpacity 
                  style={resultStyles.retryButton}
                  onPress={() => {
                    setCameraError(null);
                    if (isWeb && webCameraRef.current) {
                      webCameraRef.current.retry();
                    } else {
                      setIsCameraReady(false);
                    }
                  }}
                >
                  <Text style={resultStyles.retryText}>{t('common_retry')}</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      )}
      {/* 相机预览 — 一定會 mount，不會被初始化中判斷擋住 */}
{isWeb && webGalleryMode ? (
        <View style={[styles.camera, styles.galleryModeContainer]}>
          <Text style={styles.galleryModeIcon}>🖼️</Text>
          <Text style={styles.galleryModeTitle}>{t('scan_gallery_title')}</Text>
          <Text style={styles.galleryModeText}>{t('scan_gallery_body')}</Text>
          <TouchableOpacity
            style={styles.permissionButton}
            onPress={pickFromGallery}
            activeOpacity={0.7}
          >
            <Text style={styles.permissionButtonText}>{t('scan_choose_photo')}</Text>
          </TouchableOpacity>
          <TouchableOpacity
            style={styles.settingsButton}
            onPress={() => {
              setWebGalleryMode(false);
              setWebCameraStarted(false);
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsButtonText}>{t('scan_back_to_camera')}</Text>
          </TouchableOpacity>
        </View>
      ) : isWeb ? (
        <WebCamera
          ref={webCameraRef}
          style={styles.camera}
          facing={facing}
          initialStream={webStreamRef.current}
          onCameraReady={handleCameraReady}
          onMountError={handleMountError}
        >
          <ScanOverlay
            scanLineAnim={scanLineAnim}
            pulseAnim={pulseAnim}
            borderAnim={borderAnim}
            isScanning={isScanning}
            flash={flash}
            autoScanActive={autoScanActive}
            isCameraReady={isCameraReady}
            cameraError={cameraError}
            onFlash={toggleFlash}
            onScan={handleScan}
            onGallery={pickFromGallery}
            onScanAreaLayout={handleScanAreaLayout}
            onRetry={() => {
              setCameraError(null);
              if (webCameraRef.current) webCameraRef.current.retry();
              else setIsCameraReady(false);
            }}
          />
        </WebCamera>
      ) : (
        <CameraView
          ref={cameraRef}
          style={styles.camera}
          facing={facing}
          flash={flash ? 'on' : 'off'}
          onCameraReady={handleCameraReady}
          onMountError={handleMountError}
        >
          <ScanOverlay
            scanLineAnim={scanLineAnim}
            pulseAnim={pulseAnim}
            borderAnim={borderAnim}
            isScanning={isScanning}
            flash={flash}
            autoScanActive={autoScanActive}
            isCameraReady={isCameraReady}
            cameraError={cameraError}
            onFlash={toggleFlash}
            onScan={handleScan}
            onGallery={pickFromGallery}
            onRetry={() => {
              setCameraError(null);
              if (webCameraRef.current) webCameraRef.current.retry();
              else setIsCameraReady(false);
            }}
          />
        </CameraView>
      )}
      
      {/* Floating result card */}
      <ScanResultCard
        card={resultCard.card!}
        visible={resultCard.visible}
        confidence={resultCard.confidence}
        preferredCurrency={preferredCurrency}
        preferredLanguage={preferredLanguage}
        onDismiss={() => { setResultCard({ visible: false, card: null, confidence: 0 }); }}
      />

      {/* 中/低信心候選確認選擇器 */}
      <ScanCandidateSelector
        visible={candidateSelector.visible}
        tier={candidateSelector.tier}
        candidates={candidateSelector.candidates}
        preferredCurrency={preferredCurrency}
        preferredLanguage={preferredLanguage}
        onSelect={handleConfirmCandidate}
        onRescan={() => { closeCandidateSelector(); handleScan(); }}
        onManualSearch={() => { closeCandidateSelector(); setShowSearch(true); }}
        onDismiss={closeCandidateSelector}
      />

      {/* 最後掃描的卡牌確認提示 */}
      {lastScannedCard && (
        <View style={resultStyles.toastContainer}>
          <View style={resultStyles.toast}>
            <View style={resultStyles.toastContent}>
              <Text style={resultStyles.toastIcon}>✅</Text>
              <View style={resultStyles.toastTextContainer}>
                <Text style={resultStyles.toastName} numberOfLines={1}>
                  {lastScannedCard.name}
                </Text>
                {/* 「最後掃描」toast 的售價 — Store MVP 也顯示 (DIC-1319)：這是
                    剛掃到那張卡自己的售價，掃描→查價的主路徑回饋。 */}
                {FEATURES.sellPrice && (
                  <Text style={resultStyles.toastPrice} testID="scan-toast-price">
                    {(() => {
                      if (lastScannedCard.sellPrice == null) return '—';
                      if (preferredCurrency === 'JPY') return `¥${lastScannedCard.sellPrice.toLocaleString()}`;
                      const { value, symbol } = convertPrice(lastScannedCard.sellPrice, preferredCurrency);
                      return `${symbol}${value?.toLocaleString() || '—'}`;
                    })()}
                  </Text>
                )}
              </View>
            </View>
            <TouchableOpacity
              style={resultStyles.toastAddBtn}
              onPress={() => {
                // Explicit "add one more of the same card" — bypasses dedup but
                // still costs one quota credit; blocked users get the prompt, no add.
                if (!incrementScan()) {
                  promptScanBlocked();
                  return;
                }
                addCard(lastScannedCard, { force: true });
              }}
            >
              <Text style={resultStyles.toastAddText}>{t('scan_add_another')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              onPress={() => setLastScannedCard(null)}
            >
              <Text style={resultStyles.toastClose}>✕</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      
      {/* 錯誤提示（搜索失敗） */}
      {searchError && !recognizedCard && (
        <View style={resultStyles.errorContainer}>
          <Text style={resultStyles.errorText}>❌ {searchError}</Text>
          <View style={resultStyles.errorActions}>
            <TouchableOpacity
              style={resultStyles.retryButton}
              onPress={() => {
                setSearchError(null);
                setShowSearch(true);
              }}
            >
              <Text style={resultStyles.retryText}>{t('scan_manual_search')}</Text>
            </TouchableOpacity>
            {recognizedText ? (
              <TouchableOpacity
                style={resultStyles.debugButton}
                onPress={() => {
                  Alert.alert(t('scan_debug_title'), t('scan_debug_body', { text: recognizedText }));
                }}
              >
                <Text style={resultStyles.debugText}>{t('scan_view_debug')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        </View>
      )}

      {/* 掃描進度面板 */}
      {isScanning && scanningStatus ? (
        <View style={progressStyles.container}>
          {/* 進度條 */}
          <View style={progressStyles.barTrack}>
            <View style={[progressStyles.barFill, { width: `${(scanProgress / 4) * 100}%` }]} />
          </View>
          {/* 步驟清單 */}
          <View style={progressStyles.stepsRow}>
            {[t('scan_step_capture'), t('scan_step_process'), t('scan_step_recognize'), t('scan_step_done')].map((label, i) => {
              const step = i + 1;
              const isActive = scanProgress === step;
              const isDone = scanProgress > step;
              return (
                <View key={i} style={progressStyles.stepItem}>
                  <View style={[
                    progressStyles.stepDot,
                    isActive && progressStyles.stepDotActive,
                    isDone && progressStyles.stepDotDone,
                  ]}>
                    {isDone ? <Text style={progressStyles.stepCheck}>✓</Text> : null}
                  </View>
                  <Text style={[
                    progressStyles.stepLabel,
                    (isActive || isDone) && progressStyles.stepLabelActive,
                  ]} numberOfLines={1}>{label}</Text>
                </View>
              );
            })}
          </View>
          <Text style={progressStyles.statusText}>{scanningStatus}</Text>
        </View>
      ) : null}

      {/* 掃描失敗提示（OCR 回傳空） */}
      {scanError && (
        <View style={resultStyles.errorContainer}>
          <Text style={resultStyles.errorText}>⚠️ {scanError}</Text>
          <View style={resultStyles.errorActions}>
            <TouchableOpacity
              style={resultStyles.retryButton}
              onPress={() => {
                setScanError(null);
                setShowSearch(true);
              }}
            >
              <Text style={resultStyles.retryText}>{t('scan_manual_search')}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={resultStyles.retryButton}
              onPress={handleScan}
            >
              <Text style={resultStyles.retryText}>{t('scan_retry_scan')}</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      
      {/* 搜尋建議列表 */}
      {searchResults.length > 0 && (
        <View style={resultStyles.suggestionsListContainer}>
          <Text style={resultStyles.suggestionsTitle}>{candidateReason || t('scan_results')}</Text>
          <ScrollView style={resultStyles.suggestionsList}>
            {searchResults.map((card, index) => (
              <TouchableOpacity 
                key={index}
                style={resultStyles.listItem}
                onPress={() => handleSelectSuggestion(card)}
              >
                <Text style={resultStyles.listItemName}>{card.name}</Text>
                <Text style={resultStyles.listItemMeta}>{card.cardNumber} · {card.rarity} · {card.series}</Text>
                {/* 手動搜尋建議列的售價 — Store MVP 也顯示 (DIC-1319)，與掃描
                    結果同一種單卡售價。 */}
                {FEATURES.sellPrice && (
                  <Text style={resultStyles.listItemPrice} testID="scan-search-suggestion-price">
                    ¥{card.sellPrice?.toLocaleString() || t('scan_no_trade')}
                  </Text>
                )}
              </TouchableOpacity>
            ))}
          </ScrollView>
        </View>
      )}
      
      {/* 手動搜尋 Modal */}
      <Modal
        visible={showSearch}
        animationType="slide"
        transparent={true}
        onRequestClose={() => setShowSearch(false)}
      >
        <View style={modalStyles.modalOverlay}>
          <View style={modalStyles.modalContent}>
            <Text style={modalStyles.modalTitle}>{t('scan_search_modal')}</Text>
            <TextInput
              style={modalStyles.searchInput}
              placeholder={t('scan_search_placeholder')}
              placeholderTextColor="#999"
              value={searchQuery}
              onChangeText={setSearchQuery}
              autoFocus={true}
            />
            <View style={modalStyles.modalButtons}>
              <TouchableOpacity 
                style={modalStyles.searchButton}
                onPress={handleSearch}
              >
                <Text style={modalStyles.searchButtonText}>{t('common_search')}</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={modalStyles.cancelButton}
                onPress={() => {
                  setShowSearch(false);
                  setSearchQuery('');
                }}
              >
                <Text style={modalStyles.cancelText}>{t('common_cancel')}</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      
      {/* 掃描估值面板 */}
      <ScanSessionPanel
        preferredCurrency={preferredCurrency}
        onViewCard={(card) => navigation?.navigate('CardDetail', { card })}
        onContinueScanning={() => {
          setLastScannedCard(null);
          setScanComplete(false);
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.background,
  },
  camera: {
    flex: 1,
  },
  galleryModeContainer: {
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
    backgroundColor: COLORS.background,
  },
  galleryModeIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  galleryModeTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  galleryModeText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  loadingOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    backgroundColor: COLORS.background,
  },
  loadingContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },
  permissionContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 40,
  },
  permissionIcon: {
    fontSize: 64,
    marginBottom: 20,
  },
  permissionTitle: {
    color: COLORS.text,
    fontSize: 22,
    fontWeight: 'bold',
    marginBottom: 12,
  },
  permissionText: {
    color: COLORS.textSecondary,
    fontSize: 14,
    textAlign: 'center',
    lineHeight: 22,
    marginBottom: 30,
  },
  permissionButton: {
    backgroundColor: COLORS.primary,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 25,
    marginBottom: 12,
  },
  permissionButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  settingsButton: {
    paddingVertical: 12,
    paddingHorizontal: 30,
  },
  settingsButtonText: {
    color: COLORS.textSecondary,
    fontSize: 14,
  },
  overlay: {
    flex: 1,
  },
  overlayTop: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scanAreaContainer: {
    flexDirection: 'row',
  },
  overlaySide: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
  },
  scanArea: {
    width: SCAN_AREA_SIZE,
    height: SCAN_AREA_SIZE * 0.63, // 卡片比例
    position: 'relative',
    borderWidth: 2,
    borderColor: COLORS.primary,
    borderRadius: 8,
    overflow: 'hidden',
  },
  scanLine: {
    position: 'absolute',
    left: 10,
    right: 10,
    height: 3,
    backgroundColor: COLORS.primary,
    borderRadius: 2,
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 0 },
    shadowOpacity: 0.8,
    shadowRadius: 4,
  },
  corner: {
    position: 'absolute',
    width: 24,
    height: 24,
    borderColor: COLORS.primary,
  },
  topLeft: {
    top: -1,
    left: -1,
    borderTopWidth: 4,
    borderLeftWidth: 4,
    borderTopLeftRadius: 8,
  },
  topRight: {
    top: -1,
    right: -1,
    borderTopWidth: 4,
    borderRightWidth: 4,
    borderTopRightRadius: 8,
  },
  bottomLeft: {
    bottom: -1,
    left: -1,
    borderBottomWidth: 4,
    borderLeftWidth: 4,
    borderBottomLeftRadius: 8,
  },
  bottomRight: {
    bottom: -1,
    right: -1,
    borderBottomWidth: 4,
    borderRightWidth: 4,
    borderBottomRightRadius: 8,
  },
  scanningIndicator: {
    position: 'absolute',
    bottom: 20,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  scanningText: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    paddingHorizontal: 16,
    paddingVertical: 6,
    borderRadius: 15,
  },
  overlayBottom: {
    flex: 1.2,
    backgroundColor: 'rgba(0, 0, 0, 0.6)',
    paddingTop: 30,
    alignItems: 'center',
  },
  hintText: {
    color: COLORS.text,
    fontSize: 16,
    marginBottom: 30,
    textShadowColor: 'rgba(0, 0, 0, 0.8)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 3,
  },
  controls: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    width: '100%',
    paddingHorizontal: 20,
  },
  controlBtn: {
    alignItems: 'center',
    padding: 10,
  },
  controlBtnActive: {
    opacity: 1,
  },
  controlIcon: {
    fontSize: 28,
    marginBottom: 6,
  },
  controlLabel: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  scanButton: {
    alignItems: 'center',
  },
  scanButtonDisabled: {
    opacity: 0.6,
  },
  scanButtonInner: {
    width: 72,
    height: 72,
    borderRadius: 36,
    backgroundColor: COLORS.primary,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 4,
    borderColor: '#fff',
    shadowColor: COLORS.primary,
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.4,
    shadowRadius: 8,
    elevation: 8,
  },
  scanButtonIcon: {
    fontSize: 32,
  },
  scanButtonLabel: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 8,
  },
});

// 結果顯示樣式
const resultStyles = StyleSheet.create({
  resultContainer: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.9)',
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    paddingBottom: 40,
  },
  resultCard: {
    alignItems: 'center',
  },
  resultTitle: {
    color: COLORS.primary,
    fontSize: 18,
    fontWeight: 'bold',
    marginBottom: 16,
  },
  cardInfo: {
    alignItems: 'center',
    marginBottom: 12,
  },
  cardName: {
    color: COLORS.text,
    fontSize: 16,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 4,
  },
  cardId: {
    color: COLORS.textSecondary,
    fontSize: 12,
  },
  priceContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    marginVertical: 8,
  },
  priceLabel: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginRight: 8,
  },
  priceValue: {
    color: '#00C853',
    fontSize: 28,
    fontWeight: 'bold',
  },
  timestamp: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 4,
  },
  suggestions: {
    marginTop: 16,
    width: '100%',
  },
  suggestionsTitle: {
    color: COLORS.textSecondary,
    fontSize: 14,
    marginBottom: 8,
  },
  suggestionCard: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 8,
    padding: 8,
    marginRight: 10,
    width: 100,
    alignItems: 'center',
  },
  suggestionName: {
    color: COLORS.text,
    fontSize: 11,
    textAlign: 'center',
    marginBottom: 4,
  },
  suggestionPrice: {
    color: COLORS.primary,
    fontSize: 12,
    fontWeight: '600',
  },
  resultActions: {
    flexDirection: 'row',
    marginTop: 20,
    gap: 12,
  },
  actionButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 20,
  },
  actionText: {
    color: COLORS.text,
    fontSize: 14,
  },
  closeButton: {
    backgroundColor: COLORS.primary,
  },
  closeText: {
    color: '#fff',
    fontSize: 14,
  },
  // Toast notification for last scanned card
  toastContainer: {
    position: 'absolute',
    top: 60,
    left: 20,
    right: 20,
    zIndex: 30,
  },
  toast: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: 12,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  toastContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
  },
  toastIcon: {
    fontSize: 20,
  },
  toastTextContainer: {
    flex: 1,
  },
  toastName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  toastPrice: {
    color: '#00C853',
    fontSize: 13,
    fontWeight: 'bold',
    marginTop: 2,
  },
  toastAddBtn: {
    backgroundColor: 'rgba(0, 200, 83, 0.2)',
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    marginLeft: 8,
  },
  toastAddText: {
    color: '#00C853',
    fontSize: 12,
    fontWeight: '600',
  },
  toastClose: {
    color: COLORS.textSecondary,
    fontSize: 16,
    paddingLeft: 8,
  },
  errorContainer: {
    position: 'absolute',
    bottom: 100,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(255, 82, 82, 0.9)',
    borderRadius: 12,
    padding: 16,
    alignItems: 'center',
  },
  errorText: {
    color: '#fff',
    fontSize: 14,
    marginBottom: 10,
    textAlign: 'center',
  },
  errorActions: {
    flexDirection: 'row',
    gap: 10,
    flexWrap: 'wrap',
    justifyContent: 'center',
  },
  retryButton: {
    backgroundColor: '#fff',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 16,
  },
  retryText: {
    color: '#FF5252',
    fontSize: 14,
    fontWeight: '600',
  },
  debugButton: {
    backgroundColor: 'rgba(255, 255, 255, 0.3)',
    paddingHorizontal: 20,
    paddingVertical: 8,
    borderRadius: 16,
  },
  debugText: {
    color: '#fff',
    fontSize: 14,
  },
  suggestionsListContainer: {
    position: 'absolute',
    bottom: 100,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(26, 26, 46, 0.95)',
    borderRadius: 12,
    padding: 16,
    maxHeight: 250,
  },
  suggestionsList: {
    maxHeight: 200,
  },
  listItem: {
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  listItemName: {
    color: COLORS.text,
    fontSize: 14,
    fontWeight: '600',
  },
  listItemMeta: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  listItemPrice: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
    marginTop: 2,
  },
});

// Modal 樣式
const modalStyles = StyleSheet.create({
  modalOverlay: {
    flex: 1,
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    justifyContent: 'center',
    alignItems: 'center',
  },
  modalContent: {
    backgroundColor: COLORS.background,
    borderRadius: 16,
    padding: 24,
    width: SCREEN_WIDTH * 0.85,
    alignItems: 'center',
  },
  modalTitle: {
    color: COLORS.text,
    fontSize: 20,
    fontWeight: 'bold',
    marginBottom: 20,
  },
  searchInput: {
    width: '100%',
    backgroundColor: 'rgba(255, 255, 255, 0.1)',
    borderRadius: 12,
    paddingHorizontal: 16,
    paddingVertical: 14,
    color: COLORS.text,
    fontSize: 16,
    marginBottom: 20,
  },
  modalButtons: {
    flexDirection: 'row',
    gap: 12,
  },
  searchButton: {
    backgroundColor: COLORS.primary,
    paddingHorizontal: 32,
    paddingVertical: 12,
    borderRadius: 24,
  },
  searchButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
  cancelButton: {
    paddingHorizontal: 32,
    paddingVertical: 12,
  },
  cancelText: {
    color: COLORS.textSecondary,
    fontSize: 16,
  },
});

// 掃描進度條樣式
const progressStyles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 110,
    left: 20,
    right: 20,
    backgroundColor: 'rgba(0, 0, 0, 0.85)',
    borderRadius: 16,
    padding: 16,
    paddingBottom: 12,
    alignItems: 'center',
    zIndex: 20,
  },
  barTrack: {
    width: '100%',
    height: 4,
    backgroundColor: 'rgba(255,255,255,0.15)',
    borderRadius: 2,
    marginBottom: 12,
    overflow: 'hidden',
  },
  barFill: {
    height: '100%',
    backgroundColor: '#007AFF',
    borderRadius: 2,
  },
  stepsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    width: '100%',
    marginBottom: 8,
  },
  stepItem: {
    alignItems: 'center',
    flex: 1,
  },
  stepDot: {
    width: 20,
    height: 20,
    borderRadius: 10,
    backgroundColor: 'rgba(255,255,255,0.2)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 4,
  },
  stepDotActive: {
    backgroundColor: '#007AFF',
    transform: [{ scale: 1.15 }],
  },
  stepDotDone: {
    backgroundColor: '#34C759',
  },
  stepCheck: {
    color: '#fff',
    fontSize: 12,
    fontWeight: 'bold',
  },
  stepLabel: {
    color: 'rgba(255,255,255,0.4)',
    fontSize: 11,
    textAlign: 'center',
  },
  stepLabelActive: {
    color: '#fff',
    fontWeight: '600',
  },
  statusText: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 4,
  },
});
