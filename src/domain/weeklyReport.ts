import type { SessionReport } from './morningReport';

export const WEEK_MS = 7 * 24 * 3_600_000;

export interface WeeklyReport {
  /** Window start (periodEnd − 7d). */
  periodStart: number;
  periodEnd: number;
  sessionsCount: number;
  /** Sessions with meaningful coverage inside the sleep window. */
  nightsCovered: number;
  totalMonitoredMs: number;
  totalReadings: number;
  minBpm: number | null;
  /** Readings-weighted mean across sessions — long nights count more. */
  avgBpm: number | null;
  maxBpm: number | null;
  timeBelowThresholdMs: number;
  eventCount: number;
  bradycardiaCount: number;
  pauseCount: number;
  longestPauseMs: number | null;
  /** Readings-mean of session RMSSD values; null when no RR data. */
  avgRmssdMs: number | null;
  /** The session reports that fell inside the window, newest first. */
  perSession: SessionReport[];
}

/**
 * Aggregates per-session reports into the rolling 7-day weekly report.
 * A session counts when its window overlaps the period (a still-open
 * session from last week contributes its overlap, not its whole span —
 * per-session slices are already capped by their own windows).
 */
export function buildWeeklyReport(
  sessionReports: SessionReport[],
  now: number,
): WeeklyReport {
  const periodEnd = now;
  const periodStart = now - WEEK_MS;
  const inPeriod = sessionReports.filter(
    (r) => r.windowEnd > periodStart && r.windowStart < periodEnd,
  );

  let totalMonitoredMs = 0;
  let totalReadings = 0;
  let weightedBpm = 0;
  let minBpm: number | null = null;
  let maxBpm: number | null = null;
  let timeBelowThresholdMs = 0;
  let eventCount = 0;
  let bradycardiaCount = 0;
  let pauseCount = 0;
  let longestPauseMs: number | null = null;
  let nightsCovered = 0;
  let rmssdSum = 0;
  let rmssdNights = 0;

  for (const r of inPeriod) {
    totalMonitoredMs += r.durationMs;
    totalReadings += r.readingsCount;
    if (r.avgBpm !== null) {
      weightedBpm += r.avgBpm * r.readingsCount;
    }
    minBpm = r.minBpm === null ? minBpm : Math.min(minBpm ?? r.minBpm, r.minBpm);
    maxBpm = r.maxBpm === null ? maxBpm : Math.max(maxBpm ?? r.maxBpm, r.maxBpm);
    timeBelowThresholdMs += r.timeBelowThresholdMs;
    eventCount += r.eventCount;
    bradycardiaCount += r.bradycardiaCount;
    pauseCount += r.pauseCount;
    longestPauseMs =
      r.longestPauseMs === null
        ? longestPauseMs
        : longestPauseMs === null
          ? r.longestPauseMs
          : Math.max(longestPauseMs, r.longestPauseMs);
    if (r.nightCoverageMs > 0) nightsCovered += 1;
    if (r.rmssdMs !== null) {
      rmssdSum += r.rmssdMs;
      rmssdNights += 1;
    }
  }

  return {
    periodStart,
    periodEnd,
    sessionsCount: inPeriod.length,
    nightsCovered,
    totalMonitoredMs,
    totalReadings,
    minBpm,
    avgBpm: totalReadings > 0 ? Math.round(weightedBpm / totalReadings) : null,
    maxBpm,
    timeBelowThresholdMs,
    eventCount,
    bradycardiaCount,
    pauseCount,
    longestPauseMs,
    avgRmssdMs: rmssdNights > 0 ? Math.round(rmssdSum / rmssdNights) : null,
    perSession: inPeriod,
  };
}
