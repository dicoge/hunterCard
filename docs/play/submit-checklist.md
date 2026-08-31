# Play Console submit checklist

Run top to bottom. Nothing here can be done by an agent without the owner's Play Console
session — the account-level steps in part A are the gate on everything else.

## A. Account prerequisites — OWNER ONLY

None of these can be completed or verified from this repo. All of them block the first
upload.

- [ ] Google Play Developer account active, registration fee paid.
- [ ] **Identity verification complete** (personal accounts: government ID; organisation
      accounts: D-U-N-S number and organisation verification). Play blocks publishing
      until this clears, and it can take days.
- [ ] Developer account **account type and creation date** recorded — this decides whether
      the 12-tester / 14-day closed testing requirement applies. See `testing-plan.md`.
- [ ] Public **developer name**, and the contact email, website and physical address that
      Play displays on the store listing.
- [ ] Payments profile — required even for a free app if you ever intend to monetise.
      Not required to ship a free app with no billing, which is this app's current state.
- [ ] 2-Step Verification enabled on the developer Google account.
- [ ] Play Console app record created with package name `com.dicoge.holohunter`.
      **This is irreversible** — the package name cannot be changed afterwards.
- [ ] Play App Signing enrolment decision made. Use EAS-managed release signing with Play
      App Signing; do not generate a second keystore.

## B. Build the artifact

Blocked until DIC-1245 (PR #162) merges to `main`. Building from anything else reships the
old API origin that got build 6 rejected.

- [ ] PR #162 merged to `main`.
- [ ] Branch is `main` at the merge commit; working tree clean.
- [ ] `npm ci`
- [ ] `npm run test:play-manifest` passes.
- [ ] `npm run test:privacy-disclosure` passes.
- [ ] Build: `npx eas build --platform android --profile production`
      — `eas.json` resolves this to `buildType: app-bundle`, `distribution: store`,
      `credentialsSource: remote`, `autoIncrement: true`.
- [ ] Confirm the build finished and produced a `.aab`.

Remote versionCode was **6** at the time of writing (`eas build:version:get --platform
android`), so `autoIncrement` yields **7** on the next production build — the minimum the
issue requires.

## C. Verify the artifact before uploading

Static verification, all runnable locally:

- [ ] `scripts/ci/play-artifact-permissions-verify.sh --profile store-mvp path/to/app.aab`
      passes. Requires `bundletool` for an `.aab` (`brew install bundletool`). The Play AAB
      is the store-mvp profile; the same script accepts `--profile full` for internal APKs.
- [ ] Package name is `com.dicoge.holohunter`.
- [ ] versionCode ≥ 7, versionName `1.0.0`.
- [ ] targetSdk 36, minSdk 24.
- [ ] Signed with the EAS-managed **release** key, not a debug key.
- [ ] No occurrence of the old `holocard-hunter.vercel.app` origin on any executable path
      — this is DIC-1245's acceptance criterion; use the regression gate that ships with
      that PR.
- [ ] API base points at `holohunter.dicoge.com`.

Record and keep: the AAB SHA-256, and the signer certificate SHA-256.

## D. App content declarations

Answers in `app-content.md`. Complete every section — Play will not let you roll out with
any of them outstanding.

- [ ] Privacy policy URL set and publicly reachable.
- [ ] Ads: No.
- [ ] App access: restricted, with reviewer instructions **and working test credentials**.
- [ ] Content rating questionnaire submitted, IARC rating issued.
- [ ] Target audience: 13+, not appealing to children, not opted into Families.
- [ ] News app: No. Financial features: No. Government app: No. Health: No.
- [ ] Advertising ID: not used.
- [ ] Data deletion: in-app path plus contact email declared.
- [ ] Data safety form completed from `data-safety.md`. Photos = not collected (recognition
      runs on-device); the one answer needing an owner decision is whether the Expo Push
      Service transfer counts as service-provider processing.

## E. Store listing

Copy and assets in `store-listing.md`; graphics in `store-listing/`.

- [ ] App name, short description, full description.
- [ ] 512×512 icon, 1024×500 feature graphic, at least two phone screenshots.
- [ ] Category, contact email, website.
- [ ] Countries and regions selected.

## F. Release to Closed testing

- [ ] Closed testing track created; tester list or Google Group attached.
- [ ] AAB uploaded, release notes added.
- [ ] Reviewed and rolled out **to Closed testing only**.
- [ ] Opt-in URL distributed; every tester confirmed opted in.
- [ ] Date the twelfth tester opted in recorded — the 14-day clock starts there.

**Do not roll out to Production.** Out of scope, and not reversible in the way a closed
track is.

## Automated submission — currently not possible

`eas.json` has a `submit` section pointing at `./google-service-account.json`, which does
not exist in this repo and must never be committed. Automated submission additionally
requires the Play Console app record to already exist and the account prerequisites in
part A to be complete, so **the first submission has to be manual regardless**.

To enable `eas submit` later: create a service account in Google Cloud for the Play
Console project, grant it release permissions in Play Console → Users and permissions,
download the JSON key, store it as an EAS secret rather than a file in the repo, and point
`serviceAccountKeyPath` or the equivalent secret at it. Also correct the `submit.production`
Android `track`, which currently reads `internal`.

The iOS `submit.production` block still contains placeholder values
(`YOUR_APPLE_ID@example.com`, `YOUR_ASC_APP_ID`, `YOUR_APPLE_TEAM_ID`). Out of scope here;
noted so it is not mistaken for a working configuration.

## Honest status

At the time of writing, **nothing has been submitted to Google Play**. No Play Console
session, no owner credentials, no verified developer identity and no service account key
were available, and the release artifact cannot be built until PR #162 merges. Everything
in parts A and F requires the owner. Treat this document as the runbook, not as a record
of work already done.
