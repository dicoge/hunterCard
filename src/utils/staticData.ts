/**
 * Static card-data loader — NATIVE + Node fallback variant (DIC-972).
 *
 * Metro resolves staticData.web.ts on web; native (iOS/Android) and tsc/Node
 * fall back to this file. Native has no page origin, so a root-relative
 * fetch('/data/...') is unresolvable by React Native's fetch and every guest
 * data load silently fails — the reported "無法載入系列資料" home crash. Native
 * therefore reads the data it SHIPS in its own bundle instead of the network.
 *
 * It must read the pre-sanitized asset, never the canonical DB: the network copy
 * a full web deploy serves can still carry Store-MVP-forbidden fields, and native
 * runs no mapping/post-hook to strip them. public/data/database.json is the exact
 * bytes an Android/iOS export ships (expo copies public/ verbatim) and is pinned
 * to sanitizeDatabase(data/database.json) by scripts/generate-native-database.mjs
 * + scripts/test-store-mvp-native-export.mjs, so requiring it keeps native
 * fail-closed by construction. series-names.json is a code→display-name map with
 * no card fields, so it is safe to bundle as-is.
 */

// require (not import) so tsc does not build a multi-MB literal type for the DB,
// and Metro inlines the parsed JSON into the native bundle.
const databaseJson = require('../../public/data/database.json');
const seriesNamesJson = require('../../data/series-names.json');

export async function loadDatabaseJson(): Promise<any> {
  return databaseJson;
}

export async function loadSeriesNamesJson(): Promise<Record<string, string>> {
  return seriesNamesJson;
}
