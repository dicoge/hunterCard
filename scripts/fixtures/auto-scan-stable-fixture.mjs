// autoScanService stand-in: every frame is a stable card unless the test sets
// globalThis.__frameStable = false (the card is being moved), so the web auto-scan loop
// fires whenever it is allowed to (scripts/test-scan-v39-web-autoscan.mjs).
export function analyzeFrameWithStability() {
  const stable = globalThis.__frameStable !== false;
  return { isStable: stable, confidence: stable ? 0.99 : 0.2, hasCard: true };
}
export function resetAutoScan() {}
