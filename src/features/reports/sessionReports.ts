import type { AlertEvent, ThresholdProfile } from '@/domain/models';
import {
  buildSessionReport,
  type SessionReport,
} from '@/domain/morningReport';
import {
  analyzeSleepSession,
  vagalToneOf,
  type SleepMetrics,
} from '@/domain/sleepAnalysis';
import {
  getRecentSessions,
  getSessionAlertEvents,
  getSessionReadings,
  getSessionsSince,
  setSessionRmssdMs,
} from '@/data/readingsRepository';
import { rmssdOfReadings } from '@/domain/hrv';
import type { sessions } from '@/data/schema';

export type SessionRow = typeof sessions.$inferSelect;

export interface SessionWithReport {
  session: SessionRow;
  report: SessionReport;
  events: AlertEvent[];
  /** Sleep-window estimate from the session's own HR curve. */
  sleep: SleepMetrics;
}

/**
 * Loads the most recent sessions with their computed report, newest first.
 * Reports are derived on demand from the raw readings/events — nothing is
 * denormalized, so the numbers always reflect the data actually stored.
 */
export async function loadSessionReports(
  thresholds: ThresholdProfile,
  limit = 30,
): Promise<SessionWithReport[]> {
  const rows = await getRecentSessions(limit);
  return Promise.all(
    rows.map(async (session) => {
      const [readings, events] = await Promise.all([
        getSessionReadings(session.id),
        getSessionAlertEvents(session.id),
      ]);
      const report = buildSessionReport(
        { startedAt: session.startedAt, endedAt: session.endedAt },
        readings,
        events,
        thresholds,
      );
      const sleep = analyzeSleepSession(readings);
      sleep.vagalTone = vagalToneOf(report.rmssdMs);
      return { session, report, events, sleep };
    }),
  );
}

/**
 * Computes the session's RMSSD from its raw RR stream and caches it on
 * the session row. Called once when a session ends (and lazily for
 * sessions that predate the cache), so trends never re-parse millions
 * of readings.
 */
export async function computeSessionRmssdMs(
  sessionId: number,
): Promise<number | null> {
  const readings = await getSessionReadings(sessionId);
  const value = rmssdOfReadings(readings);
  await setSessionRmssdMs(sessionId, value);
  return value;
}

export interface RmssdPoint {
  sessionId: number;
  startedAt: number;
  rmssdMs: number;
}

/**
 * One RMSSD point per monitored session in the range, newest first.
 * Uses the per-session cache; sessions missing it are computed and
 * stored on the fly, reporting progress so long backfills can render
 * incrementally.
 */
export async function loadRmssdSeries(
  sinceMs: number,
  onProgress?: (points: RmssdPoint[]) => void,
): Promise<RmssdPoint[]> {
  const rows = await getSessionsSince(sinceMs);
  const points: RmssdPoint[] = [];
  for (const row of rows) {
    let value = row.rmssdMs;
    if (value == null) {
      try {
        value = await computeSessionRmssdMs(row.id);
      } catch {
        value = null;
      }
    }
    if (value != null) {
      points.push({ sessionId: row.id, startedAt: row.startedAt, rmssdMs: value });
      onProgress?.([...points]);
    }
  }
  return points;
}
