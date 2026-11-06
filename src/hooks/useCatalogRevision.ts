/**
 * The current catalog revision; re-renders the component when a newer verified
 * catalog is committed (native remote catalog, 2026-11-06). Screens put it in the
 * dependency list of their catalog load so a mounted screen picks up new cards and
 * series without being remounted. On web the revision never changes.
 */
import { useEffect, useState } from 'react';
import { getCatalogRevision, subscribeCatalogRevision } from '../utils/staticData';

export function useCatalogRevision(): string {
  const [revision, setRevision] = useState<string>(() => getCatalogRevision());
  useEffect(() => {
    setRevision(getCatalogRevision());
    return subscribeCatalogRevision(setRevision);
  }, []);
  return revision;
}
