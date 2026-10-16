import { Platform, Share } from 'react-native';

/**
 * User-initiated export of the local diagnostic JSON: the system share sheet on
 * iOS / Android (React Native Share), a file download on web. Nothing is sent
 * automatically; the user chooses where it goes.
 */
export async function exportDiagnosticsText(text: string, filename = 'holohunter-diagnostics.json'): Promise<'shared' | 'downloaded' | 'dismissed'> {
  if (Platform.OS === 'web' && typeof document !== 'undefined' && typeof Blob !== 'undefined') {
    const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
    return 'downloaded';
  }
  const result = await Share.share({ message: text, title: filename });
  return result?.action === Share.dismissedAction ? 'dismissed' : 'shared';
}
