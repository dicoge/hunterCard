# Release-parity evidence contract (DIC-1401)

This directory backs the "手機正式版與 Web Production 的功能進度必須相同"
(mobile Production and Web Production must be at parity) rule with checked
evidence instead of a claim.

## SHA parity (`scripts/ci/release-parity.mjs`)

- `api/version.ts` is deployed on every Web build (Production and staging)
  and reports the exact commit SHA (`VERCEL_GIT_COMMIT_SHA`) currently
  serving that deployment.
- `scripts/ci/release-parity.mjs` compares that SHA against a mobile
  production build's source SHA (from EAS build provenance) and reports one
  of three statuses — never guessed:
  - `synced` — both SHAs resolved and are byte-identical.
  - `not-synced` — both SHAs resolved but differ.
  - `unknown` — either SHA could not be resolved. Treated as a FAILURE by
    the CLI (non-zero exit), never silently treated as "close enough".
- Wired as a manual workflow (`.github/workflows/release-parity-check.yml`)
  so it can be run on demand against the real Production URL and a specific
  EAS build's source SHA — it makes no network assumption at CI/PR time and
  is not required to run on push.

## Flag parity (`flags.json` + `scripts/test-release-flags-parity.mjs`)

- `flags.json` is the single source of truth for every release flag that is
  *intended* to be identical between Web Production and mobile Production.
- Each entry's `parity` must be either:
  - `"synced"` — the test asserts `mobileProductionEasValue` (read live from
    `eas.json`) literally equals `webProductionVercelValue`. Any drift fails
    CI.
  - `"documented-exception"` — the flag is currently NOT the same across
    lanes, by a recorded product decision. `reason`, `trackingIssue`, and
    `followUp` must all be non-empty. The test still pins the current
    mobile-side value (via `eas.json`) so any FUTURE undocumented change is
    caught, but does not claim the flag is currently synced.
- This is deliberately conservative: DIC-1401 is CI/CD-and-branch scope only
  and must not silently change product feature behaviour to force a flag
  into sync. Where a real mismatch exists today (`EXPO_PUBLIC_STORE_MVP`,
  see the entry in `flags.json`), it stays visible here until a product
  owner decides which side moves.
