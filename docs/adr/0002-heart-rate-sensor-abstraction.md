# ADR-002: `IHeartRateSensor` abstraction over all data sources

## Status

Accepted

## Context

The app can receive heart rate from several sources with different
reliability profiles:

- **Garmin Instinct 3 broadcast mode** — already owned, BLE standard
  Heart Rate Service (0x180D), but subject to firmware quirks and an
  untested interaction with sleep mode.
- **BLE chest straps** (Polar H10, Coospo, Wahoo) — same 0x180D service,
  ECG-grade RR intervals, better during exercise and overnight.
- **Polar H10 extended data** — raw single-lead ECG via Polar's PMD
  service (Phase 4).
- **Simulated source** — needed for demos, development without hardware,
  and CI-friendly testing.

## Decision

All sources implement a single contract, `IHeartRateSensor`
(`src/sensors/types.ts`):

```ts
interface IHeartRateSensor {
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (r: HRReading) => void): () => void;
  onStateChange(listener: (s: SensorConnectionState) => void): () => void;
}
```

The domain layer (`src/domain`) consumes `HRReading` — a plain type — and
has no knowledge of BLE. A `MockHeartRateSensor` produces scripted
scenarios (normal rhythm, sustained bradycardia, dropped beats) so the
entire pipeline is exercisable without hardware.

## Consequences

- Swapping a Garmin watch for a Polar strap requires no code changes —
  they speak the same GATT protocol.
- Domain logic (bradycardia state machine, pause detector, BLE packet
  parser) is pure and unit-tested in isolation.
- The app is demoable end-to-end on any machine, including a recruiter's.
