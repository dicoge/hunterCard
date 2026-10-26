// DIC-1380 fail-closed resolve probe.
//
// Reads STORE_MVP + FEATURES from `src/config/releaseFlags.ts` under the
// current process env and prints a single JSON blob so the coordinator
// (test-store-mvp-fail-closed.mjs) can assert the resolution matrix without
// re-parsing TypeScript itself. The module import is intentionally the ONLY
// thing this probe does — the resolution rule lives entirely inside
// `releaseFlags.ts` and no react-native surface is needed to prove it.
//
// `releaseFlags.ts` no longer imports `react-native`, so plain
// `--experimental-strip-types` is enough to load it — no jsdom, no
// react-native-web alias hook.

const { STORE_MVP, FEATURES } = await import('../../src/config/releaseFlags.ts');

process.stdout.write(JSON.stringify({
  envRaw: process.env.EXPO_PUBLIC_STORE_MVP ?? null,
  storeMvp: STORE_MVP,
  features: { ...FEATURES },
}) + '\n');
