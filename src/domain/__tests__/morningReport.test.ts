import {
  buildSessionReport,
  formatDuration,
  formatReportSummary,
  type ReportReading,
} from '../morningReport';
import { DEFAULT_THRESHOLDS, type AlertEvent } from '../models';

// 2026-01-05 is a Monday — fixed local-time fixtures keep isNightTime
// deterministic on any machine timezone for hours away from the boundary.
const at = (h: number, m = 0) => new Date(2026, 0, 5, h, m).getTime();
const DAY = 86_400_000;

const r = (timestamp: number, bpm: number): ReportReading => ({
  timestamp,
  bpm,
});

const t = DEFAULT_THRESHOLDS; // day 45, night 35, sustained 30s

describe('buildSessionReport', () => {
  it('reports duration from start to end of a closed window', () => {
    const report = buildSessionReport(
      { startedAt: at(23), endedAt: at(23) + 8 * 3_600_000 },
      [],
      [],
      t,
    );
    expect(report.durationMs).toBe(8 * 3_600_000);
    expect(report.readingsCount).toBe(0);
    expect(report.avgBpm).toBeNull();
  });

  it('uses the last reading as end while the session is still open', () => {
    const report = buildSessionReport(
      { startedAt: at(23), endedAt: null },
      [r(at(23), 50), r(at(23) + 10_000, 52)],
      [],
      t,
    );
    expect(report.windowEnd).toBe(at(23) + 10_000);
    expect(report.durationMs).toBe(10_000);
  });

  it('computes min, average and max BPM', () => {
    const report = buildSessionReport(
      { startedAt: at(0), endedAt: at(0) + 3_000 },
      [r(at(0), 50), r(at(0) + 1_000, 60), r(at(0) + 2_000, 55)],
      [],
      t,
    );
    expect(report.minBpm).toBe(50);
    expect(report.maxBpm).toBe(60);
    expect(report.avgBpm).toBe(55);
  });

  it('attributes sub-threshold time per reading slice (night floor)', () => {
    // Night floor is 35 — 34 counts, 40 does not. Each reading owns the
    // slice until the next reading; the last one owns the tail to windowEnd.
    const start = at(2);
    const report = buildSessionReport(
      { startedAt: start, endedAt: start + 3_000 },
      [r(start, 34), r(start + 1_000, 40), r(start + 2_000, 34)],
      [],
      t,
    );
    expect(report.timeBelowThresholdMs).toBe(2_000);
    expect(report.nightCoverageMs).toBe(3_000);
  });

  it('applies the day floor to readings outside the sleep window', () => {
    // Day floor is 45 — 44 counts, 50 does not.
    const start = at(12);
    const report = buildSessionReport(
      { startedAt: start, endedAt: start + 3_000 },
      [r(start, 44), r(start + 1_000, 50), r(start + 2_000, 44)],
      [],
      t,
    );
    expect(report.timeBelowThresholdMs).toBe(2_000);
    expect(report.nightCoverageMs).toBe(0);
  });

  it('counts events inside the window and finds the longest pause', () => {
    const events: AlertEvent[] = [
      { type: 'bradycardia', timestamp: at(3), bpm: 34 },
      { type: 'pause', timestamp: at(4), rrIntervalMs: 2_100 },
      { type: 'pause', timestamp: at(5), rrIntervalMs: 3_400 },
      { type: 'pause', timestamp: at(20), rrIntervalMs: 9_999 }, // outside
    ];
    const report = buildSessionReport(
      { startedAt: at(0), endedAt: at(8) },
      [r(at(1), 50)],
      events,
      t,
    );
    expect(report.eventCount).toBe(3);
    expect(report.bradycardiaCount).toBe(1);
    expect(report.pauseCount).toBe(2);
    expect(report.longestPauseMs).toBe(3_400);
  });

  it('returns null longestPauseMs when there are no pauses', () => {
    const report = buildSessionReport(
      { startedAt: at(0), endedAt: at(0) + DAY / 24 },
      [],
      [],
      t,
    );
    expect(report.longestPauseMs).toBeNull();
    expect(report.eventCount).toBe(0);
  });
});

describe('formatDuration', () => {
  it('formats hours, minutes and tiny durations', () => {
    expect(formatDuration(7 * 3_600_000 + 32 * 60_000)).toBe('7h 32m');
    expect(formatDuration(45 * 60_000)).toBe('45 min');
    expect(formatDuration(2 * 3_600_000)).toBe('2h');
    expect(formatDuration(20_000)).toBe('<1 min');
  });
});

describe('formatReportSummary', () => {
  it('summarizes a quiet night', () => {
    const report = buildSessionReport(
      { startedAt: at(23), endedAt: at(23) + 7 * 3_600_000 },
      [r(at(23), 55), r(at(23) + 1_000, 53)],
      [],
      t,
    );
    expect(formatReportSummary(report)).toBe(
      '7h · media 54 bpm (53–55) · sin eventos',
    );
  });

  it('includes sub-threshold time and event count when present', () => {
    const start = at(1);
    const report = buildSessionReport(
      { startedAt: start, endedAt: start + 61_000 },
      [r(start, 34), r(start + 60_000, 34)],
      [{ type: 'bradycardia', timestamp: start + 500, bpm: 34 }],
      t,
    );
    expect(formatReportSummary(report)).toBe(
      '1 min · media 34 bpm (34–34) · 1 min bajo umbral · 1 evento',
    );
  });
});
