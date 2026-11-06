/**
 * Remote native catalog repository (2026-11-06) — pure shared logic.
 *
 * Owns the ONE catalog snapshot (database + series names, always the same
 * revision) that every native consumer reads through src/utils/staticData.ts:
 *
 *   1. start: the bundled sanitized catalog is usable immediately; a persisted
 *      last-known-good revision (if any, and valid) replaces it once restored;
 *   2. refresh (launch / foreground): fetch the small manifest from the fixed
 *      production origin, and only when it names a NEWER publish sequence fetch
 *      the two immutable assets, verify bytes + sha256 + schema + forbidden
 *      fields, stage them, verify the staged copies, then commit by writing a
 *      small pointer — the previous revision stays on disk as previous-good;
 *   3. consumers are notified once, after the commit, with the new revision.
 *
 * No platform module is imported here: file I/O, sha256 and fetch arrive through
 * `CatalogPlatform` (src/services/catalog/catalogPlatform.native.ts on device,
 * fakes in Node tests). Without a platform (Node/tsc default) the bundled catalog
 * is the only source and refresh reports 'unsupported' — no network, ever.
 *
 * Downloaded assets are JSON data; nothing here evaluates code.
 */
import { PRODUCTION_ORIGIN } from '../../config/apiOrigin';
import {
  LIMITS,
  MANIFEST_PATH,
  REVISION_RE,
  parseCatalogManifest,
  utf8ByteLength,
  validateCatalogDatabase,
  validateSeriesNames,
  type CatalogManifest,
} from './catalogContract';

// ── platform seam ──────────────────────────────────────────────────────────

/** Paths are relative to an app-private catalog root owned by the adapter. */
export interface CatalogFileSystem {
  /** File contents, or null when the file does not exist. */
  readText(path: string): Promise<string | null>;
  writeText(path: string, text: string): Promise<void>;
  /** Move a file or directory; the destination must not exist. */
  move(from: string, to: string): Promise<void>;
  /** Remove a file or directory tree; missing is not an error. */
  remove(path: string): Promise<void>;
  ensureDir(path: string): Promise<void>;
  /** Entry names in a directory ([] when missing). */
  list(path: string): Promise<string[]>;
  /** Free bytes on the data partition, or null when unknown. */
  freeBytes(): Promise<number | null>;
}

export interface CatalogFetchResponse {
  ok: boolean;
  status: number;
  url?: string;
  redirected?: boolean;
  headers?: { get(name: string): string | null };
  text(): Promise<string>;
}

export type CatalogFetch = (url: string, init: { method: 'GET'; headers: Record<string, string>; signal?: any }) => Promise<CatalogFetchResponse>;

export interface CatalogPlatform {
  fs: CatalogFileSystem;
  fetch: CatalogFetch;
  /** Lower-case hex sha256 of the UTF-8 bytes of `text`. */
  sha256(text: string): Promise<string>;
}

// ── public shapes ──────────────────────────────────────────────────────────

export interface CatalogSnapshot {
  /** 'bundled' for the shipped catalog, else the manifest revision. */
  revision: string;
  sequence: number;
  source: 'bundled' | 'remote';
  database: any;
  seriesNames: Record<string, string>;
  /** Observation time of the data itself (database.lastUpdated). */
  dataObservedAt: string | null;
  /** Publish/build time of the remote manifest; null for the bundled catalog. */
  publishedAt: string | null;
}

export type RefreshStatus = 'updated' | 'unchanged' | 'skipped' | 'failed' | 'refused' | 'unsupported';
export interface RefreshResult { status: RefreshStatus; reason?: string; revision: string }

export interface CatalogStatus {
  revision: string;
  source: 'bundled' | 'remote';
  dataObservedAt: string | null;
  publishedAt: string | null;
  lastCheckAt: number | null;
  lastResult: RefreshStatus | null;
  lastError: string | null;
  refused: boolean;
}

export interface CatalogRepository {
  getSnapshot(): CatalogSnapshot;
  /** Resolves once the persisted revision (if any) has been restored or rejected. */
  ready(): Promise<void>;
  /** The current snapshot, after waiting (bounded) for restore. */
  loadSnapshot(): Promise<CatalogSnapshot>;
  refresh(options?: { force?: boolean }): Promise<RefreshResult>;
  getStatus(): CatalogStatus;
}

export interface CatalogRepositoryOptions {
  bundled: { database: any; seriesNames: Record<string, string> };
  platform: CatalogPlatform | null;
  /** Called once per committed revision change (restore or refresh). */
  onChange?: (snapshot: CatalogSnapshot) => void;
  now?: () => number;
  minCardCount?: number;
  timeouts?: { manifestMs?: number; assetMs?: number; restoreWaitMs?: number };
  policy?: { minCheckIntervalMs?: number; backoffBaseMs?: number; backoffMaxMs?: number; diskMarginBytes?: number };
  log?: (message: string) => void;
}

// ── persisted pointer ──────────────────────────────────────────────────────

interface PointerEntry {
  revision: string;
  sequence: number;
  /** 'bundled': the manifest named exactly the bundled bytes; no files needed. */
  kind: 'files' | 'bundled';
  dataObservedAt: string;
  publishedAt: string;
  cardCount: number;
  database: { sha256: string; bytes: number };
  seriesNames: { sha256: string; bytes: number };
}

interface Pointer { version: 1; writeSeq: number; active: PointerEntry; previous: PointerEntry | null }

// Two alternating slots instead of rename-over: a torn write leaves the other
// slot (the last committed pointer) intact, on every platform.
const POINTER_SLOTS = ['pointer-a.json', 'pointer-b.json'] as const;
const REVISIONS_DIR = 'revisions';
const STAGING_DIR = 'staging';
const DB_FILE = 'database.json';
const NAMES_FILE = 'series-names.json';

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const isHash = (v: unknown) => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const isPosInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;

function validEntry(e: unknown): e is PointerEntry {
  return isObj(e)
    && typeof e.revision === 'string' && REVISION_RE.test(e.revision)
    && isPosInt(e.sequence)
    && (e.kind === 'files' || e.kind === 'bundled')
    && typeof e.dataObservedAt === 'string' && typeof e.publishedAt === 'string'
    && isPosInt(e.cardCount)
    && isObj(e.database) && isHash(e.database.sha256) && isPosInt(e.database.bytes)
    && isObj(e.seriesNames) && isHash(e.seriesNames.sha256) && isPosInt(e.seriesNames.bytes);
}

function parsePointer(text: string | null): Pointer | null {
  if (!text) return null;
  let raw: any;
  try { raw = JSON.parse(text); } catch { return null; }
  if (!isObj(raw) || raw.version !== 1 || !isPosInt(raw.writeSeq) || !validEntry(raw.active)) return null;
  if (raw.previous !== null && !validEntry(raw.previous)) return null;
  return raw as Pointer;
}

function entryFromManifest(m: CatalogManifest, kind: PointerEntry['kind']): PointerEntry {
  return {
    revision: m.revision,
    sequence: m.sequence,
    kind,
    dataObservedAt: m.dataObservedAt,
    publishedAt: m.publishedAt,
    cardCount: m.cardCount,
    database: { sha256: m.assets.database.sha256, bytes: m.assets.database.bytes },
    seriesNames: { sha256: m.assets.seriesNames.sha256, bytes: m.assets.seriesNames.bytes },
  };
}

// ── bounded fetch ──────────────────────────────────────────────────────────

type FetchOutcome =
  | { ok: true; text: string }
  | { ok: false; kind: 'refused' | 'missing' | 'transient' | 'invalid'; reason: string };

class CatalogTimeout extends Error {}

async function fetchText(fetchImpl: CatalogFetch, url: string, timeoutMs: number, maxBytes: number): Promise<FetchOutcome> {
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => { controller?.abort(); reject(new CatalogTimeout('timeout')); }, timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl(url, {
        method: 'GET',
        headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' },
        signal: controller?.signal,
      }),
      deadline,
    ]);
    // The catalog never redirects; a response from anywhere else is not trusted.
    if (res.redirected) return { ok: false, kind: 'invalid', reason: 'redirected' };
    if (res.url && res.url !== url) {
      let same = false;
      try {
        const final = new URL(res.url);
        same = final.origin === PRODUCTION_ORIGIN && final.pathname === new URL(url).pathname;
      } catch { same = false; }
      if (!same) return { ok: false, kind: 'invalid', reason: 'redirected' };
    }
    if (res.status === 401 || res.status === 403 || res.status === 451) {
      return { ok: false, kind: 'refused', reason: `HTTP ${res.status}` };
    }
    if (res.status === 404 || res.status === 410) return { ok: false, kind: 'missing', reason: `HTTP ${res.status}` };
    if (!res.ok || res.status !== 200) return { ok: false, kind: 'transient', reason: `HTTP ${res.status}` };
    const declared = Number(res.headers?.get('content-length') ?? NaN);
    if (Number.isFinite(declared) && declared > maxBytes) return { ok: false, kind: 'invalid', reason: 'oversize' };
    const contentType = res.headers?.get('content-type') ?? '';
    if (contentType && !/json/i.test(contentType)) return { ok: false, kind: 'invalid', reason: 'not json' };
    const text = await Promise.race([res.text(), deadline]);
    if (typeof text !== 'string') return { ok: false, kind: 'invalid', reason: 'no body' };
    if (utf8ByteLength(text) > maxBytes) return { ok: false, kind: 'invalid', reason: 'oversize' };
    return { ok: true, text };
  } catch (err) {
    return { ok: false, kind: 'transient', reason: err instanceof CatalogTimeout ? 'timeout' : 'network' };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ── repository ─────────────────────────────────────────────────────────────

export function createCatalogRepository(options: CatalogRepositoryOptions): CatalogRepository {
  const { bundled, platform } = options;
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? (() => {});
  const minCardCount = options.minCardCount ?? 1000;
  const manifestMs = options.timeouts?.manifestMs ?? 8000;
  const assetMs = options.timeouts?.assetMs ?? 60000;
  const restoreWaitMs = options.timeouts?.restoreWaitMs ?? 5000;
  const minCheckIntervalMs = options.policy?.minCheckIntervalMs ?? 30 * 60 * 1000;
  const backoffBaseMs = options.policy?.backoffBaseMs ?? 2 * 60 * 1000;
  const backoffMaxMs = options.policy?.backoffMaxMs ?? 6 * 60 * 60 * 1000;
  const diskMarginBytes = options.policy?.diskMarginBytes ?? 8 * 1024 * 1024;
  const manifestUrl = `${PRODUCTION_ORIGIN}${MANIFEST_PATH}`;

  const bundledSnapshot: CatalogSnapshot = {
    revision: 'bundled',
    sequence: 0,
    source: 'bundled',
    database: bundled.database,
    seriesNames: bundled.seriesNames,
    dataObservedAt: typeof bundled.database?.lastUpdated === 'string' ? bundled.database.lastUpdated : null,
    publishedAt: null,
  };

  let current: CatalogSnapshot = bundledSnapshot;
  let pointer: Pointer | null = null;          // last committed pointer
  let olderSlotPointer: Pointer | null = null; // the other slot (kept for GC safety)
  let knownSequence = 0;                       // highest committed publish sequence
  let inflight: Promise<RefreshResult> | null = null;
  let nextAllowedAt = 0;
  let failures = 0;
  let refused = false;
  let lastCheckAt: number | null = null;
  let lastResult: RefreshStatus | null = null;
  let lastError: string | null = null;
  let bundledHashes: Promise<{ database: string; seriesNames: string }> | null = null;

  const setCurrent = (next: CatalogSnapshot) => {
    const changed = next.revision !== current.revision || next.sequence !== current.sequence;
    current = next;
    if (changed) {
      try { options.onChange?.(next); } catch (err) { log(`catalog listener failed: ${String(err)}`); }
    }
  };

  const getBundledHashes = () => {
    if (!platform) return Promise.reject(new Error('no platform'));
    if (!bundledHashes) {
      bundledHashes = Promise.all([
        platform.sha256(JSON.stringify(bundled.database)),
        platform.sha256(JSON.stringify(bundled.seriesNames)),
      ]).then(([database, seriesNames]) => ({ database, seriesNames }));
      bundledHashes.catch(() => { bundledHashes = null; });
    }
    return bundledHashes;
  };

  const revisionPath = (revision: string, file: string) => `${REVISIONS_DIR}/${revision}/${file}`;

  /** Parse + validate assets already known to match an entry's hashes. */
  const snapshotFrom = (entry: PointerEntry, dbText: string, namesText: string): CatalogSnapshot | null => {
    let db: unknown;
    let names: unknown;
    try { db = JSON.parse(dbText); names = JSON.parse(namesText); } catch { return null; }
    const dbOk = validateCatalogDatabase(db, { cardCount: entry.cardCount, dataObservedAt: entry.dataObservedAt, minCardCount });
    if (!dbOk.ok) { log(`catalog rejected: ${dbOk.reason}`); return null; }
    const namesOk = validateSeriesNames(names);
    if (!namesOk.ok) { log(`catalog rejected: ${namesOk.reason}`); return null; }
    return {
      revision: entry.revision,
      sequence: entry.sequence,
      source: 'remote',
      database: dbOk.value,
      seriesNames: namesOk.value,
      dataObservedAt: entry.dataObservedAt,
      publishedAt: entry.publishedAt,
    };
  };

  const textMatches = async (text: string | null, ref: { sha256: string; bytes: number }) => {
    if (typeof text !== 'string' || !platform) return false;
    if (utf8ByteLength(text) !== ref.bytes) return false;
    return (await platform.sha256(text)) === ref.sha256;
  };

  /** Load a persisted entry, re-verifying every byte; null when unusable. */
  const loadEntry = async (entry: PointerEntry): Promise<CatalogSnapshot | null> => {
    if (!platform) return null;
    try {
      if (entry.kind === 'bundled') {
        const h = await getBundledHashes();
        if (h.database !== entry.database.sha256 || h.seriesNames !== entry.seriesNames.sha256) return null;
        return { ...bundledSnapshot, revision: entry.revision, sequence: entry.sequence, source: 'remote', dataObservedAt: entry.dataObservedAt, publishedAt: entry.publishedAt };
      }
      const [dbText, namesText] = await Promise.all([
        platform.fs.readText(revisionPath(entry.revision, DB_FILE)),
        platform.fs.readText(revisionPath(entry.revision, NAMES_FILE)),
      ]);
      if (!(await textMatches(dbText, entry.database)) || !(await textMatches(namesText, entry.seriesNames))) return null;
      return snapshotFrom(entry, dbText as string, namesText as string);
    } catch (err) {
      log(`catalog entry unreadable: ${String(err)}`);
      return null;
    }
  };

  const readPointers = async (): Promise<Pointer[]> => {
    if (!platform) return [];
    const out: Pointer[] = [];
    for (const slot of POINTER_SLOTS) {
      let text: string | null = null;
      try { text = await platform.fs.readText(slot); } catch { text = null; }
      const p = parsePointer(text);
      if (p) out.push(p);
    }
    return out.sort((a, b) => b.writeSeq - a.writeSeq);
  };

  const writePointer = async (active: PointerEntry, previous: PointerEntry | null): Promise<void> => {
    if (!platform) return;
    const latest = pointer?.writeSeq ?? 0;
    const next: Pointer = { version: 1, writeSeq: latest + 1, active, previous };
    // Write the slot that does NOT hold the latest committed pointer.
    const slot = POINTER_SLOTS[next.writeSeq % 2];
    await platform.fs.writeText(slot, JSON.stringify(next));
    const back = parsePointer(await platform.fs.readText(slot));
    if (!back || back.writeSeq !== next.writeSeq || back.active.revision !== active.revision) {
      throw new Error('pointer readback mismatch');
    }
    olderSlotPointer = pointer;
    pointer = next;
  };

  /** Remove staging leftovers and revisions no pointer slot references. */
  const collectGarbage = async () => {
    if (!platform) return;
    const keep = new Set<string>();
    for (const p of [pointer, olderSlotPointer]) {
      if (!p) continue;
      keep.add(p.active.revision);
      if (p.previous) keep.add(p.previous.revision);
    }
    try {
      await platform.fs.remove(STAGING_DIR);
      for (const name of await platform.fs.list(REVISIONS_DIR)) {
        if (!keep.has(name)) await platform.fs.remove(`${REVISIONS_DIR}/${name}`);
      }
    } catch (err) {
      log(`catalog cleanup failed: ${String(err)}`);
    }
  };

  const restore = async (): Promise<void> => {
    if (!platform) return;
    try {
      const pointers = await readPointers();
      pointer = pointers[0] ?? null;
      olderSlotPointer = pointers[1] ?? null;
      const candidates: PointerEntry[] = [];
      for (const p of pointers) {
        candidates.push(p.active);
        if (p.previous) candidates.push(p.previous);
      }
      for (const entry of candidates) {
        const snap = await loadEntry(entry);
        if (!snap) { log(`catalog revision ${entry.revision} failed verification; falling back`); continue; }
        // An app update can ship a NEWER bundle than an old persisted download:
        // never show older observed data than the bundle while offline.
        const bundledNewer = bundledSnapshot.dataObservedAt != null
          && Date.parse(bundledSnapshot.dataObservedAt) > Date.parse(snap.dataObservedAt ?? '');
        if (!bundledNewer) setCurrent(snap);
        // Only a VERIFIED entry sets the baseline: a corrupt active must not
        // block re-downloading the same publish.
        knownSequence = entry.sequence;
        if (pointer && entry !== pointer.active) {
          // Deterministic repair: the newest usable entry becomes active.
          await writePointer(entry, null).catch((err) => log(`catalog pointer repair failed: ${String(err)}`));
        }
        break;
      }
      await collectGarbage();
    } catch (err) {
      log(`catalog restore failed: ${String(err)}`);
    }
  };

  const readyPromise: Promise<void> = restore();

  const onFailure = (kind: 'refused' | 'missing' | 'transient' | 'invalid', reason: string): RefreshResult => {
    failures += 1;
    lastError = reason;
    if (kind === 'refused') {
      refused = true; // an explicit refusal is never retried in this process
      nextAllowedAt = Number.POSITIVE_INFINITY;
      lastResult = 'refused';
      return { status: 'refused', reason, revision: current.revision };
    }
    const delay = kind === 'missing'
      ? backoffMaxMs
      : Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.min(failures - 1, 16));
    nextAllowedAt = now() + delay;
    lastResult = 'failed';
    return { status: 'failed', reason, revision: current.revision };
  };

  const onChecked = (status: 'updated' | 'unchanged'): RefreshResult => {
    failures = 0;
    lastError = null;
    lastResult = status;
    nextAllowedAt = now() + minCheckIntervalMs;
    return { status, revision: current.revision };
  };

  const stageAndVerify = async (m: CatalogManifest, dbText: string, namesText: string): Promise<void> => {
    if (!platform) throw new Error('no platform');
    const stage = `${STAGING_DIR}/${m.revision}`;
    await platform.fs.remove(stage);
    await platform.fs.ensureDir(stage);
    await platform.fs.writeText(`${stage}/${DB_FILE}`, dbText);
    await platform.fs.writeText(`${stage}/${NAMES_FILE}`, namesText);
    const [dbBack, namesBack] = await Promise.all([
      platform.fs.readText(`${stage}/${DB_FILE}`),
      platform.fs.readText(`${stage}/${NAMES_FILE}`),
    ]);
    if (!(await textMatches(dbBack, m.assets.database)) || !(await textMatches(namesBack, m.assets.seriesNames))) {
      throw new Error('staged readback mismatch');
    }
    await platform.fs.ensureDir(REVISIONS_DIR);
    await platform.fs.remove(`${REVISIONS_DIR}/${m.revision}`);
    await platform.fs.move(stage, `${REVISIONS_DIR}/${m.revision}`);
  };

  const doRefresh = async (): Promise<RefreshResult> => {
    if (!platform) return { status: 'unsupported', revision: current.revision };
    await readyPromise;
    lastCheckAt = now();

    const got = await fetchText(platform.fetch, manifestUrl, manifestMs, LIMITS.manifestBytes);
    if (!got.ok) return onFailure(got.kind, `manifest: ${got.reason}`);
    const parsed = parseCatalogManifest(got.text);
    if (!parsed.ok) return onFailure('invalid', parsed.reason);
    const m = parsed.value;
    // Out-of-order / replayed manifests never replace a newer committed revision.
    if (m.sequence <= knownSequence) return onChecked('unchanged');

    const previousEntry = pointer?.active ?? null;
    let entry: PointerEntry;
    let snap: CatalogSnapshot | null = null;

    const hashes = await getBundledHashes().catch(() => null);
    if (hashes && hashes.database === m.assets.database.sha256 && hashes.seriesNames === m.assets.seriesNames.sha256) {
      entry = entryFromManifest(m, 'bundled');
      snap = await loadEntry(entry);
    } else {
      entry = entryFromManifest(m, 'files');
      // Already on disk (e.g. an explicit rollback to the retained previous revision)?
      snap = await loadEntry(entry);
      if (!snap) {
        const free = await platform.fs.freeBytes().catch(() => null);
        const need = m.assets.database.bytes + m.assets.seriesNames.bytes;
        if (free != null && free < need * 2 + diskMarginBytes) return onFailure('transient', 'low disk space');

        const dbGot = await fetchText(platform.fetch, `${PRODUCTION_ORIGIN}${m.assets.database.path}`, assetMs, m.assets.database.bytes);
        if (!dbGot.ok) return onFailure(dbGot.kind === 'refused' ? 'refused' : 'transient', `database: ${dbGot.reason}`);
        const namesGot = await fetchText(platform.fetch, `${PRODUCTION_ORIGIN}${m.assets.seriesNames.path}`, assetMs, m.assets.seriesNames.bytes);
        if (!namesGot.ok) return onFailure(namesGot.kind === 'refused' ? 'refused' : 'transient', `series-names: ${namesGot.reason}`);
        if (!(await textMatches(dbGot.text, m.assets.database))) return onFailure('invalid', 'database: hash or size mismatch');
        if (!(await textMatches(namesGot.text, m.assets.seriesNames))) return onFailure('invalid', 'series-names: hash or size mismatch');
        snap = snapshotFrom(entry, dbGot.text, namesGot.text);
        if (!snap) return onFailure('invalid', 'catalog content rejected');
        try {
          await stageAndVerify(m, dbGot.text, namesGot.text);
        } catch (err) {
          await platform.fs.remove(`${STAGING_DIR}/${m.revision}`).catch(() => {});
          return onFailure('transient', `write failed: ${String((err as Error)?.message ?? err)}`);
        }
      }
    }
    if (!snap) return onFailure('invalid', 'catalog content rejected');
    if (m.sequence <= knownSequence) return onChecked('unchanged'); // defensive re-check

    try {
      const keepPrevious = previousEntry && previousEntry.revision !== entry.revision ? previousEntry : (pointer?.previous ?? null);
      await writePointer(entry, keepPrevious);
    } catch (err) {
      return onFailure('transient', `commit failed: ${String((err as Error)?.message ?? err)}`);
    }
    knownSequence = m.sequence;
    setCurrent(snap);
    await collectGarbage();
    return onChecked('updated');
  };

  return {
    getSnapshot: () => current,
    ready: () => readyPromise,
    async loadSnapshot() {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        readyPromise,
        new Promise<void>((resolve) => { timer = setTimeout(resolve, restoreWaitMs); }),
      ]);
      if (timer) clearTimeout(timer);
      return current;
    },
    refresh(opts = {}) {
      if (!platform) return Promise.resolve({ status: 'unsupported', revision: current.revision });
      if (refused) return Promise.resolve({ status: 'refused', reason: lastError ?? undefined, revision: current.revision });
      if (inflight) return inflight;
      if (!opts.force && now() < nextAllowedAt) return Promise.resolve({ status: 'skipped', revision: current.revision });
      inflight = doRefresh()
        .catch((err) => onFailure('transient', `unexpected: ${String((err as Error)?.message ?? err)}`))
        .finally(() => { inflight = null; });
      return inflight;
    },
    getStatus: () => ({
      revision: current.revision,
      source: current.source,
      dataObservedAt: current.dataObservedAt,
      publishedAt: current.publishedAt,
      lastCheckAt,
      lastResult,
      lastError,
      refused,
    }),
  };
}
