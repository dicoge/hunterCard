/**
 * Static card-data loader — WEB variant (DIC-972).
 *
 * Web is served same-origin with the /data/* JSON assets, so it keeps fetching
 * them by relative URL exactly as before — no giant JSON is bundled into the web
 * build. Native/Node use staticData.ts, which reads the sanitized bundled asset
 * and (native only) a verified remote catalog revision.
 *
 * The revision API below mirrors staticData.ts so consumers compile and behave the
 * same on every platform: a web page always reads the CURRENT deployment's data on
 * load, so its revision is a constant and never changes while the page is open.
 */

export interface CatalogSnapshot {
  revision: string;
  sequence: number;
  source: 'bundled' | 'remote';
  database: any;
  seriesNames: Record<string, string>;
  dataObservedAt: string | null;
  publishedAt: string | null;
}

const WEB_REVISION = 'web-same-origin';

async function fetchJson(path: string, timeoutMs: number): Promise<any> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function loadDatabaseJson(): Promise<any> {
  return fetchJson('/data/database.json', 15000);
}

export async function loadSeriesNamesJson(): Promise<Record<string, string>> {
  return fetchJson('/data/series-names.json', 10000);
}

export async function loadCatalogSnapshot(): Promise<CatalogSnapshot> {
  const [database, seriesNames] = await Promise.all([loadDatabaseJson(), loadSeriesNamesJson()]);
  return {
    revision: WEB_REVISION,
    sequence: 0,
    source: 'remote',
    database,
    seriesNames,
    dataObservedAt: typeof database?.lastUpdated === 'string' ? database.lastUpdated : null,
    publishedAt: null,
  };
}

export function getCatalogRevision(): string {
  return WEB_REVISION;
}

export function subscribeCatalogRevision(_listener: (revision: string) => void): () => void {
  return () => {};
}

export function getCatalogStatus() {
  return {
    revision: WEB_REVISION,
    source: 'remote' as const,
    dataObservedAt: null,
    publishedAt: null,
    lastCheckAt: null,
    lastResult: 'unsupported' as const,
    lastError: null,
    refused: false,
  };
}

export async function refreshCatalog(_options?: { force?: boolean }) {
  return { status: 'unsupported' as const, revision: WEB_REVISION };
}
