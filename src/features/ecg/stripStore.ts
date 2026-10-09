import * as FileSystem from 'expo-file-system/legacy';

import type { EcgRhythmReport } from '@/domain/ecgAnalysis';

export interface CapturedStrip {
  timestamp: number;
  sampleRateHz: number;
  samples: number[];
  report: EcgRhythmReport;
}

/**
 * Captured ECG strips (30 s snapshots). Persisted as one JSON file per
 * strip under the app's document directory — the raw µV samples are the
 * evidence, so they stay out of SQLite. An in-memory mirror backs the
 * synchronous getters; `loadStrips` (re)hydrates it from disk.
 */
const DIR = `${FileSystem.documentDirectory}ecg-strips/`;
const FILE_PREFIX = 'strip-';
const FILE_SUFFIX = '.json';

const strips: CapturedStrip[] = [];

function fileName(timestamp: number): string {
  return `${FILE_PREFIX}${timestamp}${FILE_SUFFIX}`;
}

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  }
}

export function saveStrip(strip: CapturedStrip): void {
  strips.push(strip);
  strips.sort((a, b) => a.timestamp - b.timestamp);
  void (async () => {
    try {
      await ensureDir();
      await FileSystem.writeAsStringAsync(
        `${DIR}${fileName(strip.timestamp)}`,
        JSON.stringify(strip),
      );
    } catch {
      // Persistence is best-effort; the strip still lives in memory.
    }
  })();
}

/** Rehydrates the in-memory mirror from disk. Call on screen focus. */
export async function loadStrips(): Promise<CapturedStrip[]> {
  try {
    await ensureDir();
    const names = await FileSystem.readDirectoryAsync(DIR);
    const loaded: CapturedStrip[] = [];
    for (const name of names) {
      if (!name.startsWith(FILE_PREFIX) || !name.endsWith(FILE_SUFFIX)) {
        continue;
      }
      try {
        const text = await FileSystem.readAsStringAsync(`${DIR}${name}`);
        loaded.push(JSON.parse(text) as CapturedStrip);
      } catch {
        // Skip unreadable/corrupt files instead of failing the list.
      }
    }
    loaded.sort((a, b) => a.timestamp - b.timestamp);
    strips.length = 0;
    strips.push(...loaded);
  } catch {
    // Directory unreadable — leave the in-memory mirror as-is.
  }
  return strips;
}

export function getStrips(): readonly CapturedStrip[] {
  return strips;
}

export function removeStrip(timestamp: number): void {
  const i = strips.findIndex((s) => s.timestamp === timestamp);
  if (i >= 0) strips.splice(i, 1);
  void FileSystem.deleteAsync(`${DIR}${fileName(timestamp)}`, {
    idempotent: true,
  }).catch(() => undefined);
}

export function clearStrips(): void {
  strips.length = 0;
  void FileSystem.deleteAsync(DIR, { idempotent: true }).catch(
    () => undefined,
  );
}
