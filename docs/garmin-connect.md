# Garmin Connect direct client (private API)

## Why this exists

Garmin **never writes** HRV/SpO2/respiration into Health Connect — its
Android manifest doesn't even declare `WRITE_HEART_RATE_VARIABILITY`,
`WRITE_OXYGEN_SATURATION` or `WRITE_RESPIRATORY_RATE` (verified via
`dumpsys healthconnect` + aapt on 2026-10-13). Health Sync can bridge
some of it but its Garmin connector was failing on the test device and
doesn't offer an HRV toggle for Garmin→HC anyway.

So the app talks to Garmin's cloud directly — the same private Connect
API the official app uses — and merges those vitals into the sleep
reports next to the Health Connect data.

## Architecture

`src/features/garmin/`:

- **`oauth1.ts`** — pure-TS SHA-1 + HMAC-SHA1 + OAuth 1.0a signer
  (Hermes ships no crypto). Verified in tests against RFC 2202 vectors
  and the RFC 5849 reference signature.
- **`garminClient.ts`** — auth flow mirroring the official app:
  `sso.garmin.com/sso/embed` (seeds session cookie) → `/sso/signin`
  page (`_csrf` field) → credentials POST → `ticket=` →
  `connectapi.garmin.com/oauth-service/oauth/preauthorized` (OAuth1
  signed) → `exchange/user/2.0` → OAuth2 Bearer.
  - **The password is never stored** — only oauth1+oauth2 tokens in
    AsyncStorage key `garminConnect.tokens.v1`.
  - Expired OAuth2 is re-exchanged from the long-lived OAuth1 token.
  - `GarminAuthError.code`: `credentials | mfa | locked | network | reauth`.
  - Relies on React Native fetch persisting cookies across requests
    (OkHttp cookie jar on Android) — verified working on device.
- **`garminApi.ts`** — endpoint readers with defensive parsers (the API
  is private, every extractor scans several candidate keys):
  - `/hrv-service/hrv/daily/{start}/{end}` — overnight HRV range
  - `/userstats-service/wellness/daily/{user}?fromDate&untilDate` —
    resting HR + steps
  - `/wellness-service/wellness/daily/spo2/{date}` — avg + lowest SpO2
  - `/wellness-service/wellness/daily/respiration/{date}` — sleep resp.
  - `/wellness-service/wellness/dailySleepData/{user}?date=` — rich
    sleep record (stages, overnight HRV, SpO2, respiration bundled)
  - `fetchGarminApiDays(days)` merges all of the above into
    `Partial<GarminDayPoint>` per day; per-day vitals calls are capped
    at 7 days, sleep detail at 3, to bound request count.

**Merge point**: `readGarminSeries` in
`src/features/healthconnect/garminSummary.ts` — Health Connect reads run
first, then API values overwrite per-day fields (`source` becomes
`'cuenta Garmin'`). Works even when HC is unavailable. Auth errors are
swallowed there (HC data still shows); the Settings test button surfaces
them instead.

**UI**: `GarminAccountCard` in `src/app/settings.tsx` (email+password
once, link/test/unlink) + source label on the `GarminCard` in
`reports.tsx`.

## Verified on device (2026-10-13, Vivo V2514)

- Login end-to-end: `Conectado como <displayName> ✓`.
- `fetchGarminApiDays(7)` → "Lectura OK — 7 días con datos".
- Sueño tab shows `vía cuenta Garmin Connect`: FC reposo 44, resp 13.0,
  FC día 41–74, sleep night with real stages, and the **VFC banda vs
  reloj** comparison chart now renders the watch bars.

## Known gaps / TODO

- **MFA accounts can't log in** — detected and surfaced as a `mfa`
  error. Supporting it would need an input field for the emailed code
  mid-flow.
- Garmin may return `dailySleepDTO` shapes that differ per device —
  parsers are tolerant but real-world payloads should be spot-checked
  (e.g. `hrvSummary` wrappers).
- The OAuth consumer key comes from `thegarth.s3.amazonaws.com` (the
  same public consumer the OSS ecosystem extracts from the official
  app). If that S3 object dies, login breaks → could vendor it.
- `nul` file / Windows junk keeps appearing in `git status` — add to
  `.gitignore` if it comes back.

## Deploy / ops notes

- Updates are OTA via EAS: **`npx eas-cli update --channel preview
  --environment preview --platform android -m "..."`** — the installed
  preview APK listens on channel `preview`, runtime `1.0.0`
  (`appVersion` policy). The update downloads in background and applies
  on next launch.
  - `--platform android` is **required**: the web export fails on
    `expo-sqlite`'s missing `wa-sqlite.wasm`.
- `eas` auth is non-interactive via **`EXPO_TOKEN`** env var (user
  access token from expo.dev). Should live in Devin Cloud secrets as
  `EXPO_TOKEN` — pending `devin auth login` on the local CLI.
- Nothing native was added — pure JS/TS (AsyncStorage was already a
  dependency), so OTA is safe for this feature.
- Debug trick that worked: `adb shell uiautomator dump` + pull +
  `grep text=` to read screens when `screencap` fails on secure flags;
  unlock needs the user's PIN/face.
