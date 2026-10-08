import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';

/**
 * A monitoring session: one continuous intent to monitor, from start to
 * stop. Survives BLE drops and process death — a resumed overnight session
 * keeps its id so the morning report covers the whole night.
 */
export const sessions = sqliteTable(
  'sessions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    /** Unix ms timestamp when monitoring started. */
    startedAt: integer('started_at').notNull(),
    /** Unix ms timestamp when the user stopped it; null while open. */
    endedAt: integer('ended_at'),
    /** 'mock' | 'ble' */
    source: text('source').notNull(),
    sensorLabel: text('sensor_label').notNull(),
  },
  (t) => [index('idx_sessions_started_at').on(t.startedAt)],
);

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
    /** Owning session; null for rows written before sessions existed. */
    sessionId: integer('session_id').references(() => sessions.id),
  },
  (t) => [
    index('idx_readings_timestamp').on(t.timestamp),
    index('idx_readings_session').on(t.sessionId),
  ],
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
    /** Owning session; null for rows written before sessions existed. */
    sessionId: integer('session_id').references(() => sessions.id),
  },
  (t) => [
    index('idx_events_timestamp').on(t.timestamp),
    index('idx_events_session').on(t.sessionId),
  ],
);
