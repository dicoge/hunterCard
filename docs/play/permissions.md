# Release manifest permission audit

Scope: the Android release artifact for `com.dicoge.holohunter` (minSdk 24, targetSdk 36).
Play surfaces every merged permission to users and cross-checks it against the Data
safety form, so each one needs a source and a functional reason.

## How this was measured

Gradle could not be run in the preparation environment (no JDK), so the merged manifest
was not re-derived from source. It was read out of the artifact instead:

```
aapt2 dump permissions <build-6.apk>
```

against EAS build `d842d312-79f5-41aa-bacf-bda080baf518` (`production-apk`, versionCode 6,
sha256 `59b3f71842a9222fcc3a262e4dee73bbd7bfe950b9ae97522f51ba15536459f4`). That is the
real merged manifest of a real release build, not a prediction of one.

Attribution came from the `AndroidManifest.xml` of each installed dependency. Permissions
with no declarer in `node_modules` are contributed by Maven AARs that Gradle resolves
during the EAS build; those are attributed from the `build.gradle` of the module that
pulls them in.

## Build 6 findings

Build 6 requested 29 permissions. Three could not be justified:

| Permission | Declared by | Verdict |
| --- | --- | --- |
| `SYSTEM_ALERT_WINDOW` | `react-native/ReactAndroid/src/debug/AndroidManifest.xml` — the debug-only dev overlay | **Remove.** No component in the build 6 manifest uses it; `DevSettingsActivity` was correctly excluded from the release build but the permission still merged. Draw-over-other-apps is high-risk on Play and this app never draws over anything. |
| `READ_EXTERNAL_STORAGE` | `expo-image-picker`, `expo-file-system` | **Remove.** The app calls only `ImagePicker.launchImageLibraryAsync` (`src/screens/ScanScreen.tsx:602`), which goes through the system photo picker. The picker module requests this permission solely from `requestMediaLibraryPermissionsAsync`, which the app never calls. |
| `WRITE_EXTERNAL_STORAGE` | `expo-image-picker`, `expo-file-system` | **Remove.** `expo-image-picker` requests it only on the pre-Android-10 `launchCameraAsync` path, which the app does not use — camera capture goes through `expo-camera`. Play flags legacy broad storage access. |

`RECORD_AUDIO` was already absent from build 6: `expo-camera` declares it, and the
existing `microphonePermission: false` plugin option plus the `blockedPermissions` entry
had already stripped it. That is the pattern the three removals above now follow.

## The fix

A permission contributed by a dependency cannot be deleted — it is merged in by Gradle.
The only removal mechanism is `expo.android.blockedPermissions`, which emits
`tools:node="remove"` into the app manifest. `app.base.json` now blocks all four.

Verified by running `npx expo prebuild --platform android` and reading the generated
`android/app/src/main/AndroidManifest.xml`:

```xml
<uses-permission android:name="android.permission.CAMERA"/>
<uses-permission android:name="android.permission.INTERNET"/>
<uses-permission android:name="android.permission.READ_EXTERNAL_STORAGE" tools:node="remove"/>
<uses-permission android:name="android.permission.RECORD_AUDIO" tools:node="remove"/>
<uses-permission android:name="android.permission.SYSTEM_ALERT_WINDOW" tools:node="remove"/>
<uses-permission android:name="android.permission.VIBRATE"/>
<uses-permission android:name="android.permission.WRITE_EXTERNAL_STORAGE" tools:node="remove"/>
```

The generated `android/` directory is not committed; it was removed after inspection.

## Retained permissions and their justification

Requested explicitly by the app:

| Permission | Runtime prompt | Feature it serves | Disclosure |
| --- | --- | --- | --- |
| `CAMERA` | Yes | Card scanning on the Scan screen (`src/screens/ScanScreen.tsx`) | In-app rationale string `允許 HoloHunter 存取相機以掃描卡牌`; Data safety declares the image upload |
| `POST_NOTIFICATIONS` | Yes (Android 13+) | Watchlist price-alert notifications | Requested at the point the user enables alerts |

Inherited, normal-level, no runtime prompt, no Play declaration required:

| Permission | Source |
| --- | --- |
| `INTERNET`, `ACCESS_NETWORK_STATE` | Card search, price data and auth all call the HTTPS API |
| `RECEIVE_BOOT_COMPLETED` | `expo-notifications` — scheduled notifications survive a reboot |
| `WAKE_LOCK`, `VIBRATE`, `com.google.android.c2dm.permission.RECEIVE`, `com.google.android.finsky.permission.BIND_GET_INSTALL_REFERRER_SERVICE` | `com.google.firebase:firebase-messaging:24.0.1`, pulled in by `expo-notifications` (`node_modules/expo-notifications/android/build.gradle:42`) |
| `READ_APP_BADGE` and the 12 launcher badge permissions (Samsung, HTC, Sony, Huawei, OPPO, Anddoes, Majeur, Everything) | `me.leolin:ShortcutBadger:1.1.22` (`node_modules/expo-notifications/android/build.gradle:44`) |
| `${applicationId}.DYNAMIC_RECEIVER_NOT_EXPORTED_PERMISSION` | `androidx.core` — a self-scoped signature permission |

The badge permissions are numerous and look alarming in a permission list, but they are
all normal-level, granted at install with no prompt, and removing them would mean
patching a transitive AAR. They are retained and attributed rather than blocked. If the
owner wants them gone, the change is to drop the notification badge capability entirely,
which is a product decision, not a manifest edit.

## Regression protection

`npm run test:play-manifest` (`scripts/test-play-release-manifest.mjs`, wired into CI)
asserts the configuration in four layers: the allowlist and blocklist in `app.base.json`;
that every permission any installed dependency declares is classified with a written
reason, so a new dependency dragging in a new permission fails rather than silently
widening the manifest; that Expo's own `Permissions` plugin emits `tools:node="remove"`
when run against a manifest seeded with every dependency-declared permission; and that
the artifact baseline and its verifier exist.

It cannot prove the merged manifest, because the Maven AARs are not present locally.
That is what `scripts/ci/play-artifact-permissions-verify.sh` is for — run it against
the built artifact before uploading:

```
scripts/ci/play-artifact-permissions-verify.sh path/to/app.aab
```

It diffs `aapt2`/`bundletool` output against `docs/play/expected-release-permissions.txt`
and fails on any unexplained addition or removal. Run against the build 6 APK it reports
exactly the three permissions removed here, which is how the baseline was confirmed to
be measuring something real.

## Still to verify on the next build

The removals are manifest-level; no runtime code path changed. Both storage permissions
were only ever requested by module code the app does not call. Still, the gallery-pick
path should be exercised once on the versionCode 7+ build — pick an image from the
library on an Android 10 or older device or emulator and confirm recognition still runs.
