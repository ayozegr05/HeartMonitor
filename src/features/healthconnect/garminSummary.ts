import { Platform } from 'react-native';
import {
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

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
