import { desc, eq, gte } from 'drizzle-orm';

import type { AlertEvent, HRReading } from '@/domain/models';

import { getDb } from './db';
import { events, readings, sessions } from './schema';

/** Repository boundary — the rest of the app never touches SQL/drizzle directly. */

export async function saveReading(
  reading: HRReading,
  source: string,
  sessionId: number | null,
): Promise<void> {
  await getDb().insert(readings).values({
    timestamp: reading.timestamp,
    bpm: reading.bpm,
    rrIntervalsMs: JSON.stringify(reading.rrIntervalsMs),
    source,
    sessionId,
  });
}

export async function saveEvent(
  event: AlertEvent,
  sessionId: number | null,
): Promise<void> {
  await getDb().insert(events).values({
    type: event.type,
    timestamp: event.timestamp,
    payload: JSON.stringify(event),
    sessionId,
  });
}

export async function getRecentEvents(limit = 50) {
  return getDb()
    .select()
    .from(events)
    .orderBy(desc(events.timestamp))
    .limit(limit);
}

export async function getReadingsSince(sinceTimestamp: number) {
  return getDb()
    .select()
    .from(readings)
    .where(gte(readings.timestamp, sinceTimestamp))
    .orderBy(readings.timestamp);
}

/**
 * Opens a monitoring session and returns its id. Kept open (endedAt null)
 * until endSession — intentionally tolerant of process death so a resumed
 * overnight session keeps writing under the same id.
 */
export async function startSession(
  source: string,
  sensorLabel: string,
  startedAt: number,
): Promise<number> {
  const rows = await getDb()
    .insert(sessions)
    .values({ startedAt, endedAt: null, source, sensorLabel })
    .returning({ id: sessions.id });
  return rows[0].id;
}

export async function endSession(
  sessionId: number,
  endedAt: number,
): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ endedAt })
    .where(eq(sessions.id, sessionId));
}

/** Most recent sessions first — the Informes tab and Historial card read this. */
export async function getRecentSessions(limit = 30) {
  return getDb()
    .select()
    .from(sessions)
    .orderBy(desc(sessions.startedAt))
    .limit(limit);
}

export async function getSessionReadings(sessionId: number) {
  return getDb()
    .select()
    .from(readings)
    .where(eq(readings.sessionId, sessionId))
    .orderBy(readings.timestamp);
}

export async function getSessionEvents(sessionId: number) {
  return getDb()
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(events.timestamp);
}

/** Session events parsed back into domain AlertEvent objects. */
export async function getSessionAlertEvents(
  sessionId: number,
): Promise<AlertEvent[]> {
  const rows = await getSessionEvents(sessionId);
  return rows
    .map((r) => {
      try {
        return JSON.parse(r.payload) as AlertEvent;
      } catch {
        return null;
      }
    })
    .filter((e): e is AlertEvent => e !== null);
}
