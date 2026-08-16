import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const ANALYTICS_SCHEMA_VERSION = 1;
export const ANALYTICS_ALGORITHM_VERSION = 'tournament-analytics-v1';
export const DEFAULT_CONFIG = Object.freeze({
  similarity: 'weightedJaccard',
  cluster: {
    method: 'agglomerative',
    linkage: 'average',
    threshold: 0.55,
  },
  zoneWeights: {
    oshi: 1,
    main: 1,
    yell: 0.25,
  },
  association: {
    minSupportCount: 1,
  },
  roundingDigits: 6,
});

const MONTH_RE = /^\d{4}-\d{2}\.json$/;
const ZONE_ORDER = new Map([
  ['oshi', 0],
  ['main', 1],
  ['yell', 2],
]);

export function stableStringify(value) {
  return `${JSON.stringify(sortJson(value), null, 2)}\n`;
}

export function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])]),
  );
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

export function round(value, digits = DEFAULT_CONFIG.roundingDigits) {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}

export function featureKey(card) {
  const version = card.version == null || card.version === '' ? 'NO_VERSION' : String(card.version);
  return `${card.zone}|${card.cardNumber}|${version}`;
}

export function parseFeatureKey(key) {
  const [zone, cardNumber, version] = key.split('|');
  return { zone, cardNumber, version: version === 'NO_VERSION' ? null : version };
}

function featureComparator(a, b) {
  const pa = parseFeatureKey(a);
  const pb = parseFeatureKey(b);
  return (
    (ZONE_ORDER.get(pa.zone) ?? 99) - (ZONE_ORDER.get(pb.zone) ?? 99) ||
    pa.cardNumber.localeCompare(pb.cardNumber) ||
    String(pa.version ?? '').localeCompare(String(pb.version ?? ''))
  );
}

function deckComparator(a, b) {
  return (
    String(a.month).localeCompare(String(b.month)) ||
    String(a.eventId).localeCompare(String(b.eventId)) ||
    String(a.block ?? '').localeCompare(String(b.block ?? '')) ||
    String(a.deckId).localeCompare(String(b.deckId))
  );
}

export function loadMonthlyReports(tournamentsDir) {
  if (!fs.existsSync(tournamentsDir)) return [];
  return fs
    .readdirSync(tournamentsDir)
    .filter((name) => MONTH_RE.test(name))
    .sort()
    .map((name) => {
      const file = path.join(tournamentsDir, name);
      const raw = fs.readFileSync(file, 'utf8');
      return { file, fileName: name, raw, hash: sha256(raw), report: JSON.parse(raw) };
    });
}

export function extractDecks(monthlyReports) {
  const decks = [];
  const excludedIncompleteDecks = [];
  for (const entry of monthlyReports) {
    const month = entry.report.month ?? entry.fileName.slice(0, -5);
    for (const event of entry.report.events ?? []) {
      for (const deck of event.decks ?? []) {
        const normalized = {
          month,
          reportFile: entry.fileName,
          sourceReportHash: entry.hash,
          eventId: event.eventId,
          eventName: event.name,
          eventDate: event.date ?? null,
          sourceUrl: deck.sourceUrl ?? event.sourceUrl ?? null,
          deckId: deck.deckId ?? (deck.decklogCode ? `decklog:${deck.decklogCode}` : `${event.eventId}#unknown`),
          decklogCode: deck.decklogCode ?? null,
          block: deck.block ?? null,
          playerName: deck.playerName ?? null,
          rank: deck.rank ?? null,
          rankLabel: deck.rankLabel ?? null,
          deckName: deck.deckName ?? null,
          archetypeId: deck.archetypeId ?? null,
          archetypeLabel: deck.archetypeLabel ?? null,
          oshi: deck.oshi ?? null,
          colors: Array.isArray(deck.colors) ? [...deck.colors].sort() : [],
          cards: Array.isArray(deck.cards) ? deck.cards : [],
          cardsVerified: deck.cardsVerified === true,
        };
        if (normalized.cardsVerified) decks.push(normalized);
        else {
          excludedIncompleteDecks.push({
            month,
            eventId: normalized.eventId,
            deckId: normalized.deckId,
            reason: 'cardsVerified is not true; card list excluded from quantitative analysis',
          });
        }
      }
    }
  }
  return { decks: decks.sort(deckComparator), excludedIncompleteDecks };
}

export function buildVectors(decks, config = DEFAULT_CONFIG) {
  const featureSet = new Set();
  const vectors = decks.map((deck) => {
    const entries = new Map();
    for (const card of deck.cards) {
      if (!card || !card.zone || !card.cardNumber) continue;
      const count = Number(card.count);
      if (!Number.isFinite(count) || count <= 0) continue;
      const key = featureKey(card);
      entries.set(key, (entries.get(key) ?? 0) + count);
      featureSet.add(key);
    }
    return { deckId: deck.deckId, entries };
  });
  const featureDictionary = [...featureSet].sort(featureComparator).map((key, index) => ({
    index,
    key,
    ...parseFeatureKey(key),
    weight: config.zoneWeights[parseFeatureKey(key).zone] ?? 1,
  }));
  const featureIndex = new Map(featureDictionary.map((feature) => [feature.key, feature.index]));
  const deckVectors = vectors.map((vector) => ({
    deckId: vector.deckId,
    features: [...vector.entries.entries()]
      .sort(([a], [b]) => featureComparator(a, b))
      .map(([key, count]) => ({ index: featureIndex.get(key), key, count })),
  }));
  return { featureDictionary, featureIndex, deckVectors };
}

export function weightedJaccard(a, b, featureIndex, config = DEFAULT_CONFIG) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  let minSum = 0;
  let maxSum = 0;
  for (const key of keys) {
    const zone = parseFeatureKey(key).zone;
    const weight = config.zoneWeights[zone] ?? 1;
    const av = (a.get(key) ?? 0) * weight;
    const bv = (b.get(key) ?? 0) * weight;
    minSum += Math.min(av, bv);
    maxSum += Math.max(av, bv);
  }
  return maxSum === 0 ? 0 : minSum / maxSum;
}

export function buildSimilarity(decks, deckVectors, config = DEFAULT_CONFIG) {
  const vectorMaps = deckVectors.map((vector) => new Map(vector.features.map((feature) => [feature.key, feature.count])));
  const matrix = decks.map((deck, i) =>
    decks.map((_, j) => {
      if (i === j) return 1;
      return round(weightedJaccard(vectorMaps[i], vectorMaps[j], null, config), config.roundingDigits);
    }),
  );
  return {
    method: 'weightedJaccard',
    justification:
      'Weighted Jaccard compares sparse count vectors by shared quantities over union quantities, handles different deck sizes/features transparently, and keeps exact zone/version features isolated.',
    deckIds: decks.map((deck) => deck.deckId),
    matrix,
  };
}

function averageLinkSimilarity(clusterA, clusterB, matrix) {
  let sum = 0;
  let count = 0;
  for (const i of clusterA.members) {
    for (const j of clusterB.members) {
      sum += matrix[i][j];
      count += 1;
    }
  }
  return count === 0 ? 0 : sum / count;
}

export function buildClusters(decks, deckVectors, similarity, config = DEFAULT_CONFIG) {
  if (decks.length === 0) return [];
  let clusters = decks.map((_, index) => ({ members: [index] }));
  while (clusters.length > 1) {
    let best = null;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        const score = averageLinkSimilarity(clusters[i], clusters[j], similarity.matrix);
        const signature = `${clusters[i].members.join(',')}|${clusters[j].members.join(',')}`;
        if (!best || score > best.score || (score === best.score && signature < best.signature)) {
          best = { i, j, score, signature };
        }
      }
    }
    if (!best || best.score < config.cluster.threshold) break;
    const merged = { members: [...clusters[best.i].members, ...clusters[best.j].members].sort((a, b) => a - b) };
    clusters = clusters.filter((_, index) => index !== best.i && index !== best.j).concat(merged);
    clusters.sort((a, b) => a.members[0] - b.members[0]);
  }

  const allPresence = new Map();
  for (const vector of deckVectors) {
    const present = new Set(vector.features.map((feature) => feature.key));
    for (const key of present) allPresence.set(key, (allPresence.get(key) ?? 0) + 1);
  }

  return clusters.map((cluster, index) => {
    const memberDecks = cluster.members.map((member) => decks[member]);
    const memberVectors = cluster.members.map((member) => deckVectors[member]);
    const localPresence = new Map();
    const localCounts = new Map();
    for (const vector of memberVectors) {
      const seen = new Set();
      for (const feature of vector.features) {
        localCounts.set(feature.key, (localCounts.get(feature.key) ?? 0) + feature.count);
        if (!seen.has(feature.key)) {
          localPresence.set(feature.key, (localPresence.get(feature.key) ?? 0) + 1);
          seen.add(feature.key);
        }
      }
    }
    const sampleCount = memberDecks.length;
    const coreCards = [...localPresence.entries()]
      .filter(([, count]) => count === sampleCount)
      .sort(([a], [b]) => featureComparator(a, b))
      .slice(0, 20)
      .map(([key]) => ({ key, ...parseFeatureKey(key), presence: sampleCount, averageCount: round((localCounts.get(key) ?? 0) / sampleCount) }));
    const differentiatingCards = [...localPresence.entries()]
      .map(([key, count]) => {
        const inRate = count / sampleCount;
        const outsideDecks = decks.length - sampleCount;
        const outsideCount = (allPresence.get(key) ?? 0) - count;
        const outsideRate = outsideDecks === 0 ? 0 : outsideCount / outsideDecks;
        return { key, ...parseFeatureKey(key), presence: count, liftOverRest: round(inRate - outsideRate) };
      })
      .sort((a, b) => b.liftOverRest - a.liftOverRest || featureComparator(a.key, b.key))
      .slice(0, 12);
    const oshiCounts = countLabels(memberDecks.map((deck) => deck.oshi ?? 'UNKNOWN'));
    const archetypeCounts = countLabels(memberDecks.map((deck) => deck.archetypeLabel ?? deck.archetypeId ?? 'UNKNOWN'));
    return {
      clusterId: `cluster-${String(index + 1).padStart(3, '0')}`,
      sampleCount,
      members: memberDecks.map((deck) => deck.deckId),
      representativeOshi: topLabel(oshiCounts),
      representativeArchetype: topLabel(archetypeCounts),
      coreCards,
      differentiatingCards,
    };
  });
}

function countLabels(labels) {
  const counts = new Map();
  for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1);
  return counts;
}

function topLabel(counts) {
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] ?? 'UNKNOWN';
}

export function buildAssociations(decks, deckVectors, config = DEFAULT_CONFIG) {
  const n = decks.length;
  const presenceCounts = new Map();
  const pairCounts = new Map();
  for (const vector of deckVectors) {
    const present = [...new Set(vector.features.map((feature) => feature.key))].sort(featureComparator);
    for (const key of present) presenceCounts.set(key, (presenceCounts.get(key) ?? 0) + 1);
    for (let i = 0; i < present.length; i++) {
      for (let j = i + 1; j < present.length; j++) {
        const pairKey = `${present[i]}||${present[j]}`;
        pairCounts.set(pairKey, (pairCounts.get(pairKey) ?? 0) + 1);
      }
    }
  }
  const index = [...presenceCounts.keys()].sort(featureComparator).map((key, i) => ({ index: i, key, ...parseFeatureKey(key), deckPresence: presenceCounts.get(key) ?? 0 }));
  const indexMap = new Map(index.map((item) => [item.key, item.index]));
  const minSupportCount = config.association.minSupportCount;
  const relations = [...pairCounts.entries()]
    .filter(([, count]) => count >= minSupportCount)
    .map(([pairKey, count]) => {
      const [a, b] = pairKey.split('||');
      const aCount = presenceCounts.get(a) ?? 0;
      const bCount = presenceCounts.get(b) ?? 0;
      const support = n === 0 ? 0 : count / n;
      const confidenceAB = aCount === 0 ? 0 : count / aCount;
      const confidenceBA = bCount === 0 ? 0 : count / bCount;
      const lift = n === 0 || aCount === 0 || bCount === 0 ? 0 : support / ((aCount / n) * (bCount / n));
      return {
        a,
        b,
        count,
        support: round(support),
        confidenceAB: round(confidenceAB),
        confidenceBA: round(confidenceBA),
        lift: round(lift),
        denominators: {
          decks: n,
          aDecks: aCount,
          bDecks: bCount,
        },
      };
    })
    .sort((x, y) => y.count - x.count || x.a.localeCompare(y.a) || x.b.localeCompare(y.b));
  return {
    method: 'deckPresenceCooccurrence',
    minSupportCount,
    index,
    relations,
    sparseMatrix: relations.map((relation) => ({
      i: indexMap.get(relation.a),
      j: indexMap.get(relation.b),
      count: relation.count,
      support: relation.support,
      lift: relation.lift,
    })),
  };
}

export function analyzeReports(monthlyReports, options = {}) {
  const config = mergeConfig(DEFAULT_CONFIG, options.config ?? {});
  const generatedAt = options.generatedAt ?? deterministicGeneratedAt(monthlyReports);
  const { decks, excludedIncompleteDecks } = extractDecks(monthlyReports);
  const { featureDictionary, deckVectors } = buildVectors(decks, config);
  const similarity = buildSimilarity(decks, deckVectors, config);
  const clusters = buildClusters(decks, deckVectors, similarity, config);
  const associations = buildAssociations(decks, deckVectors, config);
  const warnings = sampleWarnings(decks.length, excludedIncompleteDecks.length);

  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generatedAt,
    algorithm: {
      name: ANALYTICS_ALGORITHM_VERSION,
      config,
      formulas: {
        weightedJaccard: 'sum_i min(w_i*x_i, w_i*y_i) / sum_i max(w_i*x_i, w_i*y_i)',
        support: 'cooccurrenceDecks(A,B) / sampleSize',
        confidenceAB: 'cooccurrenceDecks(A,B) / decksContaining(A)',
        lift: 'support(A,B) / (support(A) * support(B))',
      },
    },
    inputReports: monthlyReports.map((entry) => ({
      file: entry.fileName,
      month: entry.report.month ?? entry.fileName.slice(0, -5),
      contentSha256: entry.hash,
      generatedAt: entry.report.generatedAt ?? null,
    })),
    inputDeckIds: decks.map((deck) => deck.deckId),
    sampleSize: decks.length,
    excludedIncompleteDecks,
    warnings,
    decks: decks.map((deck) => ({
      month: deck.month,
      eventId: deck.eventId,
      deckId: deck.deckId,
      sourceReportHash: deck.sourceReportHash,
      block: deck.block,
      rank: deck.rank,
      rankLabel: deck.rankLabel,
      oshi: deck.oshi,
      archetypeId: deck.archetypeId,
      archetypeLabel: deck.archetypeLabel,
    })),
    vectors: {
      schema: 'sparse count vector: feature key = zone|exact cardNumber|source-proven version or NO_VERSION; quantities preserved; zones and versions are never conflated.',
      featureDictionary,
      deckVectors,
    },
    similarity,
    clusters,
    associations,
  };
}

export function monthAnalytics(fullAnalytics, month) {
  const deckIdSet = new Set(fullAnalytics.decks.filter((deck) => deck.month === month).map((deck) => deck.deckId));
  const monthExcluded = fullAnalytics.excludedIncompleteDecks.filter((deck) => deck.month === month);
  const warnings = sampleWarnings(deckIdSet.size, monthExcluded.length);
  const deckIndexes = fullAnalytics.similarity.deckIds
    .map((deckId, index) => ({ deckId, index }))
    .filter((item) => deckIdSet.has(item.deckId));
  const usedFeatureKeys = new Set();
  for (const vector of fullAnalytics.vectors.deckVectors.filter((vector) => deckIdSet.has(vector.deckId))) {
    for (const feature of vector.features) usedFeatureKeys.add(feature.key);
  }
  const featureDictionary = fullAnalytics.vectors.featureDictionary.filter((feature) => usedFeatureKeys.has(feature.key));
  return {
    ...fullAnalytics,
    inputReports: fullAnalytics.inputReports.filter((report) => report.month === month),
    inputDeckIds: [...deckIdSet],
    sampleSize: deckIdSet.size,
    excludedIncompleteDecks: monthExcluded,
    warnings,
    decks: fullAnalytics.decks.filter((deck) => deck.month === month),
    vectors: {
      ...fullAnalytics.vectors,
      featureDictionary,
      deckVectors: fullAnalytics.vectors.deckVectors.filter((vector) => deckIdSet.has(vector.deckId)),
    },
    similarity: {
      ...fullAnalytics.similarity,
      deckIds: deckIndexes.map((item) => item.deckId),
      matrix: deckIndexes.map((row) => deckIndexes.map((col) => fullAnalytics.similarity.matrix[row.index][col.index])),
    },
    clusters: fullAnalytics.clusters
      .map((cluster) => ({ ...cluster, members: cluster.members.filter((deckId) => deckIdSet.has(deckId)) }))
      .filter((cluster) => cluster.members.length > 0)
      .map((cluster, index) => ({ ...cluster, clusterId: `cluster-${String(index + 1).padStart(3, '0')}`, sampleCount: cluster.members.length })),
    associations: buildAssociations(
      fullAnalytics.decks.filter((deck) => deck.month === month).map((deck) => ({ deckId: deck.deckId })),
      fullAnalytics.vectors.deckVectors.filter((vector) => deckIdSet.has(vector.deckId)),
      fullAnalytics.algorithm.config,
    ),
  };
}

function sampleWarnings(sampleSize, excludedCount) {
  const warnings = [];
  if (sampleSize === 0) warnings.push('N=0: no cardsVerified:true decks; quantitative outputs are empty.');
  else if (sampleSize === 1) warnings.push('N=1: singleton sample; similarity and association are descriptive only.');
  else if (sampleSize <= 2) warnings.push(`N=${sampleSize}: exploratory pipeline proof only; not statistically representative.`);
  if (excludedCount > 0) warnings.push(`${excludedCount} incomplete deck(s) excluded because cardsVerified is not true.`);
  return warnings;
}

export function analyticsIndex(monthArtifacts, generatedAt) {
  return {
    schemaVersion: ANALYTICS_SCHEMA_VERSION,
    generatedAt,
    algorithmVersion: ANALYTICS_ALGORITHM_VERSION,
    months: monthArtifacts
      .map((artifact) => ({
        month: artifact.inputReports[0]?.month ?? null,
        sampleSize: artifact.sampleSize,
        inputDeckIds: artifact.inputDeckIds,
        warnings: artifact.warnings,
      }))
      .filter((item) => item.month)
      .sort((a, b) => b.month.localeCompare(a.month)),
  };
}

function deterministicGeneratedAt(monthlyReports) {
  const dates = monthlyReports.map((entry) => entry.report.generatedAt).filter(Boolean).sort();
  return dates.at(-1) ?? '1970-01-01T00:00:00.000Z';
}

function mergeConfig(base, override) {
  return {
    ...base,
    ...override,
    cluster: { ...base.cluster, ...(override.cluster ?? {}) },
    zoneWeights: { ...base.zoneWeights, ...(override.zoneWeights ?? {}) },
    association: { ...base.association, ...(override.association ?? {}) },
  };
}
