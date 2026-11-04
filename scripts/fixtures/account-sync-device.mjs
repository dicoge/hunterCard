/**
 * One simulated phone for scripts/test-account-sync-two-device.mjs (v41). A separate
 * Node process = its own copy of every store, the REAL account-sync binding and
 * orchestrator, persisted to its own file (DEVICE_STORE) so a restart is real. Its
 * fetch goes to the local test server (SYNC_PORT); `offline` makes it fail like a
 * phone without network; `hold` parks the next sync GET/POST in flight until
 * `release` (CR 2026-10-17 race regressions). Driven over IPC; never touches a real
 * account or network.
 */
import { register } from 'node:module';
import { JSDOM } from 'jsdom';

const STORAGE = new URL('./file-backed-storage.mjs', import.meta.url).href;
register('data:text/javascript,' + encodeURIComponent(`
  export async function resolve(specifier, context, next) {
    if ((specifier === '../stores/storage' || specifier === './storage') && /\\/src\\/(store|stores)\\//.test(context.parentURL || '')) {
      return { url: ${JSON.stringify(STORAGE)}, shortCircuit: true };
    }
    return next(specifier, context);
  }
`), import.meta.url);

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'https://holohunter.dicoge.com/', pretendToBeVisual: true });
globalThis.window = dom.window;
globalThis.document = dom.window.document;
for (const key of Object.getOwnPropertyNames(dom.window)) {
  if (key in globalThis) continue;
  try { globalThis[key] = dom.window[key]; } catch {}
}
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });
let visibility = 'visible';
Object.defineProperty(dom.window.document, 'visibilityState', { get: () => visibility, configurable: true });

// This phone's clock offset (CR b16d7ab: a device clock running ahead). Everything in
// the app that reads the time (Date.now(), new Date()) sees it; the server does not.
const RealDate = Date;
let clockSkewMs = 0;
class DeviceDate extends RealDate {
  constructor(...args) { if (args.length === 0) super(RealDate.now() + clockSkewMs); else super(...args); }
  static now() { return RealDate.now() + clockSkewMs; }
}
globalThis.Date = DeviceDate;

const PORT = process.env.SYNC_PORT;
let offline = false;
let inflight = 0;
let lastActivity = Date.now();
const requests = [];
const holds = [];     // { method, gate, release, held }
// 2026-11-04 (F1 lost-ACK repro): the next sync request with this method really
// reaches the server (and is committed there), but its response is dropped and the
// phone sees a network failure — a lost ACK. One-shot.
const loseResponse = new Set();
let lostResponses = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/api/auth/')) throw new Error(`device made an unexpected request: ${url}`);
  const method = init.method ?? 'GET';
  if (url.includes('/api/auth/sync')) {
    const auth = init.headers?.Authorization ?? init.headers?.authorization ?? '';
    requests.push({ method, at: Date.now(), bearer: auth.replace(/^Bearer /, ''), body: init.body ? JSON.parse(init.body) : null });
    const hold = holds.find((h) => h.method === method && !h.held);
    if (hold) { hold.held = true; await hold.gate; }
  }
  if (offline) throw new TypeError('Network request failed');
  inflight += 1; lastActivity = Date.now();
  try {
    const res = await realFetch(url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${PORT}`), init);
    if (url.includes('/api/auth/sync') && loseResponse.delete(method)) {
      await res.text();               // the server has fully processed (and committed) it
      lostResponses += 1;
      throw new TypeError('Network request failed (response lost)');
    }
    return res;
  } finally { inflight -= 1; lastActivity = Date.now(); }
};

const { installAccountSyncBinding } = await import('../../src/services/accountSyncBinding.ts');
const { useAuthStore } = await import('../../src/store/authStore.ts');
const { useDeckStore } = await import('../../src/store/deckStore.ts');
const { useSettingsStore } = await import('../../src/store/settingsStore.ts');
const { useScanSessionStore } = await import('../../src/stores/scanSessionStore.ts');
const { useFavoritesStore } = await import('../../src/store/favoritesStore.ts');
const { useAccountSyncStateStore } = await import('../../src/store/accountSyncStateStore.ts');
const { useScanQuotaStore } = await import('../../src/store/scanQuotaStore.ts');
const { useAccountSyncOutboxStore } = await import('../../src/store/accountSyncOutboxStore.ts');
const { FEATURES } = await import('../../src/config/releaseFlags.ts');
const { reconcileAccountSync, hydrateAccountSyncFromServer, pushAccountSyncFromStores } = await import('../../src/services/accountSyncOrchestrator.ts');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const s of [useAuthStore, useDeckStore, useSettingsStore, useScanSessionStore, useAccountSyncStateStore, useFavoritesStore, useAccountSyncOutboxStore]) {
  await s.persist?.rehydrate?.();
}
installAccountSyncBinding();

const commands = {
  async login({ session, user }) {
    useAuthStore.setState({ session, user, isAuthenticated: true, isGuest: false, role: 'free_user' });
  },
  async logout() {
    useAuthStore.setState({ session: null, user: null, isAuthenticated: false, isGuest: true, role: 'guest' });
  },
  async deleteAccount() {
    await useAuthStore.getState().deleteUserAccount();
  },
  async own({ cardNumber, version, qty }) { useDeckStore.getState().setOwned(cardNumber, version, qty); },
  async scan({ card }) { useScanSessionStore.getState().addCard(card, { force: true }); },
  async pickVersion({ index, version }) {
    const c = useScanSessionStore.getState().cards[index];
    useScanSessionStore.getState().setCardVersion(c.instanceId, version);
  },
  async removeScan({ index }) {
    const c = useScanSessionStore.getState().cards[index];
    useScanSessionStore.getState().removeCard(c.instanceId);
  },
  async clearScans() { useScanSessionStore.getState().clearSession(); },
  async setLanguage({ lang }) { useSettingsStore.getState().setLanguage(lang); },
  async favorite({ cardNumber }) {
    useFavoritesStore.getState().addFavorite?.({ cardNumber, printing: 'BASE', addedAt: new Date().toISOString() });
  },
  async offline({ value }) { offline = value; },
  async clock({ skewMs }) { clockSkewMs = skewMs; },
  /** The next sync request with this method waits (in flight) until `release`. */
  async hold({ method }) {
    let release;
    const gate = new Promise((r) => { release = r; });
    holds.push({ method, gate, release, held: false });
  },
  async waitHeld({ method, maxMs = 5000 }) {
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      if (holds.some((h) => h.method === method && h.held)) return true;
      await wait(10);
    }
    throw new Error(`no ${method} reached the hold`);
  },
  async release({ method }) {
    const i = holds.findIndex((h) => h.method === method);
    if (i >= 0) { holds[i].release(); holds.splice(i, 1); }
  },
  /** What the binding runs on foreground (unthrottled here): pull, or push if pending. */
  async resync() {
    const st = useAuthStore.getState();
    void reconcileAccountSync(st.session, st.user?.internalId ?? null, null).catch(() => {});
  },
  async wait({ ms }) { await wait(ms); },
  /** 2026-11-04: the next sync request with `method` is committed but its response is lost. */
  async loseNextResponse({ method }) { loseResponse.add(method); },
  /** 2026-11-04: the REAL exported hydrate / push entry points, called directly. */
  async hydrate() {
    try { return { ok: !!(await hydrateAccountSyncFromServer(useAuthStore.getState().session)) }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  },
  async push() {
    try { return { ok: !!(await pushAccountSyncFromStores(useAuthStore.getState().session)) }; }
    catch (err) { return { ok: false, error: String(err?.message || err) }; }
  },
  /** 2026-11-04: sync bookkeeping the F1 repro asserts on (read-only). */
  async syncMeta() {
    const s = useAccountSyncStateStore.getState();
    const p = s.pendingAck;
    return { dirtySeq: s.dirtySeq, ackedSeq: s.ackedSeq, lastRevision: s.lastRevision,
      scanPicks: s.baseline?.scanPicks ?? null, lostResponses,
      // 2026-11-04 recovery: the persisted lost-ACK record (summary) and every sync POST
      // this phone sent: its bearer, idempotency key, base revision and scan picks.
      pendingAck: p ? { ownerId: p.ownerId, idempotencyKey: p.idempotencyKey, baseRevision: p.baseRevision,
        attempts: p.attempts, createdAt: p.createdAt, seqAtPush: p.seqAtPush } : null,
      postLog: requests.filter((r) => r.method === 'POST' && r.body).map((r) => ({
        bearer: r.bearer, idempotencyKey: r.body.idempotencyKey, baseRevision: r.body.baseRevision,
        scans: (r.body.patch?.scanSession?.entries ?? []).map((e) => ({ instanceId: e.instanceId, selectedVersion: e.selectedVersion })),
        collection: r.body.patch?.collection ?? null,
      })) };
  },
  /** 2026-11-04: test-only — age or exhaust the persisted lost-ACK record (bounded-retry cases). */
  async agePendingAck({ createdAt, attempts }) {
    const s = useAccountSyncStateStore.getState();
    if (!s.pendingAck) return false;
    s.setPendingAck({ ...s.pendingAck, ...(createdAt ? { createdAt } : {}), ...(attempts != null ? { attempts } : {}) });
    return true;
  },
  async createDeck({ name }) { return useDeckStore.getState().createDeck(name); },
  async deleteDeck({ id }) { useDeckStore.getState().deleteDeck(id); },
  async foreground() {
    visibility = 'hidden'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
    visibility = 'visible'; dom.window.document.dispatchEvent(new dom.window.Event('visibilitychange'));
  },
  async settle({ quietMs = 1100, maxMs = 15000 } = {}) {
    const t0 = Date.now();
    await wait(50);
    while (Date.now() - t0 < maxMs) {
      if (inflight === 0 && Date.now() - lastActivity >= quietMs) break;
      await wait(50);
    }
  },
  async state() {
    const scans = useScanSessionStore.getState();
    const sync = useAccountSyncStateStore.getState();
    return {
      collection: useDeckStore.getState().collection,
      decks: useDeckStore.getState().decks.map((d) => d.id),
      scans: scans.cards.map((c) => ({ instanceId: c.instanceId, cardNumber: c.cardNumber, selectedVersion: c.selectedVersion, versionConfident: c.versionConfident, selectedAt: c.selectedAt ?? null, sellPrice: c.sellPrice })),
      language: useSettingsStore.getState().preferredLanguage,
      quotaRemaining: useScanQuotaStore.getState().getRemaining(),
      sync: { ownerId: sync.ownerId, dirty: sync.dirtySeq !== sync.ackedSeq, lastRevision: sync.lastRevision },
      requests: requests.map((r) => r.method),
      posts: requests.filter((r) => r.body?.patch).map((r) => ({ bearer: r.bearer, collection: r.body.patch.collection ?? null })),
      pushedFields: [...new Set(requests.filter((r) => r.body?.patch).flatMap((r) => Object.keys(r.body.patch)))].sort(),
      storeMvp: !FEATURES.favorites,
      parkedOwners: useAccountSyncOutboxStore.getState().owners(),
    };
  },
};

process.on('message', async ({ id, cmd, args }) => {
  try {
    lastActivity = Date.now();
    const result = await commands[cmd](args ?? {});
    process.send({ id, ok: true, result });
  } catch (err) {
    process.send({ id, ok: false, error: String(err?.stack || err) });
  }
});
process.send({ ready: true });
