/**
 * Static card-data loader — NATIVE + Node fallback variant (DIC-972; remote
 * catalog 2026-11-06).
 *
 * Metro resolves staticData.web.ts on web; native (iOS/Android) and tsc/Node
 * fall back to this file. Native has no page origin, so a root-relative
 * fetch('/data/...') is unresolvable by React Native's fetch and every guest
 * data load silently fails — the reported "無法載入系列資料" home crash. Native
 * therefore always HAS the data it ships in its own bundle, and never builds a
 * relative URL.
 *
 * The bundle copy is the pre-sanitized asset, never the canonical DB:
 * public/data/database.json is pinned to sanitizeDatabase(data/database.json) by
 * scripts/generate-native-database.mjs + scripts/test-store-mvp-native-export.mjs.
 * series-names.json is a code→display-name map with no card fields.
 *
 * Remote catalog: on native, src/services/catalog/catalogRepository.ts may replace
 * the bundled snapshot with a newer, verified, sanitized catalog published on the
 * fixed production origin (absolute https URL, see catalogContract.ts), persisted
 * as app-private files with a previous-good copy. Every read below goes through
 * ONE snapshot, so the database and the series names always share a revision.
 * In Node/tsc catalogPlatform.ts supplies no platform: the bundled catalog is the
 * only source and nothing touches the network.
 */

// Plain (attribute-free) JSON imports: Metro inlines them into the native bundle,
// and Node resolves them via scripts/register-ts.mjs so the guest-data regression
// executes this exact loader. Consumed as `any`, so tsc does not materialize a
// multi-MB literal type for the DB.
import databaseJson from '../../public/data/database.json';
import seriesNamesJson from '../../data/series-names.json';
import {
  createCatalogRepository,
  type CatalogPlatform,
  type CatalogRepository,
  type CatalogRepositoryOptions,
  type CatalogSnapshot,
  type CatalogStatus,
  type RefreshResult,
} from '../services/catalog/catalogRepository';
import { createCatalogPlatform } from '../services/catalog/catalogPlatform';

export type { CatalogSnapshot, CatalogStatus, RefreshResult };

const bundled = {
  database: databaseJson as any,
  seriesNames: seriesNamesJson as Record<string, string>,
};

const listeners = new Set<(revision: string) => void>();

function emit(snapshot: CatalogSnapshot): void {
  for (const listener of [...listeners]) {
    try { listener(snapshot.revision); } catch { /* a consumer's error never blocks the others */ }
  }
}

function makeRepository(
  platform: CatalogPlatform | null,
  extra: Partial<Omit<CatalogRepositoryOptions, 'bundled' | 'platform' | 'onChange'>> = {},
): CatalogRepository {
  return createCatalogRepository({ ...extra, bundled, platform, onChange: emit });
}

let repository: CatalogRepository = makeRepository(createCatalogPlatform());

/** One coherent catalog revision (database + series names). */
export async function loadCatalogSnapshot(): Promise<CatalogSnapshot> {
  return repository.loadSnapshot();
}

export async function loadDatabaseJson(): Promise<any> {
  return (await repository.loadSnapshot()).database;
}

export async function loadSeriesNamesJson(): Promise<Record<string, string>> {
  return (await repository.loadSnapshot()).seriesNames;
}

/** The revision every derived cache must be keyed by. */
export function getCatalogRevision(): string {
  return repository.getSnapshot().revision;
}

/** Called with the new revision after a verified catalog has been committed. */
export function subscribeCatalogRevision(listener: (revision: string) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function getCatalogStatus(): CatalogStatus {
  return repository.getStatus();
}

/** Launch/foreground check; bounded, single-flight, backed off; never throws. */
export function refreshCatalog(options?: { force?: boolean }): Promise<RefreshResult> {
  return repository.refresh(options);
}

/**
 * Test seam (same convention as the screens' `__seed…ForTest` helpers): rebuild the
 * repository over an injected platform (fake files / fetch / sha256). The origin is
 * NOT injectable — catalogRepository.ts always uses PRODUCTION_ORIGIN — so a test
 * can only answer requests for the real URLs. Passing `null` restores the default.
 */
export function __setCatalogPlatformForTest(
  platform: CatalogPlatform | null,
  extra: Partial<Omit<CatalogRepositoryOptions, 'bundled' | 'platform' | 'onChange'>> = {},
): CatalogRepository {
  const before = repository.getSnapshot().revision;
  repository = makeRepository(platform ?? createCatalogPlatform(), extra);
  const after = repository.getSnapshot();
  if (after.revision !== before) emit(after);
  return repository;
}
