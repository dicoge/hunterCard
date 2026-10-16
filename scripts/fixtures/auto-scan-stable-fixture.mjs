// autoScanService stand-in: every frame is a stable card, so the web auto-scan loop
// fires whenever it is allowed to (scripts/test-scan-v39-web-autoscan.mjs).
export function analyzeFrameWithStability() { return { isStable: true, confidence: 0.99, hasCard: true }; }
export function resetAutoScan() {}
