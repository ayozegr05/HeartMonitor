import type { EcgRhythmReport } from '@/domain/ecgAnalysis';

export interface CapturedStrip {
  timestamp: number;
  sampleRateHz: number;
  samples: number[];
  report: EcgRhythmReport;
}

/**
 * In-memory store of captured ECG strips (30 s snapshots). Persisted to
 * file and attached to the cardiologist PDF in a later milestone — the
 * raw µV samples are the evidence, so they stay out of SQLite.
 */
const strips: CapturedStrip[] = [];

export function saveStrip(strip: CapturedStrip): void {
  strips.push(strip);
}

export function getStrips(): readonly CapturedStrip[] {
  return strips;
}

export function clearStrips(): void {
  strips.length = 0;
}
