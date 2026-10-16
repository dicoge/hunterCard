/**
 * Dependency-free hand-off to the local diagnostic log. Modules that must stay free of
 * react-native / storage imports (authStore) record through here; the persisted store
 * (src/store/scanDiagnosticsStore) registers itself as the recorder when it loads
 * (App.tsx imports it at start). Never throws.
 */
type Recorder = (kind: 'scan' | 'auth', fields: Record<string, unknown>) => void;

let recorder: Recorder | null = null;

export function registerDiagnosticsRecorder(next: Recorder | null): void {
  recorder = next;
}

export function recordDiagnostic(kind: 'scan' | 'auth', fields: Record<string, unknown>): void {
  try {
    recorder?.(kind, fields);
  } catch {
    // diagnostics are best-effort
  }
}
