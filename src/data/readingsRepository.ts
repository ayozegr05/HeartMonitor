import { desc, gte } from 'drizzle-orm';

import type { AlertEvent, HRReading } from '@/domain/models';

import { getDb } from './db';
import { events, readings } from './schema';

/** Repository boundary — the rest of the app never touches SQL/drizzle directly. */

export async function saveReading(reading: HRReading, source: string): Promise<void> {
  await getDb().insert(readings).values({
    timestamp: reading.timestamp,
    bpm: reading.bpm,
    rrIntervalsMs: JSON.stringify(reading.rrIntervalsMs),
    source,
  });
}

export async function saveEvent(event: AlertEvent): Promise<void> {
  await getDb().insert(events).values({
    type: event.type,
    timestamp: event.timestamp,
    payload: JSON.stringify(event),
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
