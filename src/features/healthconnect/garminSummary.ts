import { Platform } from 'react-native';
import {
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

import { gte } from 'drizzle-orm';

import { getDb } from '@/data/db';
import { garminDays } from '@/data/schema';
import { fetchGarminApiDays } from '@/features/garmin/garminApi';

import { healthConnectStatus } from './healthConnectSync';

/**
 * Reads the summaries other apps (Garmin Connect, Health Sync…) publish
 * into Health Connect: last sleep sessions with stages, overnight HRV
 * (RMSSD) and resting HR. This is the "your watch says" comparator — the
 * watch never broadcasts live RR over BLE, but its nightly digest is
 * reachable once the user enables Health Connect writes in the watch app.
 */

export interface GarminSleepStage {
  /** SleepStageType constants: 1 awake, 4 light, 5 deep, 6 rem… */
  stage: number;
  ms: number;
}

export interface GarminSleepSummary {
  startedAt: number;
  endedAt: number;
  stagesMs: { deep: number; light: number; rem: number; awake: number };
}

export interface GarminDailySummary {
  hrvRmssdMs: number | null;
  restingBpm: number | null;
  sleep: GarminSleepSummary | null;
  /** Package name that supplied the data (e.g. Garmin Connect's). */
  source: string | null;
}

const READ_TYPES = [
  'SleepSession',
  'HeartRateVariabilityRmssd',
  'RestingHeartRate',
  'HeartRate',
  'Steps',
  'RespiratoryRate',
  'OxygenSaturation',
] as const;

export async function requestGarminReadAccess(): Promise<boolean> {
  if (Platform.OS !== 'android') return false;
  if ((await healthConnectStatus()) !== 'available') return false;
  if (!(await initialize())) return false;
  const granted = await requestPermission(
    READ_TYPES.map((recordType) => ({ accessType: 'read' as const, recordType })),
  );
  return granted.length > 0;
}

const since = (days: number) =>
  new Date(Date.now() - days * 24 * 60 * 60_000).toISOString();

interface StagedRecord {
  startTime: string;
  endTime: string;
  stages?: { startTime: string; endTime: string; stage: number }[];
  metadata?: { dataOrigin?: string };
}

/** Latest watch sleep session plus overnight aggregates. */
export async function readGarminSummary(days = 7): Promise<GarminDailySummary> {
  const out: GarminDailySummary = {
    hrvRmssdMs: null,
    restingBpm: null,
    sleep: null,
    source: null,
  };
  if (Platform.OS !== 'android') return out;
  if ((await healthConnectStatus()) !== 'available') return out;
  if (!(await initialize())) return out;

  const timeRangeFilter = { operator: 'after' as const, startTime: since(days) };

  try {
    const sleepRes = await readRecords('SleepSession', {
      timeRangeFilter,
      ascendingOrder: false,
      pageSize: 10,
    });
    const latest = sleepRes.records[0] as unknown as StagedRecord | undefined;
    if (latest) {
      const stagesMs = { deep: 0, light: 0, rem: 0, awake: 0 };
      for (const s of latest.stages ?? []) {
        const ms = Date.parse(s.endTime) - Date.parse(s.startTime);
        if (s.stage === 5) stagesMs.deep += ms;
        else if (s.stage === 6) stagesMs.rem += ms;
        else if (s.stage === 1 || s.stage === 3) stagesMs.awake += ms;
        else stagesMs.light += ms; // SLEEPING/UNKNOWN count as light-ish
      }
      out.sleep = {
        startedAt: Date.parse(latest.startTime),
        endedAt: Date.parse(latest.endTime),
        stagesMs,
      };
      out.source = latest.metadata?.dataOrigin ?? null;
    }
  } catch {
    // Permission not granted for SleepSession — leave null.
  }

  try {
    const hrvRes = await readRecords('HeartRateVariabilityRmssd', {
      timeRangeFilter,
      ascendingOrder: false,
      pageSize: 5,
    });
    const rec = hrvRes.records[0] as unknown as
      | { heartRateVariabilityMillis?: number; metadata?: { dataOrigin?: string } }
      | undefined;
    if (rec?.heartRateVariabilityMillis !== undefined) {
      out.hrvRmssdMs = Math.round(rec.heartRateVariabilityMillis);
      out.source = out.source ?? rec.metadata?.dataOrigin ?? null;
    }
  } catch {
    // ignore
  }

  try {
    const rhrRes = await readRecords('RestingHeartRate', {
      timeRangeFilter,
      ascendingOrder: false,
      pageSize: 5,
    });
    const rec = rhrRes.records[0] as unknown as
      | { beatsPerMinute?: number; metadata?: { dataOrigin?: string } }
      | undefined;
    if (rec?.beatsPerMinute !== undefined) {
      out.restingBpm = Math.round(rec.beatsPerMinute);
      out.source = out.source ?? rec.metadata?.dataOrigin ?? null;
    }
  } catch {
    // ignore
  }

  return out;
}

/** One day of watch data, keyed by local calendar date (nights → wake day). */
export interface GarminDayPoint {
  /** 'YYYY-MM-DD' local date. */
  day: string;
  hrvRmssdMs?: number;
  restingBpm?: number;
  sleep?: GarminSleepSummary;
  /** Mean breathing rate (breaths/min) measured that day/night. */
  respirationPerMin?: number;
  spo2AvgPct?: number;
  spo2MinPct?: number;
  steps?: number;
  hrMaxBpm?: number;
  hrMinBpm?: number;
}

export interface GarminSeries {
  /** Chronological, oldest first. */
  points: GarminDayPoint[];
  source: string | null;
}

const dayKey = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

async function readAll(
  recordType: string,
  sinceIso: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  let pageToken: string | undefined;
  do {
    const res = await readRecords(recordType as never, {
      timeRangeFilter: { operator: 'after' as const, startTime: sinceIso },
      ascendingOrder: true,
      pageSize: 1000,
      pageToken,
    });
    for (const r of res.records) out.push(r as unknown as Record<string, unknown>);
    pageToken = res.pageToken;
  } while (pageToken);
  return out;
}

const recStart = (r: Record<string, unknown>): number =>
  Date.parse((r.startTime ?? r.time) as string);
const recOrigin = (r: Record<string, unknown>): string | null =>
  ((r.metadata as { dataOrigin?: string } | undefined)?.dataOrigin) ?? null;

/**
 * Reads the watch's full published series — every day Health Connect has —
 * aggregated per day so trends can be drawn. Sleep sessions are filed under
 * the day they END (the morning), matching our own "night" semantics.
 * Reading volume stays bounded: raw HR samples collapse to daily max/min.
 */
export async function readGarminSeries(days = 30): Promise<GarminSeries> {
  const empty: GarminSeries = { points: [], source: null };
  if (Platform.OS !== 'android') return empty;
  const hcAvailable =
    (await healthConnectStatus()) === 'available' && (await initialize());

  const sinceIso = since(days);
  const byDay = new Map<string, GarminDayPoint>();
  let source: string | null = null;
  const point = (day: string): GarminDayPoint => {
    let p = byDay.get(day);
    if (!p) {
      p = { day };
      byDay.set(day, p);
    }
    return p;
  };
  const see = (r: Record<string, unknown>) => {
    source = source ?? recOrigin(r);
  };
  // Skips every Health Connect read when the store isn't available —
  // the Garmin-account merge below still runs on its own.
  const hcAll = (type: string): Promise<Record<string, unknown>[]> =>
    hcAvailable ? readAll(type, sinceIso) : Promise.resolve([]);

  try {
    for (const r of await hcAll('SleepSession')) {
      const stagesMs = { deep: 0, light: 0, rem: 0, awake: 0 };
      for (const s of (r.stages as StagedRecord['stages']) ?? []) {
        const ms = Date.parse(s.endTime) - Date.parse(s.startTime);
        if (s.stage === 5) stagesMs.deep += ms;
        else if (s.stage === 6) stagesMs.rem += ms;
        else if (s.stage === 1 || s.stage === 3) stagesMs.awake += ms;
        else stagesMs.light += ms;
      }
      const end = Date.parse(r.endTime as string);
      point(dayKey(end)).sleep = {
        startedAt: Date.parse(r.startTime as string),
        endedAt: end,
        stagesMs,
      };
      see(r);
    }
  } catch { /* permiso ausente */ }

  try {
    for (const r of await hcAll('HeartRateVariabilityRmssd')) {
      const v = r.heartRateVariabilityMillis as number | undefined;
      if (v !== undefined) {
        point(dayKey(recStart(r))).hrvRmssdMs = Math.round(v);
        see(r);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const r of await hcAll('RestingHeartRate')) {
      const v = r.beatsPerMinute as number | undefined;
      if (v !== undefined) {
        point(dayKey(recStart(r))).restingBpm = Math.round(v);
        see(r);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const r of await hcAll('RespiratoryRate')) {
      const v = r.rate as number | undefined;
      if (v !== undefined) {
        const p = point(dayKey(recStart(r)));
        // Average if several records land on the same day.
        p.respirationPerMin =
          p.respirationPerMin === undefined
            ? v
            : (p.respirationPerMin + v) / 2;
        see(r);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const r of await hcAll('OxygenSaturation')) {
      const v = r.percentage as number | undefined;
      if (v !== undefined) {
        const p = point(dayKey(recStart(r)));
        p.spo2AvgPct =
          p.spo2AvgPct === undefined ? v : (p.spo2AvgPct + v) / 2;
        p.spo2MinPct =
          p.spo2MinPct === undefined ? v : Math.min(p.spo2MinPct, v);
        see(r);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const r of await hcAll('Steps')) {
      const v = r.count as number | undefined;
      if (v !== undefined) {
        const p = point(dayKey(recStart(r)));
        p.steps = (p.steps ?? 0) + v;
        see(r);
      }
    }
  } catch { /* ignore */ }

  try {
    for (const r of await hcAll('HeartRate')) {
      const samples = r.samples as { beatsPerMinute: number }[] | undefined;
      if (!samples?.length) continue;
      const p = point(dayKey(recStart(r)));
      for (const s of samples) {
        const bpm = Math.round(s.beatsPerMinute);
        p.hrMaxBpm = p.hrMaxBpm === undefined ? bpm : Math.max(p.hrMaxBpm, bpm);
        p.hrMinBpm = p.hrMinBpm === undefined ? bpm : Math.min(p.hrMinBpm, bpm);
      }
      see(r);
    }
  } catch { /* ignore */ }

  // Persisted account data from earlier reads — applied over Health
  // Connect so older days stay visible even when the live API window
  // (or a failed login) doesn't reach them.
  const overlay = (day: string, ap: Partial<GarminDayPoint>) => {
    const p = point(day);
    Object.assign(
      p,
      Object.fromEntries(
        Object.entries(ap).filter(([, v]) => v !== undefined),
      ),
    );
  };
  try {
    const stored = await getDb()
      .select()
      .from(garminDays)
      .where(gte(garminDays.day, dayKey(Date.now() - days * 86_400_000)));
    for (const row of stored) {
      overlay(row.day, JSON.parse(row.payload) as Partial<GarminDayPoint>);
    }
    if (stored.length > 0 && source === null) source = 'cuenta Garmin';
  } catch { /* tabla aún no migrada o base de datos no disponible */ }

  // Direct Garmin Connect account read — fills the vitals Garmin never
  // writes to Health Connect (VFC, SpO2, respiration) plus resting HR,
  // steps and sleep stages. API values win where both sources have data.
  try {
    const apiDays = await fetchGarminApiDays(days);
    if (apiDays && apiDays.size > 0) {
      for (const [day, ap] of apiDays) {
        overlay(day, ap);
      }
      source = 'cuenta Garmin';
      // Cache the merged day so later reads don't need the network.
      const now = Date.now();
      const db = getDb();
      for (const [day, ap] of apiDays) {
        await db
          .insert(garminDays)
          .values({ day, payload: JSON.stringify(ap), fetchedAt: now })
          .onConflictDoUpdate({
            target: garminDays.day,
            set: { payload: JSON.stringify(ap), fetchedAt: now },
          });
      }
    }
  } catch {
    // Token caducado u offline — Health Connect + caché ya sirven.
  }

  const points = [...byDay.values()].sort((a, b) =>
    a.day.localeCompare(b.day),
  );
  return { points, source };
}
