import { Platform } from 'react-native';
import {
  initialize,
  readRecords,
  requestPermission,
} from 'react-native-health-connect';

import {
  assignEventsToSession,
  assignReadingsToSession,
  deleteSession,
  getAllEvents,
  getAllSessions,
  getReadingsSince,
  getSessionlessReadings,
  importSession,
  moveSessionContents,
  saveEvent,
  saveReadings,
  updateSessionBounds,
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
const RESTORE_SOURCE = 'health-connect-restore';
const PAGE_SIZE = 1000;
/** Gaps longer than this split a restored run into separate sessions. */
const SESSION_GAP_MS = 5 * 60_000;

export interface RestoreResult {
  importedReadings: number;
  importedBradycardias: number;
  restoredSessions: number;
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
    return { importedReadings: 0, importedBradycardias: 0, restoredSessions: 0 };
  }

  const existing = new Set(
    (await getReadingsSince(samples[0].timestamp)).map((r) => r.timestamp),
  );
  const fresh = samples.filter((r) => !existing.has(r.timestamp));

  let found: ReturnType<typeof detectBradycardiaEvents> = [];
  if (fresh.length > 0) {
    await saveReadings(fresh, RESTORE_SOURCE);

    // Skip bradycardias already in the events table so re-running restore
    // never duplicates them.
    const existingEvents = new Set(
      (await getAllEvents()).map((e) => `${e.type}|${e.timestamp}`),
    );
    found = detectBradycardiaEvents(fresh, thresholds).filter(
      (e) => !existingEvents.has(`${e.type}|${e.timestamp}`),
    );
    for (const event of found) {
      await saveEvent(event, null);
    }
  }

  // Rebuild sessions: group every session-less restored reading into
  // contiguous runs so Informes fills with real report cards — also
  // repairs restores done before sessions existed in the restore path.
  const sessionless = await getSessionlessReadings(RESTORE_SOURCE);
  const groups: { start: number; end: number }[] = [];
  for (const r of sessionless) {
    const last = groups[groups.length - 1];
    if (last && r.timestamp - last.end <= SESSION_GAP_MS) {
      last.end = r.timestamp;
    } else {
      groups.push({ start: r.timestamp, end: r.timestamp });
    }
  }

  // Sessions get an exclusive end bound: reports count events with
  // timestamp < endedAt, so ending on the last sample would drop an
  // alert triggered by that final reading.
  const restoredSessions = (await getAllSessions()).filter(
    (s) => s.source === RESTORE_SOURCE,
  );
  let createdSessions = 0;
  for (const g of groups) {
    // Merge with restored sessions this group overlaps or touches within
    // the gap — later restores extend a run instead of splitting it.
    const neighbors = restoredSessions.filter(
      (s) =>
        s.startedAt <= g.end + SESSION_GAP_MS &&
        (s.endedAt ?? s.startedAt) >= g.start - SESSION_GAP_MS,
    );
    if (neighbors.length === 0) {
      const sessionId = await importSession({
        startedAt: g.start,
        endedAt: g.end + 1,
        source: RESTORE_SOURCE,
        sensorLabel: 'Health Connect',
      });
      await assignReadingsToSession(sessionId, g.start, g.end, RESTORE_SOURCE);
      await assignEventsToSession(sessionId, g.start, g.end);
      restoredSessions.push({
        id: sessionId,
        startedAt: g.start,
        endedAt: g.end + 1,
        source: RESTORE_SOURCE,
        sensorLabel: 'Health Connect',
      });
      createdSessions += 1;
      continue;
    }
    const target = neighbors[0];
    const start = Math.min(target.startedAt, g.start);
    const end = Math.max(target.endedAt ?? target.startedAt, g.end + 1);
    for (const extra of neighbors.slice(1)) {
      await moveSessionContents(extra.id, target.id);
      await deleteSession(extra.id);
      restoredSessions.splice(restoredSessions.indexOf(extra), 1);
    }
    await updateSessionBounds(target.id, start, end);
    target.startedAt = start;
    target.endedAt = end;
    await assignReadingsToSession(target.id, g.start, g.end, RESTORE_SOURCE);
    await assignEventsToSession(target.id, g.start, g.end);
  }

  return {
    importedReadings: fresh.length,
    importedBradycardias: found.length,
    restoredSessions: createdSessions,
  };
}
