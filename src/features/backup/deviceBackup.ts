import * as DocumentPicker from 'expo-document-picker';
import * as FileSystem from 'expo-file-system/legacy';

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
 * events) to a JSON file in a user-chosen folder (SAF), and imports it
 * back — e.g. after a reinstall or on a new phone. Everything stays
 * local; the user picks the destination folder once and it is remembered.
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

/**
 * Lets the user pick the folder that will hold backups (SAF persisted
 * permission — survives reboots). Returns the directory URI or null.
 */
export async function pickBackupFolder(): Promise<string | null> {
  const res =
    await FileSystem.StorageAccessFramework.requestDirectoryPermissionsAsync();
  return res.granted ? res.directoryUri : null;
}

/** Exports the full DB as a JSON file inside `directoryUri` (SAF). */
export async function exportBackup(directoryUri: string): Promise<{
  sessions: number;
  readings: number;
  events: number;
  fileName: string;
}> {
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

  const fileName = `heartmonitor-backup-${new Date()
    .toISOString()
    .slice(0, 10)}.json`;
  const fileUri = await FileSystem.StorageAccessFramework.createFileAsync(
    directoryUri,
    fileName,
    'application/json',
  );
  await FileSystem.writeAsStringAsync(fileUri, JSON.stringify(payload));
  return {
    sessions: sessionRows.length,
    readings: readingRows.length,
    events: eventRows.length,
    fileName,
  };
}

export interface BackupEntry {
  uri: string;
  name: string;
}

/** Lists the backup files inside the user's chosen SAF folder, newest first. */
export async function listBackupsInFolder(
  directoryUri: string,
): Promise<BackupEntry[]> {
  const uris =
    await FileSystem.StorageAccessFramework.readDirectoryAsync(directoryUri);
  return uris
    .map((uri) => {
      const decoded = decodeURIComponent(uri);
      return { uri, name: decoded.slice(decoded.lastIndexOf('/') + 1) };
    })
    .filter((f) => f.name.endsWith('.json'))
    .sort((a, b) => b.name.localeCompare(a.name));
}

export interface ImportResult {
  sessions: number;
  readings: number;
  events: number;
}

/** Picks a JSON file via the system picker (fallback for files elsewhere). */
export async function importBackup(): Promise<ImportResult | null> {
  const picked = await DocumentPicker.getDocumentAsync({
    type: 'application/json',
    copyToCacheDirectory: true,
  });
  if (picked.canceled || picked.assets.length === 0) return null;
  return importBackupFromUri(picked.assets[0].uri);
}

/**
 * Imports a backup file, skipping rows already stored. Session ids are
 * re-generated locally and remapped onto the imported readings/events.
 */
export async function importBackupFromUri(uri: string): Promise<ImportResult> {
  const text = await FileSystem.readAsStringAsync(uri);
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
