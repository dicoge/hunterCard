// WebCamera stand-in for scripts/test-scan-v39-web-autoscan.mjs: renders a <video> the
// auto-scan loop can read (readyState 4), its children (the real ScanOverlay), and
// returns the photo the test put on globalThis.__webCameraPhoto. Counts captures.
import React from 'react';
import { View } from 'react-native-web';

const WebCamera = React.forwardRef(function WebCamera(props, ref) {
  React.useImperativeHandle(ref, () => ({
    takePictureAsync: async () => { globalThis.__webCameraTakes = (globalThis.__webCameraTakes ?? 0) + 1; return { uri: globalThis.__webCameraPhoto }; },
    retry() {},
  }));
  React.useEffect(() => { props.onCameraReady?.(); }, []);
  const videoRef = React.useCallback((el) => { if (el) Object.defineProperty(el, 'readyState', { value: 4, configurable: true }); }, []);
  return React.createElement(View, { style: props.style, testID: 'web-camera-fixture' },
    React.createElement('video', { ref: videoRef }), props.children);
});
export default WebCamera;
