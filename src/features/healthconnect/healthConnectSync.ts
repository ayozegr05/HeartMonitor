import { Platform } from 'react-native';
import {
  getSdkStatus,
  initialize,
  insertRecords,
  requestPermission,
  SdkAvailabilityStatus,
} from 'react-native-health-connect';
import type { HeartRateRecord } from 'react-native-health-connect';

import { getReadingsSince } from '@/data/readingsRepository';

/**
 * Health Connect stays local-first: the records live in the on-device
 * Health Connect store — nothing is sent anywhere by us. Sync is
 * watermark-based and one-way (app → Health Connect), so re-running it
 * only writes what hasn't been written yet.
 *
 * Health Connect caps a HeartRate record at ~1000 samples; we chunk
 * well below that and batch the inserts so a full night (~30k rows)
 * syncs in a handful of transactions.
 */
const SAMPLES_PER_RECORD = 500;
const RECORDS_PER_INSERT = 50;

export type HealthConnectAvailability =
  | 'available'
  | 'needs_update'
  | 'unavailable'
  | 'not_android';

export async function healthConnectStatus(): Promise<HealthConnectAvailability> {
  if (Platform.OS !== 'android') return 'not_android';
  try {
    const status = await getSdkStatus();
    if (status === SdkAvailabilityStatus.SDK_AVAILABLE) return 'available';
    if (status === SdkAvailabilityStatus.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED) {
      return 'needs_update';
    }
    return 'unavailable';
  } catch {
    return 'unavailable';
  }
}

/**
 * Initializes the client and asks for write access to HeartRate records.
 * Returns true when the permission was granted.
 */
export async function requestHealthConnectAccess(): Promise<boolean> {
  if ((await healthConnectStatus()) !== 'available') return false;
  if (!(await initialize())) return false;
  const granted = await requestPermission([
    { accessType: 'write', recordType: 'HeartRate' },
  ]);
  return granted.length > 0;
}

const iso = (ms: number) => new Date(ms).toISOString();

/**
 * Pushes readings with timestamp >= `since` to Health Connect as HeartRate
 * records. Returns the timestamp of the newest synced reading — the caller
 * stores it as the new watermark — or null when nothing was synced.
 * Partial progress is preserved: a failed batch stops the sync but earlier
 * batches already committed keep their watermark.
 */
export async function syncReadingsToHealthConnect(
  since: number,
): Promise<number | null> {
  const rows = await getReadingsSince(since);
  if (rows.length === 0) return null;
  if (!(await initialize())) return null;

  const records: HeartRateRecord[] = [];
  for (let i = 0; i < rows.length; i += SAMPLES_PER_RECORD) {
    const chunk = rows.slice(i, i + SAMPLES_PER_RECORD);
    records.push({
      recordType: 'HeartRate',
      startTime: iso(chunk[0].timestamp),
      endTime: iso(chunk[chunk.length - 1].timestamp),
      samples: chunk.map((r) => ({
        time: iso(r.timestamp),
        beatsPerMinute: r.bpm,
      })),
    });
  }

  let synced = 0;
  for (let i = 0; i < records.length; i += RECORDS_PER_INSERT) {
    const batch = records.slice(i, i + RECORDS_PER_INSERT);
    try {
      await insertRecords(batch);
      synced += batch.length;
    } catch (e) {
      console.warn('Health Connect insert failed', e);
      break;
    }
  }
  if (synced === 0) return null;
  const lastSyncedRecord = records[synced - 1];
  return Date.parse(lastSyncedRecord.endTime);
}
