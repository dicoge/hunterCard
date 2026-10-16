// expo-camera stand-in for scripts/test-scan-native-crop-render.mjs: renders its
// children (the real ScanOverlay) and returns the photo the test put on
// globalThis.__nativeCameraPhoto. No camera, no device.
import React from 'react';
import { View } from 'react-native-web';

export const CameraView = React.forwardRef(function CameraView(props, ref) {
  React.useImperativeHandle(ref, () => ({
    takePictureAsync: async () => { globalThis.__nativeCameraTakes = (globalThis.__nativeCameraTakes ?? 0) + 1; return { ...globalThis.__nativeCameraPhoto }; },
    getAvailablePictureSizesAsync: async () => ['1440x1920', '3024x4032'],
  }));
  React.useEffect(() => { props.onCameraReady?.(); }, []);
  return React.createElement(View, { style: props.style, testID: 'native-camera-fixture' }, props.children);
});
export const useCameraPermissions = () => [{ granted: true, canAskAgain: true, status: 'granted' }, async () => ({ granted: true }), async () => ({ granted: true })];
export const CameraType = {};
export default { CameraView, useCameraPermissions, CameraType };
