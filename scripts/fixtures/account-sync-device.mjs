/**
 * One simulated phone for scripts/test-account-sync-two-device.mjs (v41). A separate
 * Node process = its own copy of every store, the REAL account-sync binding and
 * orchestrator, persisted to its own file (DEVICE_STORE) so a restart is real. Its
 * fetch goes to the local test server (SYNC_PORT); `offline` makes it fail like a
 * phone without network. Driven over IPC; never touches a real account or network.
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

const PORT = process.env.SYNC_PORT;
let offline = false;
let inflight = 0;
let lastActivity = Date.now();
const requests = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (input, init = {}) => {
  const url = String(input);
  if (!url.includes('/api/auth/')) throw new Error(`device made an unexpected request: ${url}`);
  if (url.includes('/api/auth/sync')) requests.push({ method: init.method ?? 'GET', at: Date.now(), body: init.body ? JSON.parse(init.body) : null });
  if (offline) throw new TypeError('Network request failed');
  inflight += 1; lastActivity = Date.now();
  try {
    return await realFetch(url.replace(/^https?:\/\/[^/]+/, `http://127.0.0.1:${PORT}`), init);
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
const { FEATURES } = await import('../../src/config/releaseFlags.ts');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
for (const s of [useAuthStore, useDeckStore, useSettingsStore, useScanSessionStore, useAccountSyncStateStore, useFavoritesStore]) {
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
      scans: scans.cards.map((c) => ({ instanceId: c.instanceId, cardNumber: c.cardNumber, selectedVersion: c.selectedVersion, versionConfident: c.versionConfident, sellPrice: c.sellPrice })),
      language: useSettingsStore.getState().preferredLanguage,
      quotaRemaining: useScanQuotaStore.getState().getRemaining(),
      sync: { ownerId: sync.ownerId, dirty: sync.dirtySeq !== sync.ackedSeq, lastRevision: sync.lastRevision },
      requests: requests.map((r) => r.method),
      pushedFields: [...new Set(requests.filter((r) => r.body?.patch).flatMap((r) => Object.keys(r.body.patch)))].sort(),
      storeMvp: !FEATURES.favorites,
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
