import { and, desc, eq, gte, isNull, lte, sql } from 'drizzle-orm';

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

/** Bulk import (e.g. Health Connect restore) — no session attached. */
export async function saveReadings(
  batch: HRReading[],
  source: string,
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < batch.length; i += CHUNK) {
    await getDb()
      .insert(readings)
      .values(
        batch.slice(i, i + CHUNK).map((r) => ({
          timestamp: r.timestamp,
          bpm: r.bpm,
          rrIntervalsMs: JSON.stringify(r.rrIntervalsMs),
          source,
          sessionId: null,
        })),
      );
  }
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

export interface ReadingBucketRow {
  bucket: number;
  minBpm: number;
  avgBpm: number;
  maxBpm: number;
  count: number;
}

/**
 * HR series pre-aggregated in SQL for charts: one row per `bucketMs` slice.
 * Fetching ~100 aggregated rows instead of ~30k raw readings keeps the
 * Informes cards cheap even after months of overnight sessions.
 */
export async function getSessionReadingBuckets(
  sessionId: number,
  windowStart: number,
  bucketMs: number,
): Promise<ReadingBucketRow[]> {
  const rows = await getDb().all(sql`
    SELECT
      CAST((${readings.timestamp} - ${windowStart}) / ${bucketMs} AS INTEGER) AS bucket,
      MIN(${readings.bpm}) AS minBpm,
      AVG(${readings.bpm}) AS avgBpm,
      MAX(${readings.bpm}) AS maxBpm,
      COUNT(*) AS count
    FROM ${readings}
    WHERE ${readings.sessionId} = ${sessionId}
    GROUP BY bucket
    ORDER BY bucket
  `);
  return rows as ReadingBucketRow[];
}

export async function getSessionEvents(sessionId: number) {
  return getDb()
    .select()
    .from(events)
    .where(eq(events.sessionId, sessionId))
    .orderBy(events.timestamp);
}

/** Readings not attached to any session — restore session-rebuild source. */
export async function getSessionlessReadings(source?: string) {
  const conditions = source
    ? and(isNull(readings.sessionId), eq(readings.source, source))
    : isNull(readings.sessionId);
  return getDb()
    .select()
    .from(readings)
    .where(conditions)
    .orderBy(readings.timestamp);
}

/** Attaches all session-less readings in [fromTs, toTs] to a session. */
export async function assignReadingsToSession(
  sessionId: number,
  fromTs: number,
  toTs: number,
  source?: string,
): Promise<void> {
  await getDb()
    .update(readings)
    .set({ sessionId })
    .where(
      and(
        isNull(readings.sessionId),
        source ? eq(readings.source, source) : undefined,
        gte(readings.timestamp, fromTs),
        lte(readings.timestamp, toTs),
      ),
    );
}

/** Attaches all session-less events in [fromTs, toTs] to a session. */
export async function assignEventsToSession(
  sessionId: number,
  fromTs: number,
  toTs: number,
): Promise<void> {
  await getDb()
    .update(events)
    .set({ sessionId })
    .where(
      and(
        isNull(events.sessionId),
        gte(events.timestamp, fromTs),
        lte(events.timestamp, toTs),
      ),
    );
}

/** Updates a session's time bounds (used when a restored run extends it). */
export async function updateSessionBounds(
  sessionId: number,
  startedAt: number,
  endedAt: number,
): Promise<void> {
  await getDb()
    .update(sessions)
    .set({ startedAt, endedAt })
    .where(eq(sessions.id, sessionId));
}

/** Moves every reading and event of one session onto another (session merge). */
export async function moveSessionContents(
  fromSessionId: number,
  toSessionId: number,
): Promise<void> {
  const db = getDb();
  await db
    .update(readings)
    .set({ sessionId: toSessionId })
    .where(eq(readings.sessionId, fromSessionId));
  await db
    .update(events)
    .set({ sessionId: toSessionId })
    .where(eq(events.sessionId, fromSessionId));
}

export async function deleteSession(sessionId: number): Promise<void> {
  await getDb().delete(sessions).where(eq(sessions.id, sessionId));
}

/** Full-table reads for the manual backup export. */
export async function getAllReadings() {
  return getDb().select().from(readings).orderBy(readings.timestamp);
}

export async function getAllEvents() {
  return getDb().select().from(events).orderBy(events.timestamp);
}

export async function getAllSessions() {
  return getDb().select().from(sessions).orderBy(sessions.startedAt);
}

/** Restores a session row from a backup; returns the new local id. */
export async function importSession(row: {
  startedAt: number;
  endedAt: number | null;
  source: string;
  sensorLabel: string;
}): Promise<number> {
  const res = await getDb()
    .insert(sessions)
    .values(row)
    .returning({ id: sessions.id });
  return res[0].id;
}

export async function importReadings(
  rows: {
    timestamp: number;
    bpm: number;
    rrIntervalsMs: string | null;
    source: string;
    sessionId: number | null;
  }[],
): Promise<void> {
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    await getDb()
      .insert(readings)
      .values(rows.slice(i, i + CHUNK));
  }
}

export async function importEvents(
  rows: {
    type: 'bradycardia' | 'pause';
    timestamp: number;
    payload: string;
    sessionId: number | null;
  }[],
): Promise<void> {
  for (const row of rows) {
    await getDb().insert(events).values(row);
  }
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
