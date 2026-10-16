// react-native-web with Platform.OS forced to 'android', so a screen's native
// branch can be rendered under jsdom (scripts/test-scan-native-crop-render.mjs).
export * from 'react-native-web';
import * as W from 'react-native-web';
export const Platform = {
  ...W.Platform,
  OS: 'android',
  select: (o) => (o.android !== undefined ? o.android : o.native !== undefined ? o.native : o.default),
};

// Android hardware back for rendered tests: listeners run newest first until one
// returns true, as on a device. globalThis.__androidBackPress() → handled?
const backListeners = [];
export const BackHandler = {
  exitApp() {},
  addEventListener(event, fn) {
    if (event === 'hardwareBackPress') backListeners.push(fn);
    return { remove() { const i = backListeners.indexOf(fn); if (i >= 0) backListeners.splice(i, 1); } };
  },
};
globalThis.__androidBackPress = () => {
  for (let i = backListeners.length - 1; i >= 0; i--) if (backListeners[i]()) return true;
  return false;
};
globalThis.__androidBackListenerCount = () => backListeners.length;
