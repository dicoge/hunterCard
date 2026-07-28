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
} from 'react-native';
import { CameraView, useCameraPermissions, CameraType } from 'expo-camera';
import WebCamera, { WebCameraHandle } from '../components/WebCamera';
import ScanSessionPanel from '../components/ScanSessionPanel';
import { useScanSessionStore } from '../stores/scanSessionStore';
import * as ImagePicker from 'expo-image-picker';
import { COLORS, convertPrice } from '../constants';
import { recognizeCard, recognizeCardFromOcr, recognizeCardFromImage, searchCards, CardInfo } from '../services/cardRecognition';
import { recognizeTextWeb } from '../services/webOcr';
import ScanOverlay from '../components/ScanOverlay';
import ScanResultCard from '../components/ScanResultCard';
import {
  analyzeFrameWithStability,
  resetAutoScan,
  advanceScanLock,
  createScanLockState,
  lockAfterScan,
  computeCardSignature,
  shouldAnalyzeFrame,
  shouldTriggerAutoScan,
  canAcquireScanJob,
  type CardSignature,
  type ScanLockState,
  type ScanRect,
} from '../services/autoScanService';
import { useSettingsStore } from '../store/settingsStore';

// iOS Safari: getUserMedia 需直接從使用者手勢觸發
// 所以 web 版跳過 expo-camera 的 useCameraPermissions，改用 WebCamera 直接管
const isWeb = Platform.OS === 'web';
const SCAN_COOLDOWN_MS = 3000; // Don't re-scan same card within 3s
const OVERLAY_THROTTLE_MS = 500; // Under a result/search/error overlay, analyze at most every 500ms
const LIVE_UNLOCK_EMPTY_FRAMES = 10; // ~166ms at 60fps of no-card frames releases the lock (live loop)
const OVERLAY_UNLOCK_EMPTY_FRAMES = 2; // ~1s of no-card frames releases the lock (throttled overlay loop)
const AUTO_SCAN_CONFIDENCE = 0.85; // Minimum stability confidence to auto-trigger a capture

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');
const SCAN_AREA_SIZE = SCREEN_WIDTH * 0.75;

export default function ScanScreen() {
  // iOS web 不用 expo-camera 權限系統（避免 getUserMedia 手勢鏈中斷）
  const [permission, requestPermission] = isWeb ? [null, null] as any : useCameraPermissions();
  const [webCameraStarted, setWebCameraStarted] = useState(false);
  const [facing, setFacing] = useState<CameraType>('back');
  const cameraRef = useRef<CameraView>(null);
  const webCameraRef = useRef<WebCameraHandle>(null);
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

	// Auto-scan state & refs
  const [autoScanEnabled, setAutoScanEnabled] = useState<boolean>(true);
  const autoScanRef = useRef<number | null>(null);
  const lastScanTimeRef = useRef<number>(0);

  // Currency preference (from global settings)
  const { preferredCurrency, preferredLanguage } = useSettingsStore();

  // Scan locking and state management
  const isScanningRef = useRef<boolean>(false);
  const isGalleryPickingRef = useRef<boolean>(false);
  const lastAnalysisTimeRef = useRef<number>(0);
  // Auto-scan duplicate/card-swap lock (see autoScanService state machine).
  const scanLockRef = useRef<ScanLockState>(createScanLockState());
  // Signature of the card the in-flight auto-scan capture is processing.
  const pendingScanSignatureRef = useRef<CardSignature | null>(null);
  // Ref to the on-screen scan box (web: underlying DOM node) so we can measure
  // its real rendered rect instead of guessing its screen position.
  const scanAreaRef = useRef<any>(null);

  // Lock auto-scan after a successful capture so the same card isn't re-scanned.
  const lockScanAfterCapture = (signature: CardSignature | null) => {
    scanLockRef.current = lockAfterScan(signature);
  };
  // Fully release the lock (manual scan / retry — user explicitly wants a fresh capture).
  const unlockScan = () => {
    scanLockRef.current = createScanLockState();
    pendingScanSignatureRef.current = null;
  };
  // Resolve the scan box to a rectangle in window/viewport coordinates by
  // measuring the *actual* rendered scan-box element (getBoundingClientRect), so
  // the object-fit:cover inversion in autoScanService uses the true on-screen box
  // rather than a guessed Y. The video's getBoundingClientRect (read inside
  // autoScanService) lives in the same coordinate space, so the two line up.
  //
  // Fail closed: if the overlay ref hasn't mounted, exposes no
  // getBoundingClientRect, or measures a zero-area box, return null instead of a
  // guessed layout rect. The frame analysis and signature capture both treat null
  // as "no scan this frame", so we never fingerprint the wrong pixels. (These
  // functions are web-only; native never reaches this path.)
  const resolveScanArea = (): ScanRect | null => {
    const node: any = scanAreaRef.current;
    if (node && typeof node.getBoundingClientRect === 'function') {
      const r = node.getBoundingClientRect();
      if (r && r.width > 0 && r.height > 0) {
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      }
    }
    return null;
  };

  const setScanningStates = (scanning: boolean) => {
    isScanningRef.current = scanning;
    setIsScanning(scanning);
    setIsProcessingOCR(scanning);
  };

  // Scan result card (floating overlay)
  const [resultCard, setResultCard] = useState<{
    visible: boolean;
    card: CardInfo | null;
    confidence: number;
  }>({ visible: false, card: null, confidence: 0 });

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
    if (!isWeb) return;
    if (!isCameraReady || !autoScanEnabled) return;
    if (!canAcquireScanJob({ isScanning: isScanning || isProcessingOCR, isGalleryPicking: isGalleryPickingRef.current })) return;

    let mounted = true;

    const loop = () => {
      if (!mounted) return;

      const video = document.querySelector('video');
      if (video && video.readyState >= 2) {
        const isOverlayVisible = !!(resultCard.visible || showSearch || scanError || searchError);
        const now = Date.now();

        // Throttle frame analysis to near-idle CPU while an overlay is shown.
        const analyze = shouldAnalyzeFrame({
          isOverlayVisible,
          nowMs: now,
          lastAnalysisMs: lastAnalysisTimeRef.current,
          overlayThrottleMs: OVERLAY_THROTTLE_MS,
        });

        if (analyze) {
          lastAnalysisTimeRef.current = now;
          const result = analyzeFrameWithStability(video, resolveScanArea());

          const requiredEmptyFrames = isOverlayVisible
            ? OVERLAY_UNLOCK_EMPTY_FRAMES
            : LIVE_UNLOCK_EMPTY_FRAMES;
          scanLockRef.current = advanceScanLock(scanLockRef.current, result, requiredEmptyFrames);

          const trigger = shouldTriggerAutoScan({
            isOverlayVisible,
            frame: result,
            locked: scanLockRef.current.locked,
            confidenceThreshold: AUTO_SCAN_CONFIDENCE,
          });

          if (trigger && now - lastScanTimeRef.current > SCAN_COOLDOWN_MS) {
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
  }, [
    isCameraReady,
    autoScanEnabled,
    isScanning,
    isProcessingOCR,
    facing,
    resultCard.visible,
    showSearch,
    scanError,
    searchError,
  ]);

  const toggleCameraFacing = () => {
    setFacing(current => (current === 'back' ? 'front' : 'back'));
    resetAutoScan();
  };

  const toggleFlash = () => {
    setFlash(current => !current);
  };

  const toggleAutoScan = () => {
    setAutoScanEnabled(prev => !prev);
    resetAutoScan();
  };

  // Web 版無法使用 expo-ocr-kit，用 Tesseract.js 兜底
  const performOcr = async (uri: string): Promise<string> => {
    if (isWeb) {
      const result = await recognizeTextWeb(uri);
      return typeof result?.text === 'string' ? result.text : '';
    } else {
      const { recognizeText } = require('expo-ocr-kit');
      const ocrResult = await recognizeText(uri);
      return typeof ocrResult?.text === 'string' ? ocrResult.text : '';
    }
  };

  // OCR 識別功能（支援 web/native，自動降級）
  const captureAndRecognize = async () => {
    if (!canAcquireScanJob({ isScanning: isScanningRef.current, isGalleryPicking: isGalleryPickingRef.current })) return;
    if (isWeb) {
      if (!webCameraRef.current) {
        Alert.alert('錯誤', '相機未準備好');
        return;
      }
    } else if (!cameraRef.current) {
      Alert.alert('錯誤', '相機未準備好');
      return;
    }

    try {
      setScanningStates(true);
      setScanningStatus('📷 拍攝中…');
      setScanProgress(1);
      setScanError(null);
      setCapturedPhotoUri(null);

      // Fingerprint the live frame at capture time so the lock records the
      // actual scanned card — this is what lets a later direct A→B swap unlock,
      // for auto-scan AND manual scans (which never pass through the loop).
      if (isWeb) {
        const sigVideo = document.querySelector('video');
        if (sigVideo && sigVideo.readyState >= 2) {
          try {
            pendingScanSignatureRef.current = computeCardSignature(sigVideo, resolveScanArea());
          } catch {
            pendingScanSignatureRef.current = null;
          }
        }
      }

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
        throw new Error('無法拍攝照片');
      }

      // 儲存照片 uri 用於預覽
      setCapturedPhotoUri(photo.uri);

      if (isWeb) {
        // ── Step 1: 從 video 直接 resize 到 1024px（跳過雙層 canvas）──
        setScanningStatus('📤 處理影像中…');
        setScanProgress(2);
        let imgData: string;
        const video = document.querySelector('video');
        if (video && video.videoWidth > 0) {
          let w = video.videoWidth, h = video.videoHeight;
          const MAX = 1024;
          if (w > MAX || h > MAX) {
            if (w > h) { h = Math.round((h / w) * MAX); w = MAX; }
            else { w = Math.round((w / h) * MAX); h = MAX; }
          }
          const c = document.createElement('canvas');
          c.width = w; c.height = h;
          c.getContext('2d')!.drawImage(video, 0, 0, w, h);
          imgData = c.toDataURL('image/jpeg', 0.85);
        } else {
          // 保險：直接用 WebCamera 拍的照片（已是 data: URI）
          imgData = photo.uri;
        }

        // ── Step 2: 叫 API 辨識（15 秒 timeout）──
        setScanningStatus('🤖 AI 辨識中…');
        setScanProgress(3);
        let apiResult: any = null;
        let apiNetworkError = false;
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15000);
          const apiUrl = window.location.origin + '/api/recognize-card';
          const resp = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ image: imgData }),
            signal: controller.signal,
          });
          clearTimeout(timeoutId);
          apiResult = await resp.json();
          console.log('[ScanScreen] API:', JSON.stringify(apiResult).slice(0, 600));
        } catch (e: any) {
          apiNetworkError = true;
          console.warn('[ScanScreen] API network error:', e.message);
        }

        // ── Step 3: API 成功 → 顯示結果 ──
        if (apiResult?.success && apiResult?.card) {
          setScanningStatus('✅ 辨識完成');
          setScanProgress(4);
          const card = apiResult.card;
          const cardInfo: CardInfo = {
            id: card.cardNumber, name: card.name || '', cardNumber: card.cardNumber,
            type: '', rarity: card.rarity || '', series: card.series || '',
            sellPrice: card.sellPrice != null ? card.sellPrice : null,
            yuyuName: '', color: '', imageUrl: card.imageUrl || '', prices: card.prices || [],
          };
          addCard(cardInfo);
          setLastScannedCard(cardInfo);
          setResultCard({ visible: true, card: cardInfo, confidence: 0.9 });
          setSearchResults([]); setSearchError(null); setSuggestions([]);
          setCapturedPhotoUri(null); resetAutoScan();
          lockScanAfterCapture(pendingScanSignatureRef.current);
          return;
        }

        // ── Step 4: API 有回錯誤 → 顯示給使用者 ──
        if (apiResult && !apiResult.success) {
          const errMsg = apiResult.error || '無法辨識';
          setScanningStatus('');
          setScanProgress(0);
          setScanError(`⚠️ 辨識失敗: ${errMsg}`);
          if (apiResult.raw) setRecognizedText(apiResult.raw);
          // 留著 photo 讓使用者可以手動搜尋
          return;
        }

        // ── Step 5: 網路錯誤 → 降級到本地 Tesseract ──
        if (apiNetworkError) {
          console.warn('[ScanScreen] API unreachable, falling back to Tesseract');
          const result = await recognizeCardFromImage(photo.uri);

          if (result.success && result.card) {
            addCard(result.card);
            setLastScannedCard(result.card);
            setResultCard({ visible: true, card: result.card, confidence: 0.85 });
            setSearchResults([]); setSearchError(null); setSuggestions([]);
            setCapturedPhotoUri(null); resetAutoScan();
            lockScanAfterCapture(pendingScanSignatureRef.current);
          } else {
            const recognizedText = await recognizeTextWeb(photo.uri);
            const trimmedText = recognizedText.text.trim();
            setRecognizedText(trimmedText);
            if (trimmedText.length > 0) {
              const fallbackResult = await recognizeCardFromOcr(trimmedText);
              if (fallbackResult.success && fallbackResult.card) {
                addCard(fallbackResult.card);
                setLastScannedCard(fallbackResult.card);
                setResultCard({ visible: true, card: fallbackResult.card, confidence: 0.85 });
                setSearchResults([]); setSearchError(null); setSuggestions([]);
                setCapturedPhotoUri(null); resetAutoScan();
                lockScanAfterCapture(pendingScanSignatureRef.current);
                return;
              }
              setSearchError(fallbackResult.error || '找不到匹配的卡牌');
              const searchResult = await searchCards(trimmedText, 10);
              setSearchResults(searchResult);
            } else {
              setScanError('無法自動辨識卡牌文字。請使用手動搜尋或從下方搜尋結果中選擇。');
            }
          }
        } else {
          // 沒網路錯誤也沒 API 結果（不該發生，但兜底）
          setScanError('無法完成掃描，請重試或使用手動搜尋');
        }
      } else {
        // Native: 用 expo-ocr-kit 做全圖 OCR
        setScanningStatus('🔍 OCR 辨識中…');
        setScanProgress(3);
        const recognizedText = await performOcr(photo.uri);
        const trimmedText = recognizedText.trim();
        setRecognizedText(trimmedText);

        if (trimmedText.length > 0) {
          // 使用 OCR 專用辨識（含行分割、卡號提取）
          const result = await recognizeCardFromOcr(trimmedText);

          if (result.success && result.card) {
            setScanningStatus('✅ 辨識完成');
            setScanProgress(4);
            addCard(result.card);
            setLastScannedCard(result.card);
            // Show floating result card
            setResultCard({
              visible: true,
              card: result.card,
              confidence: 0.85,
            });
            setSearchResults([]);
            setSearchError(null);
            setSuggestions([]);
            setCapturedPhotoUri(null);
            // Reset auto-scan stability buffer after successful scan
            resetAutoScan();
            lockScanAfterCapture(pendingScanSignatureRef.current);
          } else {
            // 沒有精確匹配 — 用全部結果做模糊搜尋，讓用戶選擇
            setSearchError(result.error || '找不到匹配的卡牌');
            const searchResult = await searchCards(trimmedText, 10);
            setSearchResults(searchResult);
          }
        } else {
          // OCR 回傳空文字（常見於 web 版）
          // 直接向使用者顯示已拍攝的照片，提供手動搜尋
          // 不彈 Alert，讓畫面底部的錯誤提示引導使用者
          setScanError('無法自動辨識卡牌文字。請使用手動搜尋或從下方搜尋結果中選擇。');
          // 用完整字串搜尋（雖然為空，但仍給個機會）
        }
      }
    } catch (error) {
      console.error('OCR Error:', error);
      setScanningStatus('');
      setScanProgress(0);

      setScanError('無法完成掃描，請重試或使用手動輸入');
    } finally {
      setScanningStates(false);
    }
  };

  // 從相冊選擇圖片進行識別
  const pickFromGallery = async () => {
    if (!canAcquireScanJob({ isScanning: isScanningRef.current, isGalleryPicking: isGalleryPickingRef.current })) return;
    try {
      isGalleryPickingRef.current = true;
      setScanningStates(true);
      // Gallery images have no live-frame signature; lock without one so only
      // an empty-frame run (not a spurious signature match) can release it.
      pendingScanSignatureRef.current = null;

      const result = await ImagePicker.launchImageLibraryAsync({
        mediaTypes: ImagePicker.MediaTypeOptions.Images,
        allowsEditing: true,
        quality: 0.8,
      });

      if (!result.canceled && result.assets[0]?.uri) {
        setScanError(null);
        setCapturedPhotoUri(result.assets[0].uri);

        if (isWeb) {
          // Web: 卡號優先 OCR
          const cardResult = await recognizeCardFromImage(result.assets[0].uri);

          if (cardResult.success && cardResult.card) {
            addCard(cardResult.card);
            setLastScannedCard(cardResult.card);
            setResultCard({
              visible: true,
              card: cardResult.card,
              confidence: 0.85,
            });
            setSearchResults([]);
            setSearchError(null);
            setSuggestions([]);
            setCapturedPhotoUri(null);
            resetAutoScan();
            lockScanAfterCapture(pendingScanSignatureRef.current);
          } else {
            // Fallback 到全圖 OCR
            const recognizedText = await recognizeTextWeb(result.assets[0].uri);
            const trimmedText = recognizedText.text.trim();
            setRecognizedText(trimmedText);

            if (trimmedText.length > 0) {
              const fallbackResult = await recognizeCardFromOcr(trimmedText);
              if (fallbackResult.success && fallbackResult.card) {
                addCard(fallbackResult.card);
                setLastScannedCard(fallbackResult.card);
                setResultCard({
                  visible: true,
                  card: fallbackResult.card,
                  confidence: 0.85,
                });
                setSearchResults([]);
                setSearchError(null);
                setSuggestions([]);
                setCapturedPhotoUri(null);
                resetAutoScan();
                lockScanAfterCapture(pendingScanSignatureRef.current);
                return;
              }
              setSearchError(fallbackResult.error || '找不到匹配的卡牌');
              const searchResult = await searchCards(trimmedText, 10);
              setSearchResults(searchResult);
            } else {
              setScanError('無法自動辨識卡牌文字。請使用手動搜尋或從下方搜尋結果中選擇。');
            }
          }
        } else {
          const recognizedText = await performOcr(result.assets[0].uri);
          const trimmedText = recognizedText.trim();
          setRecognizedText(trimmedText);

          if (trimmedText.length > 0) {
            const cardResult = await recognizeCardFromOcr(trimmedText);
            if (cardResult.success && cardResult.card) {
              addCard(cardResult.card);
              setLastScannedCard(cardResult.card);
              // Show floating result card
              setResultCard({
                visible: true,
                card: cardResult.card,
                confidence: 0.85,
              });
              setSearchResults([]);
              setSearchError(null);
              setSuggestions([]);
              setCapturedPhotoUri(null);
              resetAutoScan();
              lockScanAfterCapture(pendingScanSignatureRef.current);
            } else {
              setSearchError(cardResult.error || '找不到匹配的卡牌');
              const searchResult = await searchCards(trimmedText, 10);
              setSearchResults(searchResult);
            }
          } else {
            setScanError('無法自動辨識卡牌文字。請使用手動搜尋或從下方搜尋結果中選擇。');
          }
        }
      }
    } catch (error) {
      console.error('Gallery OCR Error:', error);
      setScanError('無法讀取或識別圖片，請重試或使用手動輸入');
    } finally {
      isGalleryPickingRef.current = false;
      setScanningStates(false);
    }
  };

  const handleScan = () => {
    if (isScanning || isProcessingOCR) return;
    unlockScan();
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
    const errorMessage = error?.message || '相機載入失敗，請重新開啟應用程式';
    setCameraError(errorMessage);
    setIsCameraReady(false);
  };

  const handleRetry = () => {
    setCameraError(null);
    unlockScan();
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
      setSearchError(result.error || '辨識失敗');
    }
  };
  
  // 執行搜尋
  const handleSearch = async () => {
    if (!searchQuery.trim()) {
      Alert.alert('請輸入搜尋內容');
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
      setSearchError(result.error || '找不到匹配的卡牌');
      // 顯示搜尋結果作為建議
      const searchResult = await searchCards(searchQuery, 5);
      setSearchResults(searchResult);
    }
  };
  
  // 選擇建議的卡牌
  const handleSelectSuggestion = (card: CardInfo) => {
    setRecognizedCard(card);
    setSuggestions([]);
    addCard(card);
    setResultCard({ visible: true, card, confidence: 0.85 });
  };
  
  // 清除結果
  const clearResult = () => {
    setRecognizedCard(null);
    setSuggestions([]);
    setSearchError(null);
    setScanComplete(false);
  };

  const openSettings = () => {
    if (Platform.OS === 'ios') {
      Linking.openURL('app-settings:');
    }
  };

  // === Web 版：不用 expo-camera 權限，直接讓 WebCamera 處理 getUserMedia ===
  if (isWeb && !webCameraStarted) {
    return (
      <View style={styles.container}>
        <View style={styles.permissionContainer}>
          <Text style={styles.permissionIcon}>📷</Text>
          <Text style={styles.permissionTitle}>需要相機權限</Text>
          <Text style={styles.permissionText}>
            掃描卡牌需要使用相機功能，請點擊下方按鈕以允許存取相機。
          </Text>
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
                setCameraError(e?.message || '無法開啟相機');
                setIsCameraReady(false);
              }
            }}
            activeOpacity={0.7}
          >
            <Text style={styles.permissionButtonText}>允許相機權限</Text>
          </TouchableOpacity>
          <TouchableOpacity 
            style={styles.settingsButton}
            onPress={openSettings}
            activeOpacity={0.7}
          >
            <Text style={styles.settingsButtonText}>打開設定</Text>
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
            <Text style={styles.loadingText}>載入相機中...</Text>
          </View>
        </View>
      );
    }

    // 权限被拒绝
    if (!permission.granted) {
      return (
        <View style={styles.container}>
          <View style={styles.permissionContainer}>
            <Text style={styles.permissionIcon}>📷</Text>
            <Text style={styles.permissionTitle}>需要相機權限</Text>
            <Text style={styles.permissionText}>
              掃描卡牌需要使用相機功能，請允許存取相機以使用此功能。
            </Text>
            <TouchableOpacity 
              style={styles.permissionButton}
              onPress={requestPermission}
              activeOpacity={0.7}
            >
              <Text style={styles.permissionButtonText}>允許相機權限</Text>
            </TouchableOpacity>
            <TouchableOpacity 
              style={styles.settingsButton}
              onPress={openSettings}
              activeOpacity={0.7}
            >
              <Text style={styles.settingsButtonText}>打開設定</Text>
            </TouchableOpacity>
          </View>
        </View>
      );
    }
  }

  return (
    <View style={styles.container}>
      {/* 初始化中遮罩 — 相機在下面照常 mount，讓 getUserMedia 有機會啟動 */}
      {!isCameraReady && (
        <View style={styles.loadingOverlay}>
          <View style={styles.loadingContainer}>
            <Text style={styles.loadingText}>相機初始化中...</Text>
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
                  <Text style={resultStyles.retryText}>重試</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        </View>
      )}
      {/* 相机预览 — 一定會 mount，不會被初始化中判斷擋住 */}
{isWeb ? (
        <WebCamera
          ref={webCameraRef}
          style={styles.camera}
          facing={facing}
          initialStream={webStreamRef.current}
          onCameraReady={handleCameraReady}
          onMountError={handleMountError}
        >
          <ScanOverlay
            scanAreaRef={scanAreaRef}
            scanLineAnim={scanLineAnim}
            pulseAnim={pulseAnim}
            borderAnim={borderAnim}
            isScanning={isScanning}
            flash={flash}
            autoScanEnabled={autoScanEnabled}
            isCameraReady={isCameraReady}
            cameraError={cameraError}
            onFlash={toggleFlash}
            onScan={handleScan}
            onFlip={toggleCameraFacing}
            onGallery={pickFromGallery}
            onManualSearch={() => setShowSearch(true)}
            onToggleAutoScan={toggleAutoScan}
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
            scanAreaRef={scanAreaRef}
            scanLineAnim={scanLineAnim}
            pulseAnim={pulseAnim}
            borderAnim={borderAnim}
            isScanning={isScanning}
            flash={flash}
            autoScanEnabled={autoScanEnabled}
            isCameraReady={isCameraReady}
            cameraError={cameraError}
            onFlash={toggleFlash}
            onScan={handleScan}
            onFlip={toggleCameraFacing}
            onGallery={pickFromGallery}
            onManualSearch={() => setShowSearch(true)}
            onToggleAutoScan={toggleAutoScan}
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
                <Text style={resultStyles.toastPrice}>
                  {(() => {
                    if (lastScannedCard.sellPrice == null) return '—';
                    if (preferredCurrency === 'JPY') return `¥${lastScannedCard.sellPrice.toLocaleString()}`;
                    const { value, symbol } = convertPrice(lastScannedCard.sellPrice, preferredCurrency);
                    return `${symbol}${value?.toLocaleString() || '—'}`;
                  })()}
                </Text>
              </View>
            </View>
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
              <Text style={resultStyles.retryText}>手動搜尋</Text>
            </TouchableOpacity>
            {recognizedText ? (
              <TouchableOpacity
                style={resultStyles.debugButton}
                onPress={() => {
                  Alert.alert('識別文字偵錯', `OCR 識別到的原始文字：\n\n"${recognizedText}"`);
                }}
              >
                <Text style={resultStyles.debugText}>查看識別文字</Text>
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
            {['📷 拍攝', '📤 處理', '🤖 辨識', '✅ 完成'].map((label, i) => {
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
              <Text style={resultStyles.retryText}>手動搜尋</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={resultStyles.retryButton}
              onPress={() => {
                unlockScan();
                captureAndRecognize();
              }}
            >
              <Text style={resultStyles.retryText}>重試掃描</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}
      
      {/* 搜尋建議列表 */}
      {searchResults.length > 0 && (
        <View style={resultStyles.suggestionsListContainer}>
          <Text style={resultStyles.suggestionsTitle}>搜尋結果:</Text>
          <ScrollView style={resultStyles.suggestionsList}>
            {searchResults.map((card, index) => (
              <TouchableOpacity 
                key={index}
                style={resultStyles.listItem}
                onPress={() => handleSelectSuggestion(card)}
              >
                <Text style={resultStyles.listItemName}>{card.name}</Text>
                <Text style={resultStyles.listItemPrice}>
                  ¥{card.sellPrice?.toLocaleString() || '尚無交易'}
                </Text>
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
            <Text style={modalStyles.modalTitle}>🔍 搜尋卡牌</Text>
            <TextInput
              style={modalStyles.searchInput}
              placeholder="輸入卡牌名稱或編號..."
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
                <Text style={modalStyles.searchButtonText}>搜尋</Text>
              </TouchableOpacity>
              <TouchableOpacity 
                style={modalStyles.cancelButton}
                onPress={() => {
                  setShowSearch(false);
                  setSearchQuery('');
                }}
              >
                <Text style={modalStyles.cancelText}>取消</Text>
              </TouchableOpacity>
            </View>
          </View>
        </View>
      </Modal>
      
      {/* 掃描估值面板 */}
      <ScanSessionPanel
        preferredCurrency={preferredCurrency}
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
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: 'rgba(255, 255, 255, 0.1)',
  },
  listItemName: {
    color: COLORS.text,
    fontSize: 14,
    flex: 1,
  },
  listItemPrice: {
    color: COLORS.primary,
    fontSize: 14,
    fontWeight: '600',
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