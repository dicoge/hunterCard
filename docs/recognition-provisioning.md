# Production recognition provisioning (DIC-P0 hBP09)

## The incident this page exists for

On 2026-09-24 every physical hBP09 scan against canonical Production
(`https://holohunter.dicoge.com/`) failed. `POST /api/recognize-card` answered

```json
{"success":false,"code":"RECOGNITION_UNAVAILABLE","error":"辨識服務暫時無法使用，請稍後再試或改用手動搜尋"}
```

with HTTP 503 for official 400×559 images of hBP09-008, hBP09-050 and
hBP09-111, while Production `data/database.json` carried all 244 hBP09 rows
(hBP09-001 … hBP09-111). The catalog was fine; the deployment had no
`GEMINI_API_KEY`.

DIC-1185 (`58386d5f0`) removed the OpenRouter fallback and made recognition
fail closed to Google direct only — correct as a FinOps repair — but no
deploy-time gate required the Google key to actually be provisioned, so
Production shipped with a scanner that could not recognise anything.

## Operator requirement

`GEMINI_API_KEY` MUST be set as a Vercel **Production** environment variable
on project `holocard-hunter` before a Production deploy can complete.

- The handler reads it at request time (`api/recognize-card.ts`,
  `resolveAdapters()`); an empty or missing value makes every recognition
  request answer 503 `RECOGNITION_UNAVAILABLE`.
- The key travels in the `x-goog-api-key` header, never in a URL (DIC-1019),
  and must never be committed, logged, or written into shared knowledge.
- OpenRouter remains a hard denylist (DIC-1185). Do not "fix" an
  unprovisioned deployment by adding any other provider.

## The deploy-time gate

`.github/workflows/holohunter-exact-sha-deploy.yml` ends with
**Require Production recognition to be provisioned (DIC-P0 hBP09)**:

1. It POSTs a probe to `https://holohunter.dicoge.com/api/recognize-card`
   AFTER the canonical alias is proven bound to the run's deployment, so it
   grades what users now actually receive.
2. The probe body comes from
   `scripts/ci/verify-recognition-availability.mjs --emit-probe-body`: one
   valid 64×89 PNG, deliberately below the handler's 320px legibility floor.
   Because the handler checks the provider BEFORE the floor (DIC-1013
   ordering), a provisioned deployment answers the photo-level 404 without
   spending a vision call, and an unprovisioned one answers the exact 503
   above. The probe is free either way.
3. The same committed module decides the outcome (exit 0 provisioned /
   2 retry / 1 fatal), and the workflow fails closed: an unprovisioned
   Production is a FAILED deploy, not a green one.

Boundary: the gate proves a vision adapter RESOLVES (the 503 class of this
incident is impossible). It deliberately does not spend a metered vision call
to validate the key value; an invalid key surfaces as the 502 family, which
the client already reports as an infrastructure failure rather than a bad
photo.

## Regression corpus

`npm run test:hbp09-recognition-corpus` pins, against the committed catalog
and the REAL handler:

- catalog readiness: every number hBP09-001 … hBP09-111 present;
- deterministic ranking: for every distinct hBP09 number, an exact vision
  transcription ranks that card first (`cardNumber exact`);
- transcription tolerance: official-format variants normalise to the same
  number;
- the incident trio end-to-end: hBP09-008 / hBP09-050 / hBP09-111 are
  recognised through the real handler when provisioned, and answer the exact
  incident 503 payload when not.

`npm run test:recognition-availability-validator` executes the probe decision
module against fixtures and against the real handler, including the
zero-vision-call property of the probe.
