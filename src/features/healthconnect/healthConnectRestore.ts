import { Platform } from 'react-native';
import {
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

import {
  getReadingsSince,
  saveEvent,
  saveReadings,
} from '@/data/readingsRepository';
import { detectBradycardiaEvents } from '@/domain/bradycardia';
import type { HRReading, ThresholdProfile } from '@/domain/models';

import { healthConnectStatus } from './healthConnectSync';

/**
 * Reverse of the sync: reads back the HeartRate records this app wrote to
 * Health Connect and rebuilds the local history — readings plus the
 * bradycardia events the live detector would have emitted.
 *
 * Only records whose data origin is this app's package are imported, so
 * heart-rate data other apps pushed into Health Connect is ignored.
 * Pauses cannot be recovered: RR intervals are never written to
 * Health Connect, and pause detection needs them.
 *
 * Re-running is a no-op — readings already stored locally are skipped.
 */
const HC_PACKAGE = 'com.heartmonitor.app';
const PAGE_SIZE = 1000;

export interface RestoreResult {
  importedReadings: number;
  importedBradycardias: number;
}

export async function restoreFromHealthConnect(
  thresholds: ThresholdProfile,
): Promise<RestoreResult | null> {
  if (Platform.OS !== 'android') return null;
  if ((await healthConnectStatus()) !== 'available') return null;
  if (!(await initialize())) return null;
  const granted = await requestPermission([
    { accessType: 'read', recordType: 'HeartRate' },
  ]);
  if (granted.length === 0) return null;

  const samples: HRReading[] = [];
  let pageToken: string | undefined;
  do {
    const res = await readRecords('HeartRate', {
      timeRangeFilter: {
        operator: 'after',
        startTime: '1970-01-01T00:00:00.000Z',
      },
      dataOriginFilter: [HC_PACKAGE],
      ascendingOrder: true,
      pageSize: PAGE_SIZE,
      pageToken,
    });
    for (const record of res.records) {
      for (const s of record.samples) {
        samples.push({
          bpm: Math.round(s.beatsPerMinute),
          rrIntervalsMs: [],
          timestamp: Date.parse(s.time),
        });
      }
    }
    pageToken = res.pageToken;
  } while (pageToken);

  if (samples.length === 0) {
    return { importedReadings: 0, importedBradycardias: 0 };
  }

  const existing = new Set(
    (await getReadingsSince(samples[0].timestamp)).map((r) => r.timestamp),
  );
  const fresh = samples.filter((r) => !existing.has(r.timestamp));
  if (fresh.length === 0) {
    return { importedReadings: 0, importedBradycardias: 0 };
  }

  await saveReadings(fresh, 'health-connect-restore');

  const found = detectBradycardiaEvents(fresh, thresholds);
  for (const event of found) {
    await saveEvent(event, null);
  }
  return { importedReadings: fresh.length, importedBradycardias: found.length };
}
