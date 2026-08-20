// WebCamera.tsx — iOS/Web 專用相機元件
// expo-camera 的 iOS web 上因 getUserMedia 重複呼叫導致黑畫面
// 改用直接 HTML5 video + getUserMedia，只 call 一次 stream
// 接收來自父層的 initialStream（在手勢鏈中取得）解決 iOS Safari 手勢鏈問題

import React, { useState, useRef, useEffect, useImperativeHandle, forwardRef } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { useTranslation } from '../i18n';

export interface WebCameraHandle {
  takePictureAsync: (options?: { quality?: number }) => Promise<{ uri: string } | null>;
  retry: () => void;
}

interface WebCameraProps {
  facing?: 'front' | 'back';
  style?: any;
  onCameraReady?: () => void;
  onMountError?: (error: { message?: string }) => void;
  children?: React.ReactNode;
  /** 從父層在手勢鏈中預先取得的 stream，傳入後不再自行呼叫 getUserMedia */
  initialStream?: MediaStream | null;
}

const WebCamera = forwardRef<WebCameraHandle, WebCameraProps>((props, ref) => {
  const { t, language } = useTranslation();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const cameraIdRef = useRef(0); // 避免 async race condition
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retryCount, setRetryCount] = useState(0);

  // 使用給定的 stream（不呼叫 getUserMedia）
  const useStream = (stream: MediaStream) => {
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      videoRef.current.play();
    }
    setReady(true);
    setError(null);
    if (props.onCameraReady) props.onCameraReady();
  };

  const startCamera = async (facingMode: 'user' | 'environment') => {
    const id = ++cameraIdRef.current;
    try {
      // Stop previous stream if any
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });

      // 若在此期間元件已 unmount 或有更新的請求，放棄此 stream
      if (id !== cameraIdRef.current) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }

      useStream(stream);
    } catch (err: any) {
      if (id !== cameraIdRef.current) return;
      const msg = language === 'ja' ? t('scan_camera_open_failed') : (err?.message || t('scan_camera_open_failed'));
      setError(msg);
      setReady(false);
      if (props.onMountError) props.onMountError({ message: msg });
    }
  };

  // 記錄是否已使用 initialStream（只在首次 mount 時用，retry 時不用）
  const initialStreamUsed = useRef(false);

  // 主初始化 effect
  useEffect(() => {
    // 首次 mount：有 initialStream 就用，跳過 getUserMedia（在手勢鏈中取得的）
    if (props.initialStream && !initialStreamUsed.current) {
      initialStreamUsed.current = true;
      useStream(props.initialStream);
      return;
    }

    const mode = props.facing === 'front' ? ('user' as const) : ('environment' as const);
    startCamera(mode);
    return () => {
      cameraIdRef.current++; // 標記取消進行中的 getUserMedia
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
    };
  }, [props.facing, retryCount]);

  useImperativeHandle(ref, () => ({
    takePictureAsync: async (options?: { quality?: number }) => {
      const video = videoRef.current;
      if (!video || !video.videoWidth) return null;

      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      if (props.facing === 'front') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
      }
      ctx.drawImage(video, 0, 0);

      const quality = options?.quality ?? 0.8;
      const dataUrl = canvas.toDataURL('image/jpeg', quality);
      return { uri: dataUrl };
    },
    retry: () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach(t => t.stop());
        streamRef.current = null;
      }
      setReady(false);
      setError(null);
      setRetryCount(c => c + 1);
    },
  }));

  return (
    <View style={[styles.wrapper, props.style]}>
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          transform: props.facing === 'front' ? 'scaleX(-1)' : 'none',
        }}
      />
      {!ready && !error && (
        <View style={styles.loading}>
          <Text style={styles.loadingText}>{t('scan_camera_starting')}</Text>
        </View>
      )}
      {error && (
        <View style={styles.error}>
          <Text style={styles.errorText}>❌ {error}</Text>
        </View>
      )}
      {props.children}
    </View>
  );
});

WebCamera.displayName = 'WebCamera';

const styles = StyleSheet.create({
  wrapper: {
    position: 'relative',
    overflow: 'hidden',
  },
  loading: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  loadingText: {
    color: '#aaa',
    fontSize: 14,
  },
  error: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
    backgroundColor: 'rgba(0,0,0,0.7)',
  },
  errorText: {
    color: '#ff6b9d',
    fontSize: 14,
    textAlign: 'center',
    padding: 20,
  },
});

export default WebCamera;
