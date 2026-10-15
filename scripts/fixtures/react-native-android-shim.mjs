// react-native-web with Platform.OS forced to 'android', so a screen's native
// branch can be rendered under jsdom (scripts/test-scan-native-crop-render.mjs).
export * from 'react-native-web';
import * as W from 'react-native-web';
export const Platform = {
  ...W.Platform,
  OS: 'android',
  select: (o) => (o.android !== undefined ? o.android : o.native !== undefined ? o.native : o.default),
};
