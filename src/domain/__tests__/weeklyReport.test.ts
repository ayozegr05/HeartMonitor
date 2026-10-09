import type { SessionReport } from '../morningReport';
import { buildWeeklyReport, WEEK_MS } from '../weeklyReport';

const NOW = new Date(2026, 0, 8, 12, 0).getTime();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const report = (
  windowStart: number,
  durationMs: number,
  overrides: Partial<SessionReport> = {},
): SessionReport => ({
  windowStart,
  windowEnd: windowStart + durationMs,
  durationMs,
  readingsCount: 0,
  minBpm: null,
  avgBpm: null,
  maxBpm: null,
  timeBelowThresholdMs: 0,
  nightCoverageMs: 0,
  eventCount: 0,
  bradycardiaCount: 0,
  pauseCount: 0,
  longestPauseMs: null,
  rmssdMs: null,
  ...overrides,
});

describe('buildWeeklyReport', () => {
  it('aggregates sessions inside the 7-day window', () => {
    const weekly = buildWeeklyReport(
      [
        report(NOW - DAY, 8 * HOUR, {
          readingsCount: 28_800,
          avgBpm: 54,
          minBpm: 44,
          maxBpm: 78,
          nightCoverageMs: 7 * HOUR,
          eventCount: 2,
          bradycardiaCount: 1,
          pauseCount: 1,
          longestPauseMs: 2_400,
          timeBelowThresholdMs: 10 * 60_000,
        }),
        report(NOW - 2 * DAY, 8 * HOUR, {
          readingsCount: 28_800,
          avgBpm: 60,
          minBpm: 48,
          maxBpm: 88,
          nightCoverageMs: 6 * HOUR,
          eventCount: 1,
          pauseCount: 1,
          longestPauseMs: 3_100,
        }),
      ],
      NOW,
    );

    expect(weekly.sessionsCount).toBe(2);
    expect(weekly.nightsCovered).toBe(2);
    expect(weekly.totalMonitoredMs).toBe(16 * HOUR);
    expect(weekly.totalReadings).toBe(57_600);
    expect(weekly.avgBpm).toBe(57); // equal counts → mean of 54 and 60
    expect(weekly.minBpm).toBe(44);
    expect(weekly.maxBpm).toBe(88);
    expect(weekly.timeBelowThresholdMs).toBe(10 * 60_000);
    expect(weekly.eventCount).toBe(3);
    expect(weekly.bradycardiaCount).toBe(1);
    expect(weekly.pauseCount).toBe(2);
    expect(weekly.longestPauseMs).toBe(3_100);
  });

  it('weights the weekly average by readings count', () => {
    const weekly = buildWeeklyReport(
      [
        report(NOW - DAY, 8 * HOUR, { readingsCount: 900, avgBpm: 50 }),
        report(NOW - 2 * DAY, 1 * HOUR, { readingsCount: 100, avgBpm: 80 }),
      ],
      NOW,
    );
    // (50*900 + 80*100) / 1000 = 53
    expect(weekly.avgBpm).toBe(53);
  });

  it('excludes sessions fully outside the period but keeps overlaps', () => {
    const weekly = buildWeeklyReport(
      [
        report(NOW - 10 * DAY, 8 * HOUR), // ended before the window
        report(NOW - 8 * DAY, 2 * DAY), // spans the boundary → counts
      ],
      NOW,
    );
    expect(weekly.sessionsCount).toBe(1);
    expect(weekly.perSession[0].durationMs).toBe(2 * DAY);
    expect(weekly.periodStart).toBe(NOW - WEEK_MS);
  });

  it('averages per-session RMSSD across the week', () => {
    const weekly = buildWeeklyReport(
      [
        report(NOW - DAY, 8 * HOUR, { rmssdMs: 40 }),
        report(NOW - 2 * DAY, 8 * HOUR, { rmssdMs: 60 }),
        report(NOW - 3 * DAY, 8 * HOUR), // no RR data
      ],
      NOW,
    );
    expect(weekly.avgRmssdMs).toBe(50);
  });

  it('handles an empty week', () => {
    const weekly = buildWeeklyReport([], NOW);
    expect(weekly.sessionsCount).toBe(0);
    expect(weekly.avgBpm).toBeNull();
    expect(weekly.longestPauseMs).toBeNull();
    expect(weekly.eventCount).toBe(0);
  });
});
