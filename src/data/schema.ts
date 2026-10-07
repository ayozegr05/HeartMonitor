import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * Raw sensor stream. At ~1 reading/second a full year is ~31M rows,
 * which SQLite handles fine; retention/cleanup can come later.
 */
export const readings = sqliteTable(
  'readings',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Unix ms timestamp of the reading. */
    timestamp: integer('timestamp').notNull(),
    bpm: integer('bpm').notNull(),
    /** JSON-serialized number[] of RR intervals (ms). */
    rrIntervalsMs: text('rr_intervals_ms'),
    /** Sensor label, e.g. "Instinct 3", "Polar H10", "Simulador". */
    source: text('source').notNull(),
  },
  (t) => [index('idx_readings_timestamp').on(t.timestamp)],
);

/** Detected clinical-relevant events (bradycardia episodes, pauses). */
export const events = sqliteTable(
  'events',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    type: text('type', { enum: ['bradycardia', 'pause'] }).notNull(),
    timestamp: integer('timestamp').notNull(),
    /** JSON-serialized AlertEvent payload. */
    payload: text('payload').notNull(),
  },
  (t) => [index('idx_events_timestamp').on(t.timestamp)],
);
