/**
 * Which scanner pipeline this bundle runs. Metro resolves `scanRuntime.native.ts` for the
 * iOS / Android bundles and this file for web (and for the Node regressions), the same
 * platform-extension split src/stores/storage uses. A build-time constant rather than a
 * `typeof document` probe, so a DOM polyfill can never flip native into the web path.
 */
export const SCAN_RUNTIME: 'web' | 'native' = 'web';
