import { Alert, AlertButton, Platform } from 'react-native';

// react-native-web ships no working Alert: Alert.alert() never renders and its
// button callbacks never fire, so confirms (watchlist remove, delete account)
// silently no-op and login errors are invisible. On web we map to the native
// window.confirm / window.alert dialogs and invoke the matching button handler.
export function showAlert(
  title: string,
  message?: string,
  buttons?: AlertButton[],
): void {
  if (Platform.OS !== 'web' || typeof window === 'undefined') {
    Alert.alert(title, message, buttons);
    return;
  }

  const body = [title, message].filter(Boolean).join('\n\n');

  if (!buttons || buttons.length === 0) {
    window.alert(body);
    return;
  }

  const cancelButton = buttons.find((b) => b.style === 'cancel');
  const confirmButton =
    buttons.find((b) => b.style !== 'cancel') ?? buttons[buttons.length - 1];

  // Single-button dialogs are informational — no need to ask for confirmation.
  if (buttons.length === 1) {
    window.alert(body);
    confirmButton?.onPress?.();
    return;
  }

  const confirmed = window.confirm(body);
  if (confirmed) {
    confirmButton?.onPress?.();
  } else {
    cancelButton?.onPress?.();
  }
}
