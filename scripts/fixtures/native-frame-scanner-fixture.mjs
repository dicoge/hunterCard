// Stand-in for the native HoloHunterCardScanner view (modules/holohunter-ocr-geometry,
// HoloHunterCardScannerView.kt) in rendered ScanScreen tests. It models the native
// contract the Kotlin view implements — no camera, no ML Kit:
//   • frames reach JS (onFrameText) only while the `active` prop is true; the analyser
//     drops them otherwise                 → __frameScanner.offered / delivered
//   • takePicture(quality, base64) is the ONLY still capture → __frameScanner.stills
//   • onCameraReady fires after mount (camera opened), never synchronously
//   • mounts / unmounts, latest props      → __frameScanner.props
// __emitFrame(payload) offers one analysed frame; __emitFrameInFlight(payload) delivers
// one even if the gate closed meanwhile (an ML Kit result already in flight when JS
// turned analysis off), so the JS-side re-check is tested too.
import React from 'react';
import { View } from 'react-native-web';

const state = globalThis.__frameScanner = globalThis.__frameScanner
  ?? { mounts: 0, unmounts: 0, stills: 0, offered: 0, delivered: 0, props: null, stillCalls: [] };

export const FrameScannerView = React.forwardRef(function HoloHunterCardScanner(props, ref) {
  const propsRef = React.useRef(props);
  propsRef.current = props;
  state.props = props;
  React.useImperativeHandle(ref, () => ({
    takePicture: async (quality, base64) => {
      state.stills += 1;
      state.stillCalls.push({ quality, base64 });
      return {
        uri: `file:///cache/HoloHunterScan/still-${state.stills}.jpg`,
        width: 1200, height: 1600,
        ...(base64 ? { base64: globalThis.__frameScannerStillBase64 } : {}),
      };
    },
  }));
  React.useEffect(() => {
    state.mounts += 1;
    let alive = true;
    const deliver = (payload, force) => {
      if (!alive) return false;
      state.offered += 1;
      if (!force && !propsRef.current.active) return false;
      state.delivered += 1;
      propsRef.current.onFrameText?.({ nativeEvent: payload });
      return true;
    };
    globalThis.__emitFrame = (payload) => deliver(payload, false);
    globalThis.__emitFrameInFlight = (payload) => deliver(payload, true);
    const id = setTimeout(() => propsRef.current.onCameraReady?.({ nativeEvent: {} }), 0);
    return () => {
      alive = false;
      state.unmounts += 1;
      clearTimeout(id);
    };
  }, []);
  return React.createElement(View, { style: props.style, testID: props.testID });
});
