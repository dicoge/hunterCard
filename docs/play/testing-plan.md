# Play testing plan

Two tracks with different purposes. Keep them separate — conflating them is what makes
the 14-day requirement slip.

- **Internal testing** is the team's own QA loop. Up to 100 testers, available within
  minutes of upload, no Play review. Use it to catch what would waste a closed tester's
  time.
- **Closed testing** is the track that can unlock Production access. It is reviewed, and
  for accounts subject to the personal-developer rules it carries a hard 12-tester,
  14-day, continuous-opt-in requirement.

## Does the 12/14 requirement apply?

It applies to **personal developer accounts created on or after 13 November 2023**. Such
accounts must run a closed test with **at least 12 testers who have opted in and stayed
opted in continuously for 14 days** before Production access can be requested. Organisation
accounts and older personal accounts are exempt.

> **OWNER — answer this before planning dates.** Play Console → Setup → Developer account:
> is the account type Personal or Organisation, and what is its creation date? Everything
> below changes depending on the answer. Internal testing does **not** count toward the
> 14 days no matter what — only the closed test does.

## Stage 1 — Internal testing (before any closed tester is invited)

Upload the versionCode 7+ AAB to Internal testing and work through this list. Every item
is either a known risk from this submission work or a path the store review will touch.

| # | Check | Why it is here |
| --- | --- | --- |
| 1 | Fresh install, cold launch, no crash | Baseline |
| 2 | Guest path: tap 以訪客身份進入, browse sets, search, open a card detail | Exactly what a reviewer following the App access instructions will do. After DIC-1256 the card detail must show **no** price or market data, and the drawer no 收藏／入手提醒 |
| 3 | Google sign-in with the review test account | If this fails for the reviewer, the release is rejected |
| 4 | Scan with the camera, confirm a card is recognised | Recognition on native runs on-device; confirm it still resolves a card after the DIC-1245 API-origin change |
| 5 | **Pick an image from the gallery and confirm recognition runs** | Directly exercises the `READ_EXTERNAL_STORAGE` / `WRITE_EXTERNAL_STORAGE` removal. Test on an Android 10 or older device or emulator, where the legacy storage path would have mattered |
| 6 | Confirm **no** notification prompt ever appears | Push registration is gated on `FEATURES.pushAlerts` (`!STORE_MVP`), so the review build must never ask. A prompt appearing means the store profile lost `EXPO_PUBLIC_STORE_MVP=1`, which would also make the Data safety answers wrong |
| 7 | Settings → 刪除帳號, confirm the account is deleted and the app signs out | Play's data-deletion answer depends on this working |
| 8 | Confirm no draw-over-other-apps prompt ever appears | `SYSTEM_ALERT_WINDOW` was removed |
| 9 | App info → Permissions lists Camera only; Notifications is absent because `POST_NOTIFICATIONS` is blocked for the store-mvp profile at the manifest layer (DIC-1259) | The user-visible result of the permission work. The review build cannot use notifications — no runtime prompt reaches the user |
| 10 | Deck editor, tournament report and rules tutorial all open; 收藏 and 入手提醒 are gone and their deep links fail closed | Every feature named in the store listing must exist, and every removed one must be unreachable rather than merely hidden (DIC-1256 item 2) |
| 11 | `scripts/ci/play-artifact-permissions-verify.sh --profile store-mvp <aab>` passes | Mechanical proof the merged manifest matches the store-mvp baseline (the profile Play sees) |

Do not invite closed testers until 1–11 pass. A closed tester who hits a crash on day 3
may drop out, and the 14-day clock is only satisfied by testers who stay opted in.

## Stage 2 — Closed testing

### Tester recruitment

**OWNER — blocking.** Needed before the track can start:

- **At least 12 Gmail / Google account addresses**, ideally 14–15 to absorb dropouts.
  Recruit more than the minimum: one person who leaves the group on day 10 resets nothing
  for the others, but drops the count below 12 and can invalidate the window.
- Either a plain email list or a **Google Group** — a Group is easier to manage and lets
  you add a replacement without editing the track.
- Real people who will actually install. Play looks at whether testers engaged, not just
  whether addresses were listed.

Every tester must **opt in through the tester URL and keep the app installed and opted
in for the full 14 days**. Leaving the programme and rejoining restarts their clock.

### Running the track

1. Create the Closed testing track and add the tester list or Google Group.
2. Upload the same AAB that passed Internal testing, add the release notes from
   `store-listing.md`, and roll out.
3. Send every tester the opt-in URL from the track page, with instructions to accept the
   invitation and install from Play — not by sideloading an APK, which does not register
   as participation.
4. Confirm each tester actually opted in. Chase the ones who did not on day 1, not day 12.
5. Record the date the twelfth tester opted in. **That is when the 14-day clock starts**,
   not the day you created the track.
6. Collect feedback throughout. Play asks what you learned and what you changed; an empty
   answer weakens the Production access application.

### Feedback evidence to keep

Play's Production access questionnaire asks how the closed test was run and what came out
of it. Keep, in writing:

- How testers were recruited and roughly who they are.
- What testers were asked to exercise (the Stage 1 list is a good basis).
- The feedback received, even if it is "no problems found" — with names or dates.
- What changed as a result, or a clear statement that nothing needed to change and why.
- Any releases pushed to the closed track during the window.

### Production access application

After the 14 continuous days with 12+ opted-in testers, apply in Play Console. Expect to
describe the app, the target audience, how the test was run, the feedback, and readiness
for production. Review takes time and can come back with questions — treat the 14 days as
a floor, not the schedule.

## What must not happen

- **Do not roll out to the Production track** to get around any of this. The issue scope
  forbids it, and a production release cannot be quietly withdrawn.
- Do not swap the app signing key mid-test. Once Play App Signing is enrolled the upload
  key is fixed; a mismatch rejects the upload.
- Do not let the versionCode go backwards or repeat. EAS `autoIncrement` with
  `appVersionSource: "remote"` handles this, but confirm each upload lands above the last.
- Do not change the package name. `com.dicoge.holohunter` is immutable once the Play app
  record exists.
