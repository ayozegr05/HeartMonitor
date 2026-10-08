import { BradycardiaDetector, detectBradycardiaEvents } from '../bradycardia';
import { activeLowThreshold, isNightTime } from '../thresholds';
import { DEFAULT_THRESHOLDS, type HRReading } from '../models';

const reading = (bpm: number, timestamp: number): HRReading => ({
  bpm,
  rrIntervalsMs: [],
  timestamp,
});

describe('BradycardiaDetector', () => {
  const detector = () => new BradycardiaDetector(30_000);

  it('does not alert on a brief dip below the threshold', () => {
    const d = detector();
    expect(d.evaluate(reading(60, 0), 45)).toBeNull();
    expect(d.evaluate(reading(40, 5_000), 45)).toBeNull();
    expect(d.evaluate(reading(40, 10_000), 45)).toBeNull();
    expect(d.evaluate(reading(60, 15_000), 45)).toBeNull();
  });

  it('alerts once the HR stays below threshold for the sustained window', () => {
    const d = detector();
    d.evaluate(reading(40, 0), 45);
    d.evaluate(reading(38, 15_000), 45);
    const event = d.evaluate(reading(39, 30_000), 45);

    expect(event).not.toBeNull();
    expect(event?.type).toBe('bradycardia');
    expect(event?.bpm).toBe(38); // lowest observed BPM is reported
    expect(event?.durationMs).toBe(30_000);
  });

  it('does not re-alert until the HR recovers above the threshold', () => {
    const d = detector();
    d.evaluate(reading(40, 0), 45);
    const first = d.evaluate(reading(40, 35_000), 45);
    expect(first).not.toBeNull();

    // Still low — no duplicate alert.
    expect(d.evaluate(reading(40, 60_000), 45)).toBeNull();
    expect(d.evaluate(reading(40, 120_000), 45)).toBeNull();

    // Recovery rearms the detector.
    d.evaluate(reading(55, 130_000), 45);
    d.evaluate(reading(40, 140_000), 45);
    const second = d.evaluate(reading(40, 175_000), 45);
    expect(second).not.toBeNull();
  });
});

describe('detectBradycardiaEvents', () => {
  const t = (iso: string, offsetMs = 0) => Date.parse(iso) + offsetMs;
  const stream = (iso: string, bpms: number[], stepMs = 1_000) =>
    bpms.map((bpm, i) => reading(bpm, t(iso, i * stepMs)));

  it('emits the same event the live detector would have', () => {
    const events = detectBradycardiaEvents(
      stream('2026-01-05T15:00:00', [60, 40, 38, 39, 41], 15_000),
      DEFAULT_THRESHOLDS,
    );
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('bradycardia');
    expect(events[0].bpm).toBe(38);
    expect(events[0].durationMs).toBe(30_000);
  });

  it('applies the night floor per reading timestamp', () => {
    // 40 bpm sustained for a minute alerts during the day (floor 45)…
    const dayEvents = detectBradycardiaEvents(
      stream('2026-01-05T15:00:00', new Array(61).fill(40)),
      DEFAULT_THRESHOLDS,
    );
    expect(dayEvents).toHaveLength(1);
    // …but not at night (floor 35).
    const nightEvents = detectBradycardiaEvents(
      stream('2026-01-05T03:00:00', new Array(61).fill(40)),
      DEFAULT_THRESHOLDS,
    );
    expect(nightEvents).toHaveLength(0);
  });

  it('emits one event per sustained episode, re-armed by recovery', () => {
    const bpms = [...new Array(61).fill(40), ...new Array(5).fill(60), ...new Array(61).fill(40)];
    const events = detectBradycardiaEvents(
      stream('2026-01-05T15:00:00', bpms),
      DEFAULT_THRESHOLDS,
    );
    expect(events).toHaveLength(2);
  });
});

describe('thresholds', () => {
  it('uses the night floor inside the sleep window', () => {
    expect(isNightTime(new Date('2026-01-01T02:00:00'))).toBe(true);
    expect(isNightTime(new Date('2026-01-01T23:30:00'))).toBe(true);
    expect(isNightTime(new Date('2026-01-01T12:00:00'))).toBe(false);
    expect(isNightTime(new Date('2026-01-01T07:00:00'))).toBe(false);
  });

  it('picks the contextual threshold', () => {
    const night = new Date('2026-01-01T03:00:00');
    const day = new Date('2026-01-01T15:00:00');
    expect(activeLowThreshold(DEFAULT_THRESHOLDS, night)).toBe(35);
    expect(activeLowThreshold(DEFAULT_THRESHOLDS, day)).toBe(45);
  });
});
