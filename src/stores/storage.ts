/**
 * Fallback storage module used only when Metro's platform-specific resolution
 * does NOT apply — i.e. tsc type-checking and Node-based test scripts. On device
 * Metro resolves storage.web.ts (web) or storage.native.ts (native) instead, so
 * this implementation never runs in the app.
 *
 * It is a real in-memory StateStorage (not a type-only stub) so persistent
 * zustand stores can be imported and exercised end-to-end in Node regressions
 * (e.g. scripts/test-deck-store-rename.mjs), including persistence + rehydration.
 */
import type { StateStorage } from 'zustand/middleware';

const memory = new Map<string, string>();

const memoryStorage: StateStorage = {
  getItem: (name) => (memory.has(name) ? memory.get(name)! : null),
  setItem: (name, value) => {
    memory.set(name, value);
  },
  removeItem: (name) => {
    memory.delete(name);
  },
};

export default memoryStorage;
