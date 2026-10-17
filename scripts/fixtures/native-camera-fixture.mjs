// expo-camera stand-in for scripts/test-scan-native-crop-render.mjs: renders its
// children (the real ScanOverlay) and returns the photo the test put on
// globalThis.__nativeCameraPhoto. No camera, no device.
//
// v42: it also models the INSTALLED Android native contract of expo-camera 17.0.10
// (node_modules/expo-camera/android/.../ExpoCameraView.kt, pinned by
// scripts/test-scan-android-camera-contract.mjs):
//   • takePicture with animateShutter not false (native default true) paints the whole
//     view white            → globalThis.__nativeShutterFlashes += 1
//   • takePicture while flash="on" (ImageCapture flash mode ON) fires the LED
//                            → globalThis.__nativeLedFlashes += 1
//   • a pictureSize / facing change after mount rebinds CameraX (preview restarts)
//                            → globalThis.__nativeRebinds += 1
//   • every mount             → globalThis.__nativeCameraMounts += 1
// The latest props are on globalThis.__nativeCameraProps.
import React from 'react';
import { View } from 'react-native-web';

export const CameraView = React.forwardRef(function CameraView(props, ref) {
  const propsRef = React.useRef(props);
  propsRef.current = props;
  globalThis.__nativeCameraProps = props;
  const bound = React.useRef(null);
  const key = `${props.pictureSize ?? ''}|${props.facing ?? ''}`;
  React.useEffect(() => {
    if (bound.current !== null && bound.current !== key) globalThis.__nativeRebinds = (globalThis.__nativeRebinds ?? 0) + 1;
    bound.current = key;
  }, [key]);
  React.useEffect(() => { globalThis.__nativeCameraMounts = (globalThis.__nativeCameraMounts ?? 0) + 1; }, []);
  React.useImperativeHandle(ref, () => ({
    takePictureAsync: async (opts) => {
      globalThis.__nativeCameraTakes = (globalThis.__nativeCameraTakes ?? 0) + 1;
      const p = propsRef.current;
      if (p.animateShutter !== false) globalThis.__nativeShutterFlashes = (globalThis.__nativeShutterFlashes ?? 0) + 1;
      if (p.flash === 'on') globalThis.__nativeLedFlashes = (globalThis.__nativeLedFlashes ?? 0) + 1;
      const photo = { ...globalThis.__nativeCameraPhoto };
      // Opt-in: a distinct file per capture, as a device writes one (cleanup proofs).
      if (globalThis.__nativeCameraUniqueUris) photo.uri = photo.uri.replace(/\.jpg$/, `-${globalThis.__nativeCameraTakes}.jpg`);
      (globalThis.__nativeCameraCalls ||= []).push({ ...(opts || {}), uri: photo.uri });
      return photo;
    },
    getAvailablePictureSizesAsync: async () => ['1440x1920', '3024x4032'],
  }));
  // A device reports readiness from a native event AFTER mount, not synchronously inside
  // the first commit (where ScanScreen's own permission effect still resets it).
  // globalThis.__nativeCameraFailMount: this mount reports onMountError instead (as expo-camera
  // does when CameraX cannot bind).
  React.useEffect(() => {
    const id = setTimeout(() => {
      if (globalThis.__nativeCameraFailMount) props.onMountError?.({ message: 'Camera component could not be rendered' });
      else props.onCameraReady?.();
    }, 0);
    return () => clearTimeout(id);
  }, []);
  return React.createElement(View, { style: props.style, testID: 'native-camera-fixture' }, props.children);
});
// Permission state (default: granted, as before). A test may start from
// globalThis.__cameraPermission (null = still loading, or a denied answer) and set what the
// system dialog answers in globalThis.__cameraPermissionAnswer; requests are counted.
const GRANTED = { granted: true, canAskAgain: true, status: 'granted' };
export const useCameraPermissions = () => {
  const [permission, setPermission] = React.useState(() => ('__cameraPermission' in globalThis ? globalThis.__cameraPermission : GRANTED));
  const request = async () => {
    globalThis.__cameraPermissionRequests = (globalThis.__cameraPermissionRequests ?? 0) + 1;
    const answer = globalThis.__cameraPermissionAnswer ?? GRANTED;
    setPermission(answer);
    return answer;
  };
  return [permission, request, async () => permission];
};
export const CameraType = {};
export default { CameraView, useCameraPermissions, CameraType };
