import * as FileSystem from 'expo-file-system/legacy';
import * as Sharing from 'expo-sharing';

/**
 * Full-session ECG recording: the whole stream written to disk, not
 * just 30 s snapshots. Samples are int16 µV; they land in part files
 * (~5 min each) so a crash loses at most one window and the export
 * can rebuild the night in order.
 *
 * Layout under `documentDirectory/ecg-sessions/`:
 *   sess-<startMs>.json           — metadata {startedAt, endedAt,
 *                                   sampleRateHz, samples, parts}
 *   sess-<startMs>-part<N>.bin    — base64 of int16-LE µV samples
 */

const DIR = `${FileSystem.documentDirectory}ecg-sessions/`;
const META_SUFFIX = '.json';
const PART_SUFFIX = '.bin';
/** Flush in-memory samples to a part file every ~5 min. */
const FLUSH_SAMPLES = 39_000; // 300 s × 130 Hz
/** Chunk size when building the export string (chars worth of lines). */
const CSV_CHUNK_LINES = 50_000;

export interface EcgSessionInfo {
  /** Start timestamp (ms) — also the session id. */
  startedAt: number;
  endedAt: number | null;
  sampleRateHz: number;
  samples: number;
  parts: number;
}

type SessionMeta = EcgSessionInfo;

async function ensureDir(): Promise<void> {
  const info = await FileSystem.getInfoAsync(DIR);
  if (!info.exists) {
    await FileSystem.makeDirectoryAsync(DIR, { intermediates: true });
  }
}

function metaPath(startedAt: number): string {
  return `${DIR}sess-${startedAt}${META_SUFFIX}`;
}

function partPath(startedAt: number, part: number): string {
  return `${DIR}sess-${startedAt}-part${part}${PART_SUFFIX}`;
}

function i16ToBase64(buf: Int16Array): string {
  const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  let bin = '';
  const STEP = 8192;
  for (let i = 0; i < bytes.length; i += STEP) {
    bin += String.fromCharCode(...bytes.subarray(i, i + STEP));
  }
  return btoa(bin);
}

function base64ToI16(b64: string): Int16Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Int16Array(bytes.buffer);
}

async function writeMeta(meta: SessionMeta): Promise<void> {
  await FileSystem.writeAsStringAsync(
    metaPath(meta.startedAt),
    JSON.stringify(meta),
  );
}

/**
 * Live recorder — push frame samples, forget about the rest.
 */
export class EcgSessionRecorder {
  private startedAt = 0;
  private rateHz = 130;
  private pending: number[] = [];
  private part = 0;
  private total = 0;
  private open = false;

  async start(sampleRateHz: number): Promise<void> {
    await ensureDir();
    this.startedAt = Date.now();
    this.rateHz = sampleRateHz;
    this.pending = [];
    this.part = 0;
    this.total = 0;
    this.open = true;
    await writeMeta(this.meta(null));
  }

  push(samples: number[]): void {
    if (!this.open) return;
    for (const s of samples) this.pending.push(s);
    if (this.pending.length >= FLUSH_SAMPLES) {
      void this.flush().catch(() => undefined);
    }
  }

  async stop(): Promise<EcgSessionInfo | null> {
    if (!this.open) return null;
    this.open = false;
    await this.flush();
    const meta = this.meta(Date.now());
    await writeMeta(meta);
    return meta;
  }

  get recording(): boolean {
    return this.open;
  }

  get samplesSoFar(): number {
    return this.total + this.pending.length;
  }

  private meta(endedAt: number | null): SessionMeta {
    return {
      startedAt: this.startedAt,
      endedAt,
      sampleRateHz: this.rateHz,
      samples: this.total + this.pending.length,
      parts: this.part,
    };
  }

  private async flush(): Promise<void> {
    if (this.pending.length === 0) return;
    const chunk = new Int16Array(this.pending.length);
    for (let i = 0; i < this.pending.length; i++) {
      chunk[i] = Math.max(-32768, Math.min(32767, this.pending[i]));
    }
    const part = this.part++;
    this.total += this.pending.length;
    this.pending = [];
    await FileSystem.writeAsStringAsync(
      partPath(this.startedAt, part),
      i16ToBase64(chunk),
    );
    await writeMeta(this.meta(null));
  }
}

/** Lists recorded sessions, newest first. */
export async function listEcgSessions(): Promise<EcgSessionInfo[]> {
  try {
    await ensureDir();
    const names = await FileSystem.readDirectoryAsync(DIR);
    const out: EcgSessionInfo[] = [];
    for (const name of names) {
      if (!name.endsWith(META_SUFFIX)) continue;
      try {
        const text = await FileSystem.readAsStringAsync(`${DIR}${name}`);
        out.push(JSON.parse(text) as EcgSessionInfo);
      } catch {
        // skip corrupt meta
      }
    }
    out.sort((a, b) => b.startedAt - a.startedAt);
    return out;
  } catch {
    return [];
  }
}

export async function removeEcgSession(startedAt: number): Promise<void> {
  try {
    await FileSystem.deleteAsync(metaPath(startedAt), { idempotent: true });
    const names = await FileSystem.readDirectoryAsync(DIR);
    for (const name of names) {
      if (name.startsWith(`sess-${startedAt}-part`)) {
        await FileSystem.deleteAsync(`${DIR}${name}`, {
          idempotent: true,
        });
      }
    }
  } catch {
    // best-effort
  }
}

async function readAllSamples(info: EcgSessionInfo): Promise<Int16Array> {
  const parts: Int16Array[] = [];
  let total = 0;
  for (let p = 0; p < info.parts; p++) {
    try {
      const b64 = await FileSystem.readAsStringAsync(
        partPath(info.startedAt, p),
      );
      const arr = base64ToI16(b64);
      parts.push(arr);
      total += arr.length;
    } catch {
      // missing part — keep what we have
    }
  }
  const all = new Int16Array(total);
  let off = 0;
  for (const arr of parts) {
    all.set(arr, off);
    off += arr.length;
  }
  return all;
}

/** Rebuilds the whole session as CSV (ms,µV) and opens the share sheet. */
export async function shareEcgSessionCsv(info: EcgSessionInfo): Promise<void> {
  const all = await readAllSamples(info);
  const dt = 1000 / info.sampleRateHz;
  // Build the CSV in slices so the JS string never holds the whole file
  // plus a giant intermediate array at once.
  const slices: string[] = ['ms,uv'];
  for (let start = 0; start < all.length; start += CSV_CHUNK_LINES) {
    const end = Math.min(all.length, start + CSV_CHUNK_LINES);
    const lines = new Array<string>(end - start);
    for (let i = start; i < end; i++) {
      lines[i - start] = `${(i * dt).toFixed(1)},${all[i]}`;
    }
    slices.push(lines.join('\n'));
  }
  const uri = `${FileSystem.cacheDirectory}ecg-session-${info.startedAt}.csv`;
  await FileSystem.writeAsStringAsync(uri, slices.join('\n'));
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Compartir no está disponible en este dispositivo');
  }
  await Sharing.shareAsync(uri, {
    mimeType: 'text/csv',
    dialogTitle: 'Sesión ECG completa (CSV) · HeartMonitor',
  });
}
