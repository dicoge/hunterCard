/**
 * Remote catalog lifecycle — web (no-op). A web page reads the current deployment's
 * same-origin /data/* on every load; there is nothing to refresh in place.
 */
export function installCatalogUpdates(): () => void {
  return () => {};
}
