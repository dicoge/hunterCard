// Stands in for expo native modules that cannot be imported outside a device
// runtime. Only reached from the push/price-alert transport, which renders
// nothing; any property read returns a no-op so an accidental call is loud in
// behaviour (undefined result) rather than a module-load crash.
const noop = () => undefined;

const stub = new Proxy(
  {},
  {
    get: (_target, prop) => (prop === 'default' ? stub : noop),
  },
);

export default stub;
export const getExpoPushTokenAsync = noop;
export const getPermissionsAsync = noop;
export const requestPermissionsAsync = noop;
export const setNotificationHandler = noop;
export const maybeCompleteAuthSession = noop;
export const openAuthSessionAsync = noop;
export const dismissBrowser = noop;
export const expoConfig = null;
// expo-camera named exports (DIC-1409 Phase 4 render evidence): the web render
// path never mounts CameraView (ScanScreen uses WebCamera on web), but the ESM
// named-import validation still requires the symbols to exist at load time.
export const CameraView = () => null;
export const useCameraPermissions = () => [null, noop, noop];
export const CameraType = {};
