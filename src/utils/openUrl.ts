import { Linking, Alert } from 'react-native';

const ALLOWED_DOMAINS = [
  'yuyu-tei.jp',
  'hololive-official-cardgame.com',
  'carousell.com.tw',
  // decklog deck permalinks referenced by the tournament report (DIC-979).
  'decklog.bushiroad.com',
];

function isAllowedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return ALLOWED_DOMAINS.some(
      (domain) => parsed.hostname === domain || parsed.hostname.endsWith('.' + domain)
    );
  } catch {
    return false;
  }
}

export async function openUrl(url: string): Promise<void> {
  if (!isAllowedUrl(url)) {
    Alert.alert('不允許的連結', `此連結不被允許開啟: ${url}`);
    return;
  }

  try {
    const supported = await Linking.canOpenURL(url);
    if (supported) {
      await Linking.openURL(url);
    } else {
      Alert.alert('無法開啟連結', `無法開啟: ${url}`);
    }
  } catch (error) {
    console.error('Failed to open URL:', error);
    Alert.alert('錯誤', '無法開啟連結');
  }
}
