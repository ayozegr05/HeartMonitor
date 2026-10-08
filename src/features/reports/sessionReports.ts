import type { AlertEvent, ThresholdProfile } from '@/domain/models';
import {
  buildSessionReport,
  type SessionReport,
} from '@/domain/morningReport';
import {
  getRecentSessions,
  getSessionAlertEvents,
  getSessionReadings,
} from '@/data/readingsRepository';
import type { sessions } from '@/data/schema';

export type SessionRow = typeof sessions.$inferSelect;

export interface SessionWithReport {
  session: SessionRow;
  report: SessionReport;
  events: AlertEvent[];
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
      return {
        session,
        report: buildSessionReport(
          { startedAt: session.startedAt, endedAt: session.endedAt },
          readings,
          events,
          thresholds,
        ),
        events,
      };
    }),
  );
}
