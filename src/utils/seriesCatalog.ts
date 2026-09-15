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
  /** DIC-1427 (Pen tmKqY): real art thumb — the series' first card image. */
  thumbUrl?: string;
}

export interface SeriesCatalog {
  boosters: SeriesItem[];
  starters: SeriesItem[];
  special: SeriesItem[];
}

interface DatabaseLike {
  cards?: Record<string, { series?: string; officialImage?: string; localImage?: string; cardNumber?: string; id?: string }>;
}

export function buildSeriesCatalog(
  db: DatabaseLike,
  seriesNames: Record<string, string>,
): SeriesCatalog {
  const seriesSet = new Set<string>();
  // DIC-1427 (Pen tmKqY): the series tiles carry real card art, so track the
  // lowest-numbered card with an image per series as its thumb.
  const thumbBySeries = new Map<string, { key: string; url: string }>();
  for (const card of Object.values(db?.cards ?? {})) {
    const s = card?.series || '';
    if (!s) continue;
    seriesSet.add(s);
    const url = card?.officialImage || card?.localImage || '';
    if (!url) continue;
    const key = (card?.cardNumber || card?.id || '').toLowerCase();
    const existing = thumbBySeries.get(s);
    if (!existing || key < existing.key) thumbBySeries.set(s, { key, url });
  }

  const allSeries: SeriesItem[] = Array.from(seriesSet)
    .sort()
    .map((code) => ({
      label: code,
      query: code,
      name: seriesNames[code] || code,
      thumbUrl: thumbBySeries.get(code)?.url,
    }));

  return {
    boosters: allSeries.filter((s) => s.label.startsWith('hBP')),
    starters: allSeries.filter((s) => s.label.startsWith('hSD')),
    special: allSeries.filter((s) => !s.label.startsWith('hBP') && !s.label.startsWith('hSD')),
  };
}
