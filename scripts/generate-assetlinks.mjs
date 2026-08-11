/**
 * generate-assetlinks.mjs — emit dist/.well-known/assetlinks.json (DIC-960 / CR DIC-961).
 *
 * Android verifies an `autoVerify` HTTPS App Link by fetching
 * https://<host>/.well-known/assetlinks.json and checking that it delegates URL
 * handling to the installed app's package + signing-cert SHA-256 fingerprint.
 * Only then is the Apple return App Link app-exclusive; without it the link opens
 * in the browser instead of being intercepted by another app.
 *
 * FAIL-CLOSED by construction: the signing-cert fingerprint is owner-only and is
 * NEVER committed. It is read from env (ANDROID_APP_LINK_SHA256, comma-separated
 * to allow the upload key + Play App Signing key). When it is unset — or every
 * value is malformed — we emit an EMPTY array `[]`: a valid, well-formed
 * assetlinks that delegates to NO app, so App Link verification fails and Android
 * Apple stays disabled. We never invent a fingerprint.
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// The App Link delegation target is the product's own package and is NOT
// operator-configurable: an env override would let anyone with build access
// delegate the HoloHunter host to an attacker package (CR DIC-961). It is
// hard-coded so the ownership artifact can only ever name HoloHunter.
const PRODUCT_PACKAGE = 'com.dicoge.holohunter';

// A SHA-256 cert fingerprint is 32 hex byte-pairs joined by colons, e.g.
// "14:6D:E9:83:C5:...". Accept upper/lowercase, normalise to uppercase, and drop
// anything that isn't exactly that shape (fail-closed — a malformed fingerprint
// would silently break verification).
function normalizeFingerprint(raw) {
  const trimmed = String(raw ?? '').trim().toUpperCase();
  if (!/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/.test(trimmed)) return null;
  return trimmed;
}

export function buildAssetLinks(env = process.env) {
  const fingerprints = (env.ANDROID_APP_LINK_SHA256 || '')
    .split(',')
    .map(normalizeFingerprint)
    .filter(Boolean);
  // Deduplicate while preserving order.
  const unique = [...new Set(fingerprints)];
  if (unique.length === 0) return [];
  return [
    {
      relation: ['delegate_permission/common.handle_all_urls'],
      target: {
        namespace: 'android_app',
        package_name: PRODUCT_PACKAGE,
        sha256_cert_fingerprints: unique,
      },
    },
  ];
}

export function writeAssetLinks(distDir = path.resolve(process.cwd(), 'dist'), env = process.env) {
  const statements = buildAssetLinks(env);
  const outDir = path.join(distDir, '.well-known');
  const outFile = path.join(outDir, 'assetlinks.json');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(statements, null, 2) + '\n', 'utf-8');
  const count = statements.length === 0 ? 0 : statements[0].target.sha256_cert_fingerprints.length;
  console.log(
    count === 0
      ? '[assetlinks] No valid ANDROID_APP_LINK_SHA256 — wrote fail-closed empty assetlinks.json (Android App Link stays unverified).'
      : `[assetlinks] Wrote assetlinks.json delegating ${count} fingerprint(s) to ${
          buildAssetLinks(env)[0].target.package_name
        }.`,
  );
  return outFile;
}

// Only write when run directly (node scripts/generate-assetlinks.mjs); importing
// the pure builders in tests must have no side effects.
const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  writeAssetLinks();
}
