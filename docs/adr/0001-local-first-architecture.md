# ADR-001: Local-first architecture — no backend

## Status

Accepted

## Context

HeartMonitor processes continuous cardiac data and fires bradycardia/pause
alerts. The naive assumption is that alerts and reports require a backend
("push" notifications). That assumption is wrong, and acting on it would
introduce real costs:

- Health data is special-category data under GDPR — storing it on a
  self-hosted server creates a compliance and security burden.
- A monitoring tool must work at 03:00 with the phone in airplane mode;
  a cloud dependency is a single point of failure at exactly the wrong time.
- All inputs arrive over BLE (radio link, no internet) and all outputs are
  on-device (notifications, SQLite, PDF export).

## Decision

All computation and persistence happen on-device:

- Alerts use **local notifications** (`expo-notifications`), fired by the
  app's own evaluation loop — not push.
- The overnight monitoring loop will run as an Android foreground service
  (Phase 2), keeping the BLE link alive while the screen is off.
- History is stored in SQLite (Drizzle) and reports are generated on-device.
- Optional third-party alert delivery (e.g., Telegram bot API) is possible
  via direct HTTPS from the device — still no custom backend.

## Consequences

- Zero operating cost, zero accounts, zero attack surface on a server.
- Data stays under the user's control by construction.
- If multi-device sync or a web dashboard is ever needed, the repository
  layer is the single seam where a remote backend could be added.
