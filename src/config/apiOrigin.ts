// Canonical production origin for the HoloHunter backend (DIC-1245).
//
// Native executable code (iOS / Android bundle, cron scripts running against
// production KV) MUST resolve the API to this origin — never the old
// holocard-hunter.vercel.app alias. Web still resolves API calls against its
// own window.location.origin, but the fallback used when there is no origin
// (SSR, native, cron) is this canonical host.
//
// Pure module — no react-native / expo / node imports — so it can be shared by
// the app bundle, the Vercel edge handler, and Node scripts, and stays
// unit-testable.
//
// If the operator ever needs to move production off holohunter.dicoge.com, this
// is the single place to change; the regression gate in
// scripts/test-native-bundle-origin.mjs then fails any executable path that
// still hardcodes the old vercel.app alias.
export const PRODUCTION_ORIGIN = 'https://holohunter.dicoge.com';
