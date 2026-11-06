/**
 * Catalog platform — default variant (Node, tsc).
 *
 * Metro resolves catalogPlatform.native.ts on iOS/Android. Everything else —
 * Node tests importing src/utils/staticData.ts, tsc — lands here and gets NO
 * platform: the bundled catalog is the only source, nothing is persisted and the
 * repository never touches the network. Importing this file must never
 * initialise a native Expo module.
 */
import type { CatalogPlatform } from './catalogRepository';

export function createCatalogPlatform(): CatalogPlatform | null {
  return null;
}
