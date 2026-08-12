/**
 * Shared home-screen series catalog builder (DIC-972).
 *
 * The single production path that turns the raw card database + series-name map
 * into the home screen's Booster / Starter / Special groups. HomeScreen renders
 * exactly what this returns, and the native guest-data regression exercises this
 * same function over the real bundled asset — so the test cannot pass while the
 * screen's real extraction regresses.
 */

export interface SeriesItem {
  label: string;
  query: string;
  name: string;
}

export interface SeriesCatalog {
  boosters: SeriesItem[];
  starters: SeriesItem[];
  special: SeriesItem[];
}

interface DatabaseLike {
  cards?: Record<string, { series?: string }>;
}

export function buildSeriesCatalog(
  db: DatabaseLike,
  seriesNames: Record<string, string>,
): SeriesCatalog {
  const seriesSet = new Set<string>();
  for (const card of Object.values(db?.cards ?? {})) {
    const s = card?.series || '';
    if (s) seriesSet.add(s);
  }

  const allSeries: SeriesItem[] = Array.from(seriesSet)
    .sort()
    .map((code) => ({
      label: code,
      query: code,
      name: seriesNames[code] || code,
    }));

  return {
    boosters: allSeries.filter((s) => s.label.startsWith('hBP')),
    starters: allSeries.filter((s) => s.label.startsWith('hSD')),
    special: allSeries.filter((s) => !s.label.startsWith('hBP') && !s.label.startsWith('hSD')),
  };
}
