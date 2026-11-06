/*
 * HoloHunter remote-catalog native QA — framework-only Instrumentation (PREPARATION SOURCE, R2).
 *
 * CI-DEBUG TEST ARTIFACT ONLY. NEVER offer this APK, or the debug-signed test client it
 * targets, as an Alpha / Play / EAS release. It refuses to run unless the target is
 * com.dicoge.holohunter signed with the CI "Android Debug" certificate on an emulator.
 *
 * Phases (one per `am instrument -e phase <name>`; the controller restarts the process):
 *   online_download       genuine production manifest preflight (fixed origin, no redirects,
 *                         401/403/451 => REFUSED, no retry) -> launch the real app -> poll the
 *                         pointer + revision files THE APP ITSELF writes -> verify bytes,
 *                         sha256, card count and the new card -> public UI positive.
 *   offline_restore       real offline bound (no active network AND manifest unreachable) ->
 *                         verify persisted files against the pointer -> cold launch -> positive.
 *   corrupt_public_cache  offline -> flip one byte of the owned revision database (same size,
 *                         wrong hash) -> cold launch -> bundled Home: old series positive AND an
 *                         EXHAUSTIVE scroll of the series list without hSD20 (else LIMITATION).
 *   offline_recovery      offline -> second cold launch -> same bundled-Home assertions.
 *   online_restoration    (optional) preflight -> the app re-downloads valid files -> positive.
 *
 * R2 (review P0-C + P1): symmetric selectors (testID view id, visible text, description) with
 * the matched kind recorded; the scroller is the scrollable ANCESTOR of the known old tile;
 * scroll results are structured {found, scrolls, exhausted}; absence counts only when the
 * scroll is proven exhausted; SearchResults is anchored before matching a card name; transient
 * UiAutomation flags only (REPORT_VIEW_IDS / INCLUDE_NOT_IMPORTANT_VIEWS, no accessibility
 * permission); process identity (pid, start uptime/elapsed) reported every phase; the 7 MB
 * database is parsed at most once per phase.
 *
 * Boundaries: reads/writes ONLY <target cacheDir>/holohunter-catalog/ (public catalog cache;
 * never auth, collection, settings or other app data). Never seeds a pointer, manifest or
 * asset. No camera, scan, quota, login, account deletion or billing. JSON is data only.
 */
package com.dicoge.holohunter.catalogqa;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.Activity;
import android.app.Instrumentation;
import android.app.UiAutomation;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.net.ConnectivityManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Process;
import android.os.SystemClock;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

public final class CatalogNativeQaInstrumentation extends Instrumentation {

    // ── fixed scope (no runtime override) ─────────────────────────────────────
    static final String TARGET_PACKAGE = "com.dicoge.holohunter";
    static final String DEBUG_CERT_SHA256 = "fac61745dc0903786fb9ede62a962b399f7348f0bb6f899b8332667591033b9c";
    static final String MANIFEST_URL = "https://holohunter.dicoge.com/data/catalog/manifest.json";
    static final String ROOT_NAME = "holohunter-catalog";
    static final String[] POINTER_SLOTS = {"pointer-a.json", "pointer-b.json"};
    static final Pattern REVISION_RE = Pattern.compile("^r-[0-9a-f]{16}-[0-9a-f]{8}$");
    static final Pattern ASSET_RE = Pattern.compile("^/data/catalog/v1/(database|series-names)\\.([0-9a-f]{64})\\.json$");
    static final Pattern HEX64 = Pattern.compile("^[0-9a-f]{64}$");
    static final int MANIFEST_MAX_BYTES = 64 * 1024;
    static final int NAMES_MAX_BYTES = 512 * 1024;
    static final long DATABASE_MAX_BYTES = 32L * 1024 * 1024;

    static final String NEW_CARD_ID = "hSD20-001_hSD20_OSR_hSD20-001_OSR";
    static final String NEW_SERIES = "hSD20";
    static final String OLD_SERIES = "hBP01";
    static final String OLD_SERIES_NAME = "ブルーミングレディアンス";
    /** HomeScreen testIDs: hBP* → home-booster-<code>, hSD* → home-starter-<code>. */
    static final String NEW_SERIES_TEST_ID = "home-starter-" + NEW_SERIES;
    static final String OLD_SERIES_TEST_ID = "home-booster-" + OLD_SERIES;
    static final String SEARCH_INPUT_TEST_ID = "search-results-input";
    static final String SEARCH_TILE_TEST_ID = "search-card-tile";
    static final String[] FORBIDDEN_CARD_FIELDS = {"buyPrice", "buyPriceHistory", "priceHistory", "ytStats", "_rawPricesArchive"};

    static final Set<String> PHASES = new HashSet<>(Arrays.asList(
            "online_download", "offline_restore", "corrupt_public_cache", "offline_recovery", "online_restoration"));

    // ── bounded waits (sum < controller instrument timeout of 720 s) ──────────
    static final long DOWNLOAD_WAIT_MS = 240_000;
    static final long HOME_WAIT_MS = 90_000;
    static final long NODE_WAIT_MS = 45_000;
    static final long POLL_MS = 2_000;
    static final long SCROLL_SETTLE_MS = 700;
    static final int MAX_SCROLLS = 30;
    static final int MAX_NODES = 6000;

    private Bundle args = new Bundle();
    /** Evidence recorded by helpers, copied into the result bundle as hh_<key>. */
    private final Bundle rec = new Bundle();

    @Override
    public void onCreate(Bundle arguments) {
        super.onCreate(arguments);
        if (arguments != null) args = arguments;
        start();
    }

    @Override
    public void onStart() {
        super.onStart();
        String phase = String.valueOf(args.getString("phase", ""));
        Bundle out = new Bundle();
        out.putString("hh_schema", "2");
        out.putString("hh_phase", oneLine(phase));
        out.putString("hh_label", "CI-DEBUG-TEST-ONLY_NEVER_ALPHA_OR_PLAY");
        out.putString("hh_pid", String.valueOf(Process.myPid()));
        out.putString("hh_proc_start_uptime", String.valueOf(Process.getStartUptimeMillis()));
        out.putString("hh_proc_start_elapsed", String.valueOf(Process.getStartElapsedRealtime()));
        int code = Activity.RESULT_CANCELED;
        try {
            Outcome o = runPhase(phase);
            out.putString("hh_status", o.status);
            out.putString("hh_reason", oneLine(o.reason));
            if ("PASS".equals(o.status)) code = Activity.RESULT_OK;
        } catch (Throwable t) {
            out.putString("hh_status", "FAIL");
            out.putString("hh_reason", oneLine("exception " + t.getClass().getName() + ": " + t.getMessage()));
        }
        for (String k : rec.keySet()) out.putString("hh_" + k, oneLine(rec.getString(k)));
        finish(code, out);
    }

    // ── outcome ───────────────────────────────────────────────────────────────
    static final class Outcome {
        final String status;
        final String reason;
        Outcome(String status, String reason) { this.status = status; this.reason = reason; }
    }
    static Outcome pass(String r) { return new Outcome("PASS", r); }
    static Outcome fail(String r) { return new Outcome("FAIL", r); }
    static Outcome refused(String r) { return new Outcome("REFUSED", r); }
    static Outcome limitation(String r) { return new Outcome("LIMITATION", r); }

    void note(String key, Object value) { rec.putString(key, String.valueOf(value)); }

    static String oneLine(String s) {
        if (s == null) return "";
        String t = s.replace('\n', ' ').replace('\r', ' ');
        return t.length() > 400 ? t.substring(0, 400) : t;
    }

    // ── phases ────────────────────────────────────────────────────────────────
    Outcome runPhase(String phase) throws Exception {
        String bad = guard(phase);
        if (bad != null) return refused(bad);
        switch (phase) {
            case "online_download": return onlineDownload();
            case "offline_restore": return offlineRestore();
            case "corrupt_public_cache": return corruptPublicCache();
            case "offline_recovery": return offlineRecovery();
            case "online_restoration": return onlineRestoration();
            default: return refused("unknown phase");
        }
    }

    String guard(String phase) throws Exception {
        if (!PHASES.contains(phase)) return "unknown phase";
        Context target = getTargetContext();
        if (!TARGET_PACKAGE.equals(target.getPackageName())) return "target is not " + TARGET_PACKAGE;
        String hw = Build.HARDWARE == null ? "" : Build.HARDWARE;
        if (!hw.equals("ranchu") && !hw.equals("goldfish")) return "not an Android emulator (hardware=" + hw + ")";
        if (!DEBUG_CERT_SHA256.equals(targetSignerSha256(target))) return "target is not signed with the CI Android Debug certificate";
        return null;
    }

    static String targetSignerSha256(Context target) throws Exception {
        PackageInfo info = target.getPackageManager().getPackageInfo(TARGET_PACKAGE, PackageManager.GET_SIGNING_CERTIFICATES);
        if (info.signingInfo == null || info.signingInfo.hasMultipleSigners()) return "";
        Signature[] signers = info.signingInfo.getApkContentsSigners();
        if (signers == null || signers.length != 1) return "";
        return hex(MessageDigest.getInstance("SHA-256").digest(signers[0].toByteArray()));
    }

    Outcome onlineDownload() throws Exception {
        if (anyPointerExists()) return fail("stale state: pointer already present; requires a fresh install of the test client");
        Object pre = preflight();
        if (pre instanceof Outcome) return (Outcome) pre;
        Manifest m = (Manifest) pre;
        launchApp();
        Object committed = waitForCommittedFiles(m);
        if (committed instanceof Outcome) return (Outcome) committed;
        Outcome ui = assertNewSeriesUi((Verified) committed);
        if (ui != null) return ui;
        note("revision", m.revision);
        note("db_sha256", m.dbSha);
        note("card_count", m.cardCount);
        return pass("genuine manifest revision downloaded, verified and shown by the real UI");
    }

    Outcome offlineRestore() throws Exception {
        Outcome off = requireOffline();
        if (off != null) return off;
        JSONObject active = activeEntry();
        if (active == null) return fail("no committed pointer to restore");
        if (!"files".equals(active.optString("kind"))) return fail("active entry is not a downloaded revision");
        Verified v = verifyFilesAgainstEntry(active, true);
        if (v.reason != null) return fail("persisted revision invalid before restart: " + v.reason);
        launchApp();
        Outcome ui = assertNewSeriesUi(v);
        if (ui != null) return ui;
        note("revision", active.getString("revision"));
        return pass("offline cold start restored the persisted revision in the real UI");
    }

    Outcome corruptPublicCache() throws Exception {
        Outcome off = requireOffline();
        if (off != null) return off;
        JSONObject active = activeEntry();
        if (active == null || !"files".equals(active.optString("kind"))) return fail("no downloaded revision to corrupt");
        String rev = active.getString("revision");
        if (verifyFilesAgainstEntry(active, false).reason != null) return fail("revision already invalid before corruption");
        String seriesName = readSeriesNameIfPresent(rev);
        File db = owned("revisions/" + rev + "/database.json");
        long len = db.length();
        if (len < 2) return fail("database file unexpectedly small");
        try (RandomAccessFile raf = new RandomAccessFile(db, "rw")) {   // same size, one byte flipped
            long pos = len / 2;
            raf.seek(pos);
            int b = raf.read();
            raf.seek(pos);
            raf.write(b ^ 0x01);
        }
        if (verifyFilesAgainstEntry(active, false).reason == null) return fail("corruption did not invalidate the hash");
        launchApp();
        Outcome ui = assertBundledFallbackUi(seriesName);
        if (ui != null) return ui;
        if (verifyFilesAgainstEntry(active, false).reason == null) return fail("unexpected: corrupt file became valid without network");
        note("revision", rev);
        return pass("corrupt owned public cache rejected; bundled catalog shown, exhaustive scroll without hSD20");
    }

    Outcome offlineRecovery() throws Exception {
        Outcome off = requireOffline();
        if (off != null) return off;
        JSONObject active = activeEntry();
        String seriesName = active == null ? "" : readSeriesNameIfPresent(active.optString("revision"));
        launchApp();
        Outcome ui = assertBundledFallbackUi(seriesName);
        if (ui != null) return ui;
        return pass("second offline cold start still serves a valid bundled Home");
    }

    Outcome onlineRestoration() throws Exception {
        Object pre = preflight();
        if (pre instanceof Outcome) return (Outcome) pre;
        Manifest m = (Manifest) pre;
        launchApp();
        Object committed = waitForCommittedFiles(m);
        if (committed instanceof Outcome) return (Outcome) committed;
        Outcome ui = assertNewSeriesUi((Verified) committed);
        if (ui != null) return ui;
        note("revision", m.revision);
        return pass("online restart re-downloaded and committed a valid revision");
    }

    // ── genuine manifest preflight ────────────────────────────────────────────
    static final class Manifest {
        String revision; long sequence; int cardCount; String dataObservedAt;
        String dbPath; String dbSha; long dbBytes; String namesPath; String namesSha; long namesBytes;
    }

    /** Returns a Manifest, or an Outcome (REFUSED/FAIL) that ends the phase. Never retries. */
    Object preflight() {
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(MANIFEST_URL).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setUseCaches(false);
            c.setConnectTimeout(10_000);
            c.setReadTimeout(10_000);
            c.setRequestProperty("Accept", "application/json");
            c.setRequestProperty("Cache-Control", "no-cache");
            int status = c.getResponseCode();
            note("manifest_http", status);
            if (status == 401 || status == 403 || status == 451) return refused("manifest HTTP " + status + ": explicit refusal, not retried");
            if (status != 200) return fail("manifest HTTP " + status + " (no retry, no alternate URL)");
            String type = c.getContentType();
            if (type == null || !type.toLowerCase().contains("json")) return fail("manifest content-type is not JSON");
            byte[] body = readBounded(c.getInputStream(), MANIFEST_MAX_BYTES);
            if (body == null) return fail("manifest exceeds " + MANIFEST_MAX_BYTES + " bytes");
            return parseManifest(new String(body, StandardCharsets.UTF_8));
        } catch (IOException e) {
            return fail("manifest unreachable: " + e.getClass().getSimpleName());
        } catch (Exception e) {
            return fail("manifest invalid: " + e.getMessage());
        } finally {
            if (c != null) c.disconnect();
        }
    }

    static Object parseManifest(String text) throws Exception {
        JSONObject j = new JSONObject(text);
        if (!"holohunter-native-catalog".equals(j.optString("format"))) return fail("manifest format");
        if (j.optInt("schemaVersion", -1) != 1) return fail("manifest schemaVersion");
        if (j.optInt("minClientSchema", 99) > 1) return fail("manifest requires a newer client");
        Manifest m = new Manifest();
        m.revision = j.getString("revision");
        m.sequence = j.getLong("sequence");
        m.cardCount = j.getInt("cardCount");
        m.dataObservedAt = j.getString("dataObservedAt");
        JSONObject a = j.getJSONObject("assets");
        JSONObject db = a.getJSONObject("database");
        JSONObject names = a.getJSONObject("seriesNames");
        m.dbPath = db.getString("path"); m.dbSha = db.getString("sha256"); m.dbBytes = db.getLong("bytes");
        m.namesPath = names.getString("path"); m.namesSha = names.getString("sha256"); m.namesBytes = names.getLong("bytes");
        if (!REVISION_RE.matcher(m.revision).matches()) return fail("manifest revision shape");
        if (!HEX64.matcher(m.dbSha).matches() || !HEX64.matcher(m.namesSha).matches()) return fail("manifest sha shape");
        if (!m.dbPath.equals("/data/catalog/v1/database." + m.dbSha + ".json")) return fail("manifest database path");
        if (!m.namesPath.equals("/data/catalog/v1/series-names." + m.namesSha + ".json")) return fail("manifest series-names path");
        if (!ASSET_RE.matcher(m.dbPath).matches() || !ASSET_RE.matcher(m.namesPath).matches()) return fail("manifest asset path shape");
        if (!m.revision.equals("r-" + m.dbSha.substring(0, 16) + "-" + m.namesSha.substring(0, 8))) return fail("manifest revision/asset mismatch");
        if (m.sequence <= 0 || m.cardCount <= 0 || m.dbBytes <= 0 || m.dbBytes > DATABASE_MAX_BYTES) return fail("manifest bounds");
        return m;
    }

    /**
     * Real offline bound: the target process sees NO active network (the target app already
     * holds ACCESS_NETWORK_STATE) AND the fixed manifest URL is unreachable. Any HTTP status —
     * including 401/403/451 — means "online", never offline.
     */
    Outcome requireOffline() {
        try {
            ConnectivityManager cm = (ConnectivityManager) getTargetContext().getSystemService(Context.CONNECTIVITY_SERVICE);
            if (cm == null) return limitation("ConnectivityManager unavailable; offline cannot be observed");
            if (cm.getActiveNetwork() != null) return fail("an active network is still present (not offline)");
            note("active_network", "none");
        } catch (SecurityException e) {
            return fail("cannot observe the active network: " + e.getClass().getSimpleName());
        }
        HttpURLConnection c = null;
        try {
            c = (HttpURLConnection) new URL(MANIFEST_URL).openConnection();
            c.setInstanceFollowRedirects(false);
            c.setConnectTimeout(5_000);
            c.setReadTimeout(5_000);
            int status = c.getResponseCode();
            return fail("device is not offline (manifest answered HTTP " + status + ")");
        } catch (IOException expected) {
            note("offline_probe", "manifest unreachable");
            return null;
        } finally {
            if (c != null) c.disconnect();
        }
    }

    // ── owned public catalog cache ────────────────────────────────────────────
    File root() { return new File(getTargetContext().getCacheDir(), ROOT_NAME); }

    File owned(String rel) throws IOException {
        File r = root();
        File f = new File(r, rel);
        String prefix = r.getCanonicalPath() + File.separator;
        if (!f.getCanonicalPath().startsWith(prefix)) throw new SecurityException("path escapes the owned catalog root");
        return f;
    }

    boolean anyPointerExists() throws IOException {
        for (String s : POINTER_SLOTS) if (owned(s).exists()) return true;
        return false;
    }

    /** Highest-writeSeq valid pointer's active entry, exactly as catalogRepository.ts parses it. */
    JSONObject activeEntry() throws IOException {
        JSONObject best = null;
        long bestSeq = -1;
        for (String s : POINTER_SLOTS) {
            File f = owned(s);
            if (!f.isFile() || f.length() > MANIFEST_MAX_BYTES) continue;
            try {
                JSONObject p = new JSONObject(new String(readAll(f, MANIFEST_MAX_BYTES), StandardCharsets.UTF_8));
                if (p.optInt("version") != 1) continue;
                long seq = p.optLong("writeSeq", -1);
                JSONObject a = p.optJSONObject("active");
                if (a == null || !REVISION_RE.matcher(a.optString("revision")).matches()) continue;
                if (seq > bestSeq) { bestSeq = seq; best = a; }
            } catch (Exception ignored) { /* torn/invalid slot: the client ignores it too */ }
        }
        return best;
    }

    /** Verification result; db/names are parsed at most once and reused by the UI checks. */
    static final class Verified {
        String reason; JSONObject db; JSONObject names;
        static Verified bad(String r) { Verified v = new Verified(); v.reason = r; return v; }
    }

    Object waitForCommittedFiles(Manifest m) throws Exception {
        long deadline = SystemClock.uptimeMillis() + DOWNLOAD_WAIT_MS;
        String last = "no pointer yet";
        while (SystemClock.uptimeMillis() < deadline) {
            JSONObject a = activeEntry();
            if (a != null && m.revision.equals(a.optString("revision"))) {
                if ("bundled".equals(a.optString("kind"))) {
                    return limitation("BUNDLE_IDENTICAL: the test client bundle already equals the published catalog; this cannot prove a download (use the 91fa4c5-fixture client)");
                }
                JSONObject db = a.optJSONObject("database");
                JSONObject nm = a.optJSONObject("seriesNames");
                if (db == null || nm == null || !m.dbSha.equals(db.optString("sha256")) || !m.namesSha.equals(nm.optString("sha256"))
                        || db.optLong("bytes") != m.dbBytes || nm.optLong("bytes") != m.namesBytes || a.optInt("cardCount") != m.cardCount) {
                    return fail("pointer entry disagrees with the genuine manifest");
                }
                // Cheap checks first; parse the 7 MB database only once the hashes match.
                Verified v = verifyFiles(m.revision, m.dbSha, m.dbBytes, m.namesSha, m.namesBytes, m.cardCount, m.dataObservedAt, true);
                if (v.reason == null) return v;
                last = v.reason;
            }
            SystemClock.sleep(POLL_MS);
        }
        return fail("no verified committed download within " + (DOWNLOAD_WAIT_MS / 1000) + "s (" + last + ")");
    }

    Verified verifyFilesAgainstEntry(JSONObject a, boolean parse) throws Exception {
        JSONObject db = a.optJSONObject("database");
        JSONObject nm = a.optJSONObject("seriesNames");
        if (db == null || nm == null) return Verified.bad("pointer entry incomplete");
        return verifyFiles(a.getString("revision"), db.optString("sha256"), db.optLong("bytes"),
                nm.optString("sha256"), nm.optLong("bytes"), a.optInt("cardCount"), a.optString("dataObservedAt"), parse);
    }

    /** Bytes + sha256 always; with parse=true also card count, observation time, the new card. */
    Verified verifyFiles(String rev, String dbSha, long dbBytes, String namesSha, long namesBytes, int cardCount,
                         String observed, boolean parse) throws Exception {
        if (!REVISION_RE.matcher(rev).matches()) return Verified.bad("revision shape");
        File db = owned("revisions/" + rev + "/database.json");
        File names = owned("revisions/" + rev + "/series-names.json");
        if (!db.isFile() || !names.isFile()) return Verified.bad("revision files missing");
        if (db.length() != dbBytes) return Verified.bad("database byte count");
        if (names.length() != namesBytes) return Verified.bad("series-names byte count");
        if (!dbSha.equals(sha256(db))) return Verified.bad("database sha256");
        if (!namesSha.equals(sha256(names))) return Verified.bad("series-names sha256");
        Verified v = new Verified();
        if (!parse) return v;
        JSONObject d = new JSONObject(new String(readAll(db, DATABASE_MAX_BYTES), StandardCharsets.UTF_8));
        JSONObject cards = d.getJSONObject("cards");
        if (cards.length() != cardCount) return Verified.bad("card count " + cards.length() + " != " + cardCount);
        if (!observed.equals(d.optString("lastUpdated"))) return Verified.bad("observation time mismatch");
        JSONObject nc = cards.optJSONObject(NEW_CARD_ID);
        if (nc == null || !NEW_SERIES.equals(nc.optString("series"))) return Verified.bad("genuine new card " + NEW_CARD_ID + " missing");
        for (String f : FORBIDDEN_CARD_FIELDS) if (nc.has(f)) return Verified.bad("forbidden field " + f + " present");
        JSONObject n = new JSONObject(new String(readAll(names, NAMES_MAX_BYTES), StandardCharsets.UTF_8));
        if (n.optString(NEW_SERIES, "").isEmpty()) return Verified.bad("series name for " + NEW_SERIES + " missing");
        v.db = d;
        v.names = n;
        return v;
    }

    /** The new series' display name from the (still intact) names file, or "" if unreadable. */
    String readSeriesNameIfPresent(String rev) {
        try {
            if (!REVISION_RE.matcher(rev).matches()) return "";
            JSONObject n = new JSONObject(new String(readAll(owned("revisions/" + rev + "/series-names.json"), NAMES_MAX_BYTES), StandardCharsets.UTF_8));
            return n.optString(NEW_SERIES, "");
        } catch (Exception e) {
            return "";
        }
    }

    // ── real app + public UI ──────────────────────────────────────────────────
    void launchApp() {
        configureUiAutomation();
        Intent i = getTargetContext().getPackageManager().getLaunchIntentForPackage(TARGET_PACKAGE);
        if (i == null) throw new IllegalStateException("no launch intent for " + TARGET_PACKAGE);
        i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TASK);
        startActivitySync(i);
        waitForIdleSync();
    }

    /** Transient flags on this instrumentation's own UiAutomation session only. */
    void configureUiAutomation() {
        UiAutomation ui = getUiAutomation();
        AccessibilityServiceInfo info = ui.getServiceInfo();
        if (info == null) { note("ui_flags", "unavailable"); return; }
        info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS;
        ui.setServiceInfo(info);
        note("ui_flags", "REPORT_VIEW_IDS|INCLUDE_NOT_IMPORTANT_VIEWS (transient)");
    }

    /** Symmetric selector: testID-backed view id OR exact visible text OR exact description. */
    static final class Selector {
        final String label; final Set<String> testIds; final Set<String> texts; final Set<String> descs;
        Selector(String label, Set<String> testIds, Set<String> texts, Set<String> descs) {
            this.label = label; this.testIds = testIds; this.texts = texts; this.descs = descs;
        }
        /** "testId" / "text" / "desc", or null. */
        String match(AccessibilityNodeInfo n) {
            String id = n.getViewIdResourceName();
            if (id != null) for (String t : testIds) if (id.equals(t) || id.endsWith("/" + t)) return "testId";
            CharSequence tx = n.getText();
            if (tx != null && texts.contains(tx.toString().trim())) return "text";
            CharSequence d = n.getContentDescription();
            if (d != null && descs.contains(d.toString().trim())) return "desc";
            return null;
        }
    }

    static Set<String> setOf(String... v) {
        Set<String> s = new HashSet<>();
        for (String x : v) if (x != null && !x.trim().isEmpty()) s.add(x.trim());
        return s;
    }

    Selector newSeriesSelector(String seriesName) {
        return new Selector("new-series", setOf(NEW_SERIES_TEST_ID), setOf(NEW_SERIES), setOf(seriesName));
    }

    Selector oldSeriesSelector() {
        return new Selector("old-series", setOf(OLD_SERIES_TEST_ID), setOf(OLD_SERIES), setOf(OLD_SERIES_NAME));
    }

    List<AccessibilityNodeInfo> nodes() {
        List<AccessibilityNodeInfo> out = new ArrayList<>();
        AccessibilityNodeInfo root = getUiAutomation().getRootInActiveWindow();
        if (root == null) return out;
        ArrayDeque<AccessibilityNodeInfo> q = new ArrayDeque<>();
        q.add(root);
        while (!q.isEmpty() && out.size() < MAX_NODES) {
            AccessibilityNodeInfo n = q.poll();
            if (n == null) continue;
            out.add(n);
            for (int i = 0; i < n.getChildCount(); i++) q.add(n.getChild(i));
        }
        return out;
    }

    static final class Hit { AccessibilityNodeInfo node; String by; }

    Hit find(Selector s) {
        for (AccessibilityNodeInfo n : nodes()) {
            String by = s.match(n);
            if (by != null) { Hit h = new Hit(); h.node = n; h.by = by; return h; }
        }
        return null;
    }

    Hit waitFor(Selector s, long timeoutMs) {
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            Hit h = find(s);
            if (h != null) return h;
            SystemClock.sleep(500);
        }
        return null;
    }

    /** Structured scroll result (review P0-C). */
    static final class ScrollResult {
        boolean found; String by = ""; int scrolls; boolean exhausted; boolean scrollerFound;
        AccessibilityNodeInfo node;
        String summary() { return "found=" + found + " by=" + by + " scrolls=" + scrolls + " exhausted=" + exhausted + " scroller=" + scrollerFound; }
    }

    /** Nearest scrollable ancestor of the known old-series tile: the real Home series list. */
    static AccessibilityNodeInfo scrollableAncestor(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo c = n == null ? null : n.getParent();
        for (int depth = 0; c != null && depth < 24; depth++) {
            if (c.isScrollable()) return c;
            c = c.getParent();
        }
        return null;
    }

    /**
     * From the top of a freshly launched Home, scroll the old tile's scrollable ancestor forward
     * until `target` is found or a scroll returns false AFTER at least one successful scroll
     * (exhausted). No scroller, a first scroll that fails, a stale scroller or hitting
     * MAX_SCROLLS all leave exhausted=false — never proof of absence.
     */
    ScrollResult scrollSearch(AccessibilityNodeInfo anchorTile, Selector target) {
        ScrollResult r = new ScrollResult();
        AccessibilityNodeInfo scroller = scrollableAncestor(anchorTile);
        r.scrollerFound = scroller != null;
        for (int i = 0; i <= MAX_SCROLLS; i++) {
            Hit h = find(target);
            if (h != null) { r.found = true; r.by = h.by; r.node = h.node; return r; }
            if (scroller == null || !scroller.refresh()) return r;
            if (!scroller.performAction(AccessibilityNodeInfo.ACTION_SCROLL_FORWARD)) {
                r.exhausted = r.scrolls >= 1;
                if (r.exhausted) {   // last page: one final look before concluding absence
                    Hit last = find(target);
                    if (last != null) { r.found = true; r.by = last.by; r.node = last.node; r.exhausted = false; }
                }
                return r;
            }
            r.scrolls++;
            SystemClock.sleep(SCROLL_SETTLE_MS);
        }
        return r;
    }

    /**
     * SearchResults anchor: the search input's testID view id, or an EDITABLE field whose text is
     * the query. Home's own "hSD20" tile text is not editable, so it can never satisfy this.
     */
    Hit waitForSearchAnchor(long timeoutMs) {
        Selector byId = new Selector("search-input", setOf(SEARCH_INPUT_TEST_ID), setOf(), setOf());
        long deadline = SystemClock.uptimeMillis() + timeoutMs;
        while (SystemClock.uptimeMillis() < deadline) {
            for (AccessibilityNodeInfo n : nodes()) {
                if (byId.match(n) != null) { Hit h = new Hit(); h.node = n; h.by = "testId"; return h; }
                CharSequence cls = n.getClassName();
                CharSequence tx = n.getText();
                if (n.isEditable() && cls != null && cls.toString().contains("EditText")
                        && tx != null && NEW_SERIES.equals(tx.toString().trim())) {
                    Hit h = new Hit(); h.node = n; h.by = "editableQueryText"; return h;
                }
            }
            SystemClock.sleep(500);
        }
        return null;
    }

    boolean click(AccessibilityNodeInfo n) {
        AccessibilityNodeInfo c = n;
        for (int depth = 0; c != null && depth < 8; depth++) {
            if (c.isClickable()) return c.performAction(AccessibilityNodeInfo.ACTION_CLICK);
            c = c.getParent();
        }
        return false;
    }

    /** Home must be populated: the known old series is present (never a blank catalog). */
    Hit homeAnchor() {
        Hit old = waitFor(oldSeriesSelector(), HOME_WAIT_MS);
        if (old != null) note("old_series_by", old.by);
        return old;
    }

    /** Positive public-UI evidence for the genuinely downloaded new series and its cards. */
    Outcome assertNewSeriesUi(Verified v) throws Exception {
        if (v.db == null || v.names == null) return fail("internal: verified data not parsed");
        Hit old = homeAnchor();
        if (old == null) return fail("Home did not show the known series " + OLD_SERIES + " (blank or not loaded)");
        ScrollResult sr = scrollSearch(old.node, newSeriesSelector(v.names.optString(NEW_SERIES, "")));
        note("new_series_scroll", sr.summary());
        note("new_series_found_after_scrolls", sr.found ? String.valueOf(sr.scrolls) : "not-found");
        if (!sr.found) {
            return sr.scrollerFound
                    ? fail("hSD20 not found on Home after " + sr.scrolls + " scrolls (exhausted=" + sr.exhausted + ")")
                    : limitation("no scrollable ancestor of the hBP01 tile; Home series list not scannable on this build");
        }
        if (!click(sr.node)) return fail("hSD20 tile not clickable");
        // Anchor SearchResults before matching any card name.
        Hit input = waitForSearchAnchor(NODE_WAIT_MS);
        if (input == null) return limitation("SearchResults screen not identifiable (input testID / editable query text not exposed)");
        note("search_anchor_by", input.by);
        JSONObject nc = v.db.getJSONObject("cards").getJSONObject(NEW_CARD_ID);
        JSONObject zh = nc.optJSONObject("skillsZh");
        JSONObject jp = nc.optJSONObject("skillsJp");
        Set<String> names = setOf(nc.optString("name", null), nc.optString("nameZh", null), nc.optString("yuyuName", null),
                zh == null ? null : zh.optString("name", null), jp == null ? null : jp.optString("name", null));
        if (names.isEmpty()) return limitation("new card has no display-name candidate in the downloaded data");
        Hit tile = waitFor(new Selector("new-card-tile", setOf(), names, names), NODE_WAIT_MS);
        if (tile == null) return fail("SearchResults for " + NEW_SERIES + " showed no tile named like " + NEW_CARD_ID);
        note("new_card_by", tile.by);
        return null;
    }

    /** Bundled fallback: old series present AND a proven-exhaustive scroll without the new series. */
    Outcome assertBundledFallbackUi(String seriesName) {
        Hit old = homeAnchor();
        if (old == null) return fail("Home did not show the known series " + OLD_SERIES + " (blank or not loaded)");
        ScrollResult sr = scrollSearch(old.node, newSeriesSelector(seriesName));
        note("absence_scroll", sr.summary());
        note("absence_scrolls", sr.scrolls);
        if (sr.found) return fail("hSD20 still shown (matched by " + sr.by + ") although the downloaded revision is corrupt");
        if (!sr.exhausted) return limitation("absence of hSD20 not provable: scroll not exhausted (" + sr.summary() + ")");
        return null;
    }

    // ── io helpers ────────────────────────────────────────────────────────────
    static byte[] readBounded(InputStream in, int max) throws IOException {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buf = new byte[8192];
        int total = 0;
        try (InputStream s = in) {
            int r;
            while ((r = s.read(buf)) != -1) {
                total += r;
                if (total > max) return null;
                out.write(buf, 0, r);
            }
        }
        return out.toByteArray();
    }

    static byte[] readAll(File f, long max) throws IOException {
        if (f.length() > max) throw new IOException("file exceeds bound");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] b = readBounded(in, (int) max);
            if (b == null) throw new IOException("file exceeds bound");
            return b;
        }
    }

    static String sha256(File f) throws Exception {
        MessageDigest md = MessageDigest.getInstance("SHA-256");
        try (FileInputStream in = new FileInputStream(f)) {
            byte[] buf = new byte[65536];
            int r;
            while ((r = in.read(buf)) != -1) md.update(buf, 0, r);
        }
        return hex(md.digest());
    }

    static String hex(byte[] b) {
        StringBuilder sb = new StringBuilder(b.length * 2);
        for (byte x : b) sb.append(String.format("%02x", x & 0xff));
        return sb.toString();
    }
}
