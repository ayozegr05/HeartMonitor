import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

import {
  getAllEvents,
  getAllReadings,
  getAllSessions,
  importEvents,
  importReadings,
  importSession,
} from '@/data/readingsRepository';

/**
 * Manual device backup: exports the whole local DB (sessions, readings,
 * events) to a JSON file the user can keep anywhere, and imports it back —
 * e.g. after a reinstall or on a new phone. Everything stays local; the
 * share sheet decides where the file goes.
 *
 * Android Auto Backup (see plugins/withAndroidAutoBackup) covers the same
 * data silently; this is the user-controlled belt-and-braces on top.
 */
interface BackupSessionRow {
  id: number;
  startedAt: number;
  endedAt: number | null;
  source: string;
  sensorLabel: string;
}

interface BackupReadingRow {
  timestamp: number;
  bpm: number;
  rrIntervalsMs: string | null;
  source: string;
  sessionId: number | null;
}

interface BackupEventRow {
  type: 'bradycardia' | 'pause';
  timestamp: number;
  payload: string;
  sessionId: number | null;
}

interface BackupFile {
  version: 1;
  exportedAt: number;
  sessions: BackupSessionRow[];
  readings: BackupReadingRow[];
  events: BackupEventRow[];
}

/** Exports the full DB to a shareable JSON file. Returns the row counts. */
export async function exportBackup(): Promise<{
  sessions: number;
  readings: number;
  events: number;
} | null> {
  if (!(await Sharing.isAvailableAsync())) return null;
  const [sessionRows, readingRows, eventRows] = await Promise.all([
    getAllSessions(),
    getAllReadings(),
    getAllEvents(),
  ]);
  const payload: BackupFile = {
    version: 1,
    exportedAt: Date.now(),
    sessions: sessionRows.map((s) => ({
      id: s.id,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      source: s.source,
      sensorLabel: s.sensorLabel,
    })),
    readings: readingRows.map((r) => ({
      timestamp: r.timestamp,
      bpm: r.bpm,
      rrIntervalsMs: r.rrIntervalsMs,
      source: r.source,
      sessionId: r.sessionId,
    })),
    events: eventRows.map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      payload: e.payload,
      sessionId: e.sessionId,
    })),
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const uri = `${FileSystem.cacheDirectory}heartmonitor-backup-${stamp}.json`;
  await FileSystem.writeAsStringAsync(uri, JSON.stringify(payload));
  await Sharing.shareAsync(uri, {
    mimeType: 'application/json',
    dialogTitle: 'Copia de seguridad HeartMonitor',
  });
  return {
    sessions: sessionRows.length,
    readings: readingRows.length,
    events: eventRows.length,
  };
}

export interface ImportResult {
  sessions: number;
  readings: number;
  events: number;
}

/**
 * Imports a backup file, skipping rows already stored. Session ids are
 * re-generated locally and remapped onto the imported readings/events.
 * Returns null when the user cancels the picker.
 */
export async function importBackup(): Promise<ImportResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (picked.canceled || picked.assets.length === 0) return null;
  const text = await FileSystem.readAsStringAsync(picked.assets[0].uri);
  const parsed = JSON.parse(text) as BackupFile;
  if (
    parsed.version !== 1 ||
    !Array.isArray(parsed.sessions) ||
    !Array.isArray(parsed.readings) ||
    !Array.isArray(parsed.events)
  ) {
    throw new Error('invalid backup file');
  }

  const existingSessions = await getAllSessions();
  const sessionKey = (startedAt: number, source: string) =>
    `${startedAt}|${source}`;
  const existingByKey = new Map(
    existingSessions.map((s) => [sessionKey(s.startedAt, s.source), s.id]),
  );
  const sessionIdMap = new Map<number, number>();
  let importedSessions = 0;
  for (const s of parsed.sessions) {
    const key = sessionKey(s.startedAt, s.source);
    const existingId = existingByKey.get(key);
    if (existingId !== undefined) {
      sessionIdMap.set(s.id, existingId);
      continue;
    }
    const newId = await importSession({
      startedAt: s.startedAt,
      endedAt: s.endedAt ?? null,
      source: s.source,
      sensorLabel: s.sensorLabel,
    });
    sessionIdMap.set(s.id, newId);
    importedSessions += 1;
  }
  const mapSession = (old: number | null) =>
    old === null ? null : (sessionIdMap.get(old) ?? null);

  const existingReadingTs = new Set(
    (await getAllReadings()).map((r) => r.timestamp),
  );
  const freshReadings = parsed.readings
    .filter((r) => !existingReadingTs.has(r.timestamp))
    .map((r) => ({
      timestamp: r.timestamp,
      bpm: r.bpm,
      rrIntervalsMs: r.rrIntervalsMs,
      source: r.source,
      sessionId: mapSession(r.sessionId),
    }));
  await importReadings(freshReadings);

  const existingEventKeys = new Set(
    (await getAllEvents()).map((e) => `${e.type}|${e.timestamp}`),
  );
  const freshEvents = parsed.events
    .filter((e) => !existingEventKeys.has(`${e.type}|${e.timestamp}`))
    .map((e) => ({
      type: e.type,
      timestamp: e.timestamp,
      payload: e.payload,
      sessionId: mapSession(e.sessionId),
    }));
  await importEvents(freshEvents);

  return {
    sessions: importedSessions,
    readings: freshReadings.length,
    events: freshEvents.length,
  };
}
