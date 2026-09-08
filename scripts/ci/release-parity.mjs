#!/usr/bin/env node
/**
 * Release-parity SHA contract (DIC-1401).
 *
 * The rule this enforces: "手機正式版與 Web Production 的功能進度必須相同" can
 * only be claimed true when Web Production's deployed commit SHA and the
 * mobile production (AAB/APK) build's source commit SHA are IDENTICAL. This
 * module never infers or assumes a match — every unresolved input reports
 * `unknown`, and the caller (CI workflow) must never print/claim "synced"
 * for anything other than an exact, non-empty SHA match.
 *
 * `evaluateShaParity` is pure (no I/O) so it is unit-testable without a real
 * deployment. `fetchWebSha` / `main` do the actual network + CLI wiring and
 * are exercised by the `release-parity-check.yml` workflow, not by the fast
 * unit test.
 */

/**
 * @param {string | null | undefined} webSha
 * @param {string | null | undefined} mobileSha
 * @returns {{ status: 'synced' | 'not-synced' | 'unknown', reason: string, webSha: string|null, mobileSha: string|null }}
 */
export function evaluateShaParity(webSha, mobileSha) {
  const web = normalizeSha(webSha);
  const mobile = normalizeSha(mobileSha);

  if (!web || !mobile) {
    return {
      status: 'unknown',
      reason: !web && !mobile
        ? 'both web and mobile source SHA are missing/unresolvable'
        : !web
          ? 'web deployment SHA is missing/unresolvable'
          : 'mobile build source SHA is missing/unresolvable',
      webSha: web,
      mobileSha: mobile,
    };
  }

  if (web === mobile) {
    return {
      status: 'synced',
      reason: `web and mobile both report ${web}`,
      webSha: web,
      mobileSha: mobile,
    };
  }

  return {
    status: 'not-synced',
    reason: `web=${web} mobile=${mobile} differ`,
    webSha: web,
    mobileSha: mobile,
  };
}

function normalizeSha(sha) {
  if (typeof sha !== 'string') return null;
  const trimmed = sha.trim().toLowerCase();
  // A real git commit SHA is 40 hex chars (or a 7+ char abbreviation). Reject
  // anything else (empty string, "unknown", "null", garbage) rather than
  // silently comparing junk and reporting a false "synced".
  if (!/^[0-9a-f]{7,40}$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Fetches `${webUrl}/api/version` and extracts the deployed SHA.
 * Never throws on network/parse failure — returns null so the caller reports
 * `unknown`, not a crash mistaken for "synced".
 * @param {string} webUrl
 */
export async function fetchWebSha(webUrl) {
  try {
    const res = await fetch(`${webUrl.replace(/\/$/, '')}/api/version`, {
      // Evidence must be live, never a cached/stale answer.
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = await res.json();
    return typeof body?.sha === 'string' ? body.sha : null;
  } catch {
    return null;
  }
}

// --------------------------------------------------------------- CLI entry

async function main() {
  const webUrl = process.env.RELEASE_PARITY_WEB_URL || 'https://holohunter.dicoge.com';
  const mobileSha = process.env.RELEASE_PARITY_MOBILE_SHA || '';

  const webSha = await fetchWebSha(webUrl);
  const result = evaluateShaParity(webSha, mobileSha);

  console.log(`web_url=${webUrl}`);
  console.log(`web_sha=${result.webSha ?? '<unresolved>'}`);
  console.log(`mobile_sha=${result.mobileSha ?? '<unresolved>'}`);
  console.log(`PARITY_STATUS=${result.status}`);
  console.log(`PARITY_REASON=${result.reason}`);

  // Fail-closed CLI: only an explicit 'synced' is a success exit. Both
  // 'not-synced' and 'unknown' must be visible failures — this script backs
  // a promotion gate, and a promotion gate that exits 0 on "unknown" is
  // exactly the "claims parity without evidence" bug this contract exists to
  // prevent.
  if (result.status !== 'synced') {
    process.exitCode = 1;
  }
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main();
}
