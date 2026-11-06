// Test-only stand-in for src/utils/staticData (the platform catalog loader), used ONLY by
// cases that need a modified catalog or a failing load. It never fetches: the catalog is
// what the test put on globalThis.__catalogDb; __catalogFail makes the load throw.
// It mirrors the full staticData surface (snapshot + revision API, 2026-11-06) with a
// constant revision, so consumers' revision-keyed caches behave exactly as before.
export async function loadDatabaseJson() {
  globalThis.__catalogLoads = (globalThis.__catalogLoads ?? 0) + 1;
  if (globalThis.__catalogFail) throw new Error('catalog unavailable (test)');
  return globalThis.__catalogDb;
}
export async function loadSeriesNamesJson() {
  return {};
}
export async function loadCatalogSnapshot() {
  const database = await loadDatabaseJson();
  const seriesNames = await loadSeriesNamesJson();
  return { revision: 'fixture', sequence: 0, source: 'bundled', database, seriesNames, dataObservedAt: null, publishedAt: null };
}
export function getCatalogRevision() {
  return 'fixture';
}
export function subscribeCatalogRevision() {
  return () => {};
}
export function getCatalogStatus() {
  return { revision: 'fixture', source: 'bundled', dataObservedAt: null, publishedAt: null, lastCheckAt: null, lastResult: 'unsupported', lastError: null, refused: false };
}
export async function refreshCatalog() {
  return { status: 'unsupported', revision: 'fixture' };
}
