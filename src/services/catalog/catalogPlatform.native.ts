/**
 * Catalog platform — native (iOS/Android) variant.
 *
 * Files: the SDK 54 `expo-file-system` 19.0.x legacy API (`expo-file-system/legacy`:
 * documentDirectory, read/writeAsStringAsync, moveAsync, deleteAsync,
 * makeDirectoryAsync, readDirectoryAsync, getFreeDiskStorageAsync). The catalog
 * lives under the app-private cacheDirectory — no external storage, no SAF, no
 * permission. The ~7 MB database is a FILE, never an AsyncStorage item.
 *
 * Why the cache directory, not documentDirectory: the app does not configure
 * Android auto-backup rules, and the retained revisions (GC keeps every revision
 * either pointer slot references — up to three, ~21 MB of public data)
 * under the backed-up files directory would eat into the per-app backup quota
 * that the user's own data needs. The catalog is re-downloadable public data: if
 * the OS evicts the cache under storage pressure, the repository falls back to
 * the bundled catalog and the next check downloads again — never a blank catalog
 * and never user data loss. Both directories persist across process restarts.
 *
 * Hash: `expo-crypto` digestStringAsync(SHA256) — hex digest of the string's UTF-8
 * bytes, the same definition the publisher uses (sha256 of the served bytes).
 *
 * Network: the global fetch. URLs are always absolute https on PRODUCTION_ORIGIN
 * (built in catalogRepository.ts); this adapter adds no origin of its own.
 */
import * as FileSystem from 'expo-file-system/legacy';
import * as Crypto from 'expo-crypto';
import type { CatalogFetch, CatalogFileSystem, CatalogPlatform } from './catalogRepository';

const ROOT_NAME = 'holohunter-catalog/';

export function createCatalogPlatform(): CatalogPlatform | null {
  const base = FileSystem.cacheDirectory;
  if (!base || typeof globalThis.fetch !== 'function') return null;
  const root = `${base}${ROOT_NAME}`;
  const uri = (path: string) => `${root}${path}`;

  const fs: CatalogFileSystem = {
    async readText(path) {
      const info = await FileSystem.getInfoAsync(uri(path));
      if (!info.exists || info.isDirectory) return null;
      return FileSystem.readAsStringAsync(uri(path), { encoding: FileSystem.EncodingType.UTF8 });
    },
    async writeText(path, text) {
      const slash = path.lastIndexOf('/');
      await FileSystem.makeDirectoryAsync(slash >= 0 ? uri(path.slice(0, slash)) : root, { intermediates: true });
      await FileSystem.writeAsStringAsync(uri(path), text, { encoding: FileSystem.EncodingType.UTF8 });
    },
    async move(from, to) {
      await FileSystem.moveAsync({ from: uri(from), to: uri(to) });
    },
    async remove(path) {
      await FileSystem.deleteAsync(uri(path), { idempotent: true });
    },
    async ensureDir(path) {
      await FileSystem.makeDirectoryAsync(uri(path), { intermediates: true });
    },
    async list(path) {
      try {
        return await FileSystem.readDirectoryAsync(uri(path));
      } catch {
        return [];
      }
    },
    async freeBytes() {
      try {
        const free = await FileSystem.getFreeDiskStorageAsync();
        return Number.isFinite(free) ? free : null;
      } catch {
        return null;
      }
    },
  };

  return {
    fs,
    fetch: globalThis.fetch.bind(globalThis) as unknown as CatalogFetch,
    sha256: async (text) =>
      (await Crypto.digestStringAsync(Crypto.CryptoDigestAlgorithm.SHA256, text)).toLowerCase(),
  };
}
