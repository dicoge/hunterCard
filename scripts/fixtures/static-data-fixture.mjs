// Test-only stand-in for src/utils/staticData (the platform catalog loader), used ONLY by
// cases that need a modified catalog or a failing load. It never fetches: the catalog is
// what the test put on globalThis.__catalogDb; __catalogFail makes the load throw.
export async function loadDatabaseJson() {
  globalThis.__catalogLoads = (globalThis.__catalogLoads ?? 0) + 1;
  if (globalThis.__catalogFail) throw new Error('catalog unavailable (test)');
  return globalThis.__catalogDb;
}
export async function loadSeriesNamesJson() {
  return {};
}
