// Stand-in for the native HoloHunterCardScanner view (modules/holohunter-ocr-geometry,
// HoloHunterCardScannerView.kt) in rendered ScanScreen tests. It models the native
// contract the Kotlin view implements (pinned statically by test:scan-ocr-geometry) —
// no camera, no ML Kit, no CameraX:
//   • frames reach JS (onFrameText) only while `active`; each frame is tagged with the
//     `session` prop at the moment it STARTED            → __frameScanner.offered/delivered
//   • __startFrame(payload) begins an analysis now and returns deliver(): the native view
//     delivers it only if analysis is still on and session/generation are unchanged
//     (guarded). __startFrameUnguarded(payload) returns a deliver() that ignores those
//     checks (a native without the guard) — to prove the JS-side ownership check alone.
//   • takePicture(quality, base64): the only still. Immediate by default; with
//     __frameScannerCaptureMode = 'deferred' it stays pending until __settleCapture(); on
//     unmount (native release()) every pending capture is REJECTED exactly once
//     (E_CAMERA_RELEASED) and a late native success is ignored          → stills, pending
//   • onCameraReady = the preview STREAMS (v43 contract) — after mount by default; with
//     __frameScannerStartMode = 'stall' the view is bound but its preview never streams
//     (the v42 device symptom: no event at all) until __frameScannerStream() is called;
//     onMountError instead when __frameScannerFailMount is set
//   • __frameScannerCriticalError(): a CRITICAL CameraX error at any time (also after
//     STREAMING). Like the Kotlin fail(): reported once, latched for this mount — no ready,
//     no frame, no still afterwards; pending stills rejected (E_CAMERA_FAILED). A test may
//     force a late event past the latch (__frameScannerStream({ force: true }),
//     __startFrameUnguarded) to prove the screen's own guard.     → __frameScanner.failures
//   • mounts / unmounts, latest props                                  → __frameScanner.props
import React from 'react';
import { View } from 'react-native-web';

const state = globalThis.__frameScanner = globalThis.__frameScanner
  ?? { mounts: 0, unmounts: 0, stills: 0, offered: 0, delivered: 0, props: null, stillCalls: [], pending: [], rejected: 0, lateIgnored: 0 };

export const FrameScannerView = React.forwardRef(function HoloHunterCardScanner(props, ref) {
  const propsRef = React.useRef(props);
  propsRef.current = props;
  state.props = props;
  const alive = React.useRef(true);
  const failed = React.useRef(false);
  const generation = React.useRef(0);
  const last = React.useRef({ active: props.active, session: props.session });
  if (last.current.active !== props.active || last.current.session !== props.session) {
    generation.current += 1;
    last.current = { active: props.active, session: props.session };
  }
  React.useImperativeHandle(ref, () => ({
    takePicture: (quality, base64) => {
      if (failed.current) return Promise.reject(Object.assign(new Error('The camera is not ready'), { code: 'E_CAMERA_NOT_READY' }));
      state.stills += 1;
      state.stillCalls.push({ quality, base64 });
      const photo = {
        uri: `file:///cache/HoloHunterScan/still-${state.stills}.jpg`,
        width: 1200, height: 1600,
        ...(base64 ? { base64: globalThis.__frameScannerStillBase64 } : {}),
      };
      if (globalThis.__frameScannerCaptureMode !== 'deferred') return Promise.resolve(photo);
      return new Promise((resolve, reject) => {
        const p = { settled: false, resolve, reject, photo };
        state.pending.push(p);
      });
    },
  }));
  React.useEffect(() => {
    state.mounts += 1;
    alive.current = true;
    const deliver = (payload) => {
      state.delivered += 1;
      propsRef.current.onFrameText?.({ nativeEvent: payload });
    };
    globalThis.__emitFrame = (payload) => {
      if (!alive.current || failed.current) return false;
      state.offered += 1;
      if (!propsRef.current.active) return false;
      deliver({ ...payload, session: propsRef.current.session });
      return true;
    };
    // A misbehaving native that delivers while analysis is off (current session).
    globalThis.__emitFrameInFlight = (payload) => {
      if (!alive.current) return false;
      state.offered += 1;
      deliver({ ...payload, session: propsRef.current.session });
      return true;
    };
    globalThis.__startFrame = (payload) => {
      const startSession = propsRef.current.session;
      const startGen = generation.current;
      const startedActive = !!propsRef.current.active && alive.current;
      return () => {
        if (!alive.current || failed.current || !startedActive || !propsRef.current.active
          || startSession !== propsRef.current.session || startGen !== generation.current) return false;
        deliver({ ...payload, session: startSession });
        return true;
      };
    };
    globalThis.__startFrameUnguarded = (payload) => {
      const startSession = propsRef.current.session;
      return () => { if (!alive.current) return false; deliver({ ...payload, session: startSession }); return true; };
    };
    globalThis.__settleCapture = (ok = true) => {
      const p = state.pending.shift();
      if (!p) return false;
      if (p.settled) { state.lateIgnored += 1; return false; }
      p.settled = true;
      if (ok) p.resolve(p.photo); else p.reject(Object.assign(new Error('Capture failed'), { code: 'E_CAPTURE_FAILED' }));
      return true;
    };
    globalThis.__frameScannerStream = ({ force = false } = {}) => {
      if (!alive.current || (failed.current && !force)) return false;
      propsRef.current.onCameraReady?.({ nativeEvent: {} });
      return true;
    };
    globalThis.__frameScannerCriticalError = () => {
      if (!alive.current || failed.current) return false;
      failed.current = true;
      state.failures = (state.failures ?? 0) + 1;
      for (const p of state.pending) {
        if (!p.settled) { p.settled = true; p.reject(Object.assign(new Error('The camera stopped'), { code: 'E_CAMERA_FAILED' })); }
      }
      propsRef.current.onMountError?.({ nativeEvent: { message: 'Camera error 3' } });
      return true;
    };
    const id = setTimeout(() => {
      if (globalThis.__frameScannerFailMount) propsRef.current.onMountError?.({ nativeEvent: { message: 'Camera error 5' } });
      else if (globalThis.__frameScannerStartMode !== 'stall') propsRef.current.onCameraReady?.({ nativeEvent: {} });
    }, 0);
    return () => {
      alive.current = false;
      state.unmounts += 1;
      clearTimeout(id);
      // native release(): every pending capture is settled exactly once (rejected)
      for (const p of state.pending) {
        if (!p.settled) { p.settled = true; state.rejected += 1; p.reject(Object.assign(new Error('The camera was closed'), { code: 'E_CAMERA_RELEASED' })); }
      }
    };
  }, []);
  return React.createElement(View, { style: props.style, testID: props.testID });
});
