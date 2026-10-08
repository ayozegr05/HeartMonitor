import type { AlertEvent, ThresholdProfile } from './models';
import { activeLowThreshold, isNightTime } from './thresholds';

/** Half-open monitoring window the report is built over. */
export interface ReportWindow {
  startedAt: number;
  /** When the session ended; null while it is still open. */
  endedAt: number | null;
}

/** Minimal reading shape the report needs — decoupled from the DB row. */
export interface ReportReading {
  timestamp: number;
  bpm: number;
}

export interface SessionReport {
  windowStart: number;
  windowEnd: number;
  durationMs: number;
  readingsCount: number;
  minBpm: number | null;
  avgBpm: number | null;
  maxBpm: number | null;
  /**
   * Time spent below the context-aware alert floor (day floor while awake,
   * night floor inside the sleep window), in ms.
   */
  timeBelowThresholdMs: number;
  /** Time covered by readings inside the sleep window, in ms. */
  nightCoverageMs: number;
  eventCount: number;
  bradycardiaCount: number;
  pauseCount: number;
  /** Longest dropped-beat interval observed (ms); null if no pauses. */
  longestPauseMs: number | null;
}

/**
 * Builds the per-session ("morning") report purely from data — no DB, no
 * platform APIs. `events` may include rows outside the window; they are
 * filtered to [windowStart, windowEnd).
 *
 * Interval attribution: each reading owns the slice until the next reading
 * (or the window end for the last one), so sub-threshold and night coverage
 * reflect the time actually spent in that state, not just sample counts.
 */
export function buildSessionReport(
  window: ReportWindow,
  sessionReadings: ReportReading[],
  events: AlertEvent[],
  thresholds: ThresholdProfile,
): SessionReport {
  const sorted = [...sessionReadings].sort((a, b) => a.timestamp - b.timestamp);
  const last = sorted[sorted.length - 1];
  const windowEnd = window.endedAt ?? last?.timestamp ?? window.startedAt;
  const durationMs = Math.max(0, windowEnd - window.startedAt);

  let minBpm: number | null = null;
  let maxBpm: number | null = null;
  let bpmSum = 0;
  let timeBelowThresholdMs = 0;
  let nightCoverageMs = 0;

  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    minBpm = minBpm === null ? r.bpm : Math.min(minBpm, r.bpm);
    maxBpm = maxBpm === null ? r.bpm : Math.max(maxBpm, r.bpm);
    bpmSum += r.bpm;

    const next = sorted[i + 1];
    const sliceEnd = Math.min(next?.timestamp ?? windowEnd, windowEnd);
    const sliceMs = Math.max(0, sliceEnd - r.timestamp);
    const date = new Date(r.timestamp);
    if (r.bpm < activeLowThreshold(thresholds, date)) {
      timeBelowThresholdMs += sliceMs;
    }
    if (isNightTime(date)) {
      nightCoverageMs += sliceMs;
    }
  }

  const inWindow = events.filter(
    (e) => e.timestamp >= window.startedAt && e.timestamp < windowEnd,
  );
  const pauses = inWindow.filter((e) => e.type === 'pause');
  const longestPauseMs = pauses.reduce<number | null>(
    (acc, e) =>
      e.rrIntervalMs === undefined
        ? acc
        : acc === null
          ? e.rrIntervalMs
          : Math.max(acc, e.rrIntervalMs),
    null,
  );

  return {
    windowStart: window.startedAt,
    windowEnd,
    durationMs,
    readingsCount: sorted.length,
    minBpm,
    avgBpm: sorted.length ? Math.round(bpmSum / sorted.length) : null,
    maxBpm,
    timeBelowThresholdMs,
    nightCoverageMs,
    eventCount: inWindow.length,
    bradycardiaCount: inWindow.filter((e) => e.type === 'bradycardia').length,
    pauseCount: pauses.length,
    longestPauseMs,
  };
}

/** "7h 32m", "45 min", "<1 min" — compact duration for cards and alerts. */
export function formatDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return '<1 min';
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes} min`;
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** One-line summary for the wake notification and the Historial card. */
export function formatReportSummary(report: SessionReport): string {
  const parts = [formatDuration(report.durationMs)];
  if (report.avgBpm !== null) {
    parts.push(`media ${report.avgBpm} bpm (${report.minBpm}–${report.maxBpm})`);
  }
  if (report.timeBelowThresholdMs > 0) {
    parts.push(`${formatDuration(report.timeBelowThresholdMs)} bajo umbral`);
  }
  parts.push(
    report.eventCount === 0
      ? 'sin eventos'
      : `${report.eventCount} evento${report.eventCount === 1 ? '' : 's'}`,
  );
  return parts.join(' · ');
}
