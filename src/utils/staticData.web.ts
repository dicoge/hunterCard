/**
 * Static card-data loader — WEB variant (DIC-972).
 *
 * Web is served same-origin with the /data/* JSON assets, so it keeps fetching
 * them by relative URL exactly as before — no giant JSON is bundled into the web
 * build. Native/Node use staticData.ts, which reads the sanitized bundled asset.
 */

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
