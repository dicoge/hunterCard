/**
 * Shared eas.json build-profile env resolver (DIC-1401).
 *
 * Extracted so every script/test that needs "what env does EAS profile X
 * actually resolve to" (following `extends` chains, exactly as EAS itself
 * does) reads the same logic instead of drifting copies.
 */
import fs from 'node:fs';
import path from 'node:path';

/**
 * @param {string} root repo root (directory containing eas.json)
 * @param {string} profileName
 * @returns {Record<string, string>}
 */
export function resolveEasProfileEnv(root, profileName) {
  const easJson = JSON.parse(fs.readFileSync(path.join(root, 'eas.json'), 'utf8'));
  return resolveFromJson(easJson, profileName);
}

function resolveFromJson(easJson, profileName, seen = new Set()) {
  if (seen.has(profileName)) return {};
  seen.add(profileName);
  const profile = easJson.build?.[profileName];
  if (!profile) return {};
  const inherited = profile.extends ? resolveFromJson(easJson, profile.extends, seen) : {};
  return { ...inherited, ...(profile.env || {}) };
}
