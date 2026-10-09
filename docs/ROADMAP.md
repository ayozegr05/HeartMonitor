# HeartMonitor — Milestones & Roadmap

Working document for the project. Each milestone lists scope, status, key
technical decisions, and known pitfalls discovered during implementation.
The app is **observational, not diagnostic** — no medical claims anywhere.

---

## M1 — Core monitoring platform ✅

**Status:** done (merged to `main`).

- `IHeartRateSensor` abstraction (ADR-002): `BleHeartRateSensor`,
  `MockHeartRateSensor`, future `PolarH10Sensor` share the same pipeline.
- Standard BLE Heart Rate Service (`0x180D`) + measurement (`0x2A37`).
  Parser already extracts **RR intervals** when the sensor sends them
  (bit 4 of the flags byte) — Garmin broadcast doesn't, Polar H10 does.
- Context-aware thresholds: day (stricter) vs night (23:00–07:00,
  relaxed-but-supervised). Sustained-duration filter before alerting.
- Pause detection from RR intervals (ratio of consecutive RRs ≥ 1.8×).
- SQLite + Drizzle persistence: sessions, readings (~1 Hz), alert events.
  Survivable across crashes; open sessions are closed/reassigned on boot.
- Session & weekly reports (domain-pure, tested).

## M2 — Reliability, alerts & device-survival ✅

**Status:** done — validated on a Vivo/Funtouch device.

- Foreground service via `react-native-background-actions`
  (`connectedDevice` type) — Android requires a persistent notification.
- **Infinite reconnect** with exponential backoff (5 s → cap 120 s) while
  a session is active. Never give up — the user is notified instead.
- **Stale-data watchdog**: a link can stay `streaming` while the sensor
  stops broadcasting (classic Instinct failure mode). If no reading
  arrives for 2 min → `⌚ Reloj sin datos` alert. Watchdog is armed on
  every transition to `streaming`, not only on readings — reconnects
  that come back silent used to slip through.
- Three alert notifications (channel `heart-alerts-v2`, importance MAX):
  cardiac event · watch disconnected · watch silent + 07:00 night report.
- Notification pitfalls found on real hardware:
  - `sound: 'default'` in a channel config is treated as a custom
    resource filename → broken sound URI → silent alerts. **Omit `sound`.**
  - Android restores settings of deleted channels with the same ID →
    **bump the channel ID** when recreating (`heart-alerts-v2`).
  - The persistent foreground notification posts **once** and is never
    updated — updating it on each reading made Funtouch play the
    channel sound in a loop. BPM is not displayed there.
- Bluetooth-disabled UX: adapter state surfaced before scan/reconnect.
- SAF backup flow: pick folder once → export saves directly, import lists
  folder contents inside the app. Import dedup reports
  "N new (M already existed)".
- Health Connect: write sync at session end + app open, restore flow for
  fresh installs. Historical only — never used for real-time alerts.
- Android Auto Backup (config plugin `withAndroidAutoBackup`).

## M3 — Visualization & UX sprint ✅

**Status:** done (merged `dde53aa`).

- `src/domain/hrChart.ts`: pure bucketing — min/avg/max per slice,
  threshold zones, event→bucket mapping, trend detection. 9 tests.
- `src/components/hr-chart.tsx`: pure-`View` chart — no native deps,
  **no EAS rebuild needed**. Bars per bucket, threshold line, event ⚠️.
- Monitor: BPM colored by active-threshold zone, trend arrow,
  live sparkline (rolling 120-reading window), session min/max/duration.
- Reports: MÍN/MEDIA/MÁX stat blocks, coverage %, lazy chart via
  `getSessionReadingBuckets` (SQL-aggregated, ~120 rows instead of ~30k),
  expandable event list. Weekly card gets the same blocks.
- Settings: sectioned cards (thresholds / Health Connect / backup /
  night reliability).

## M4 — Polar H10 🔜 (next)

**Status:** hardware arriving; parser can be written before it arrives.

### Why it matters

The H10 sends **real RR intervals** in the standard HR measurement —
pause detection becomes real, HRV (RMSSD) becomes computable. This is
the sensor that makes the observational data trustworthy.

### ECG via PMD — no subscription, no Polar SDK

**PMD (Polar Measurement Data)** is a second BLE service on the device
itself — not a cloud service, no account, no payment. It streams:

- **ECG**: ~130 Hz, samples delta-encoded in proprietary frames.
- ACC, gyro, PPI (available, not needed initially).

Plan: implement the PMD control-point handshake + frame parser in pure
TypeScript (`src/sensors/polar/`). `react-native-ble-plx` is already in
the dev build → **no native module, no EAS rebuild**. The Polar official
SDK is rejected: heavier dependency, maintenance burden, less
educational for the portfolio.

### Sub-deliverables

1. **RR validation** — pair as a standard sensor, verify real RRs land,
   confirm pause detection and RMSSD behave on real data.
2. **PMD protocol parser** — start/stop stream via control point, decode
   delta-encoded ECG frames. Unit tests with sample frames.
3. **Live ECG screen** — hospital-style scrolling strip (~5–8 s window,
   25 mm/s equivalent, gain control, BPM overlay). Entry point: button
   from Monitor, not a default view — ECG is an on-demand mode.
4. **Strip capture** — save 30–60 s segments to file; attach to the
   cardiologist PDF.
5. **Overnight Holter mode** — continuous ECG to a raw file
   (~7 MB / 8 h — file, not SQLite rows). Phone must be charging and in
   BLE range. Gaps on disconnect are recorded, not hidden.
6. **True 24h Holter** — stretch goal. Constraint is BLE range, not
   data volume. H10 has internal memory and *may* support on-strap
   recording + later download (verify against firmware/PMD docs); if
   supported that is the cleanest solution, otherwise gap-fill mode.
7. **Night HRV** — RMSSD per night in reports, trend over the week.

### Sensor role split (important for the pitch)

- **RR continuous** = the sentinel — detects every dropped beat of an AV
  block all night at trivial battery cost.
- **ECG strips/Holter** = the evidence — visual proof for the
  cardiologist, on demand.

## M5 — Caregiver notifications (Telegram)

- Bot API direct from the device — still no backend.
- Config: bot token + chat_id in Settings (never committed).
- Alert fan-out: cardiac event + connection-lost to a caregiver chat.
- Optional morning summary message.

## M6 — Portfolio polish

- Onboarding flow (first-run: pair sensor → set thresholds → battery
  exemption → test alert).
- CSV export alongside JSON backup.
- Monitoring-night streak / adherence stats.
- README: screenshots, demo GIF, "featured" polish.
- ECG screenshot in README once M4 lands.

---

## Open risks

| Risk | Mitigation |
|---|---|
| Funtouch/Vivo kills foreground service overnight | Battery exemption, autostart, coverage % makes kills visible in reports |
| BLE drops during long ECG streams | Gap-aware strip files; watchdog alerts |
| PMD frame format drift across firmware | Versioned parser, tests with captured frames |
| `getAllReadings` memory growth | Bucketed SQL already added; paginate exports if needed |
| Dev-client needs rebuild for new native deps | M4 chosen specifically to avoid any |

## Verification gate (applies to every milestone)

```bash
npx tsc --noEmit
npx expo lint
npx jest
```

Git identity for all commits (see `AGENTS.md`):
`Ayoze Gómez Rosa <130746651+ayozegr05@users.noreply.github.com>`
