import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import { Platform } from 'react-native';
import platformStorage from '../stores/storage';
import { APP_VERSION } from '../constants/index';
import {
  buildExport,
  newDiagnosticId,
  pruneEntries,
  sanitizeEntry,
  type DiagEntry,
  type DiagKind,
} from '../services/scanDiagnostics';
import { registerDiagnosticsRecorder } from '../services/diagnosticsSink';

/**
 * Persisted local diagnostic log (src/services/scanDiagnostics has the privacy
 * contract). Every write goes through sanitizeEntry + pruneEntries; every method
 * swallows its own errors — diagnostics can never break a scan or a sign-in.
 */
interface ScanDiagnosticsState {
  entries: DiagEntry[];
  start: (kind: DiagKind, fields?: Partial<DiagEntry>) => string | null;
  update: (id: string | null | undefined, patch: Partial<DiagEntry>) => void;
  clear: () => void;
  exportText: () => string;
}

/** Build identity: app version + native build number when the runtime exposes it. */
export function buildInfo(): { platform: string; appVersion: string; nativeBuild: string } {
  let nativeBuild = 'unknown';
  try {
    // Lazily so a missing native module degrades to 'unknown'.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const app: any = Platform.OS === 'web' ? null : require('expo-application');
    if (app && typeof app.nativeBuildVersion === 'string') nativeBuild = app.nativeBuildVersion;
  } catch {
    nativeBuild = 'unknown';
  }
  return { platform: Platform.OS, appVersion: APP_VERSION, nativeBuild };
}

function merge(entry: DiagEntry, patch: Partial<DiagEntry>): any {
  return {
    ...entry,
    ...patch,
    stagesMs: { ...entry.stagesMs, ...(patch.stagesMs ?? {}) },
    errors: [...entry.errors, ...(patch.errors ?? [])],
    timeline: [...(entry.timeline ?? []), ...(patch.timeline ?? [])],
    extracted: patch.extracted ? { ...entry.extracted, ...patch.extracted } : entry.extracted,
    match: patch.match ? { ...entry.match, ...patch.match } : entry.match,
  };
}

export const useScanDiagnosticsStore = create<ScanDiagnosticsState>()(
  persist(
    (set, get) => ({
      entries: [],
      start: (kind, fields = {}) => {
        try {
          const id = newDiagnosticId();
          const entry = sanitizeEntry({ id, kind, at: new Date().toISOString(), model: 'unknown', errors: [], stagesMs: {}, ...buildInfo(), ...fields, outcome: kind === 'scan' ? 'pending' : undefined });
          if (!entry) return null;
          set({ entries: pruneEntries([...get().entries, entry]) });
          return id;
        } catch {
          return null;
        }
      },
      update: (id, patch) => {
        if (!id) return;
        try {
          const entries = get().entries.map((e) => (e.id === id ? (sanitizeEntry(merge(e, patch)) ?? e) : e));
          set({ entries: pruneEntries(entries) });
        } catch {
          // diagnostics never throw into the caller
        }
      },
      clear: () => set({ entries: [] }),
      exportText: () => buildExport(get().entries),
    }),
    {
      name: 'holohunter-scan-diagnostics',
      storage: createJSONStorage(() => platformStorage),
      partialize: (s) => ({ entries: s.entries }),
      // Whatever was stored (older schema, tampering) is re-sanitised and pruned on load.
      merge: (persisted: any, current) => ({ ...current, entries: pruneEntries(persisted?.entries) }),
    },
  ),
);

// Sign-in failures (authStore) reach the log through the dependency-free sink.
registerDiagnosticsRecorder((kind, fields) => {
  useScanDiagnosticsStore.getState().start(kind, fields as Partial<DiagEntry>);
});
