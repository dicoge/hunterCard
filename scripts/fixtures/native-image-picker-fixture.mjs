// expo-image-picker stand-in for scripts/test-scan-native-crop-render.mjs: the library
// pick returns the asset the test put on globalThis.__nativePickerAsset. No device.
export const MediaTypeOptions = { Images: 'Images' };
export async function launchImageLibraryAsync() {
  const asset = globalThis.__nativePickerAsset;
  return asset ? { canceled: false, assets: [{ ...asset }] } : { canceled: true, assets: [] };
}
export async function requestMediaLibraryPermissionsAsync() { return { granted: true }; }
export default { MediaTypeOptions, launchImageLibraryAsync, requestMediaLibraryPermissionsAsync };
