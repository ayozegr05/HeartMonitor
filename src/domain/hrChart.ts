import type { AlertEvent, HRReading, ThresholdProfile } from './models';
import { activeLowThreshold } from './thresholds';

/**
 * Chart-ready aggregation of a reading stream: the session window is split
 * into `bucketCount` time slices, each carrying min/avg/max of its samples.
 * Gaps (BLE drops, process deaths) become buckets with `hasData: false` so
 * the chart renders an honest hole instead of interpolating fake signal.
 */
export interface ChartBucket {
  startTs: number;
  minBpm: number;
  avgBpm: number;
  maxBpm: number;
  hasData: boolean;
  /** Whether the average sits below the alert floor active at that time. */
  belowThreshold: boolean;
}

export function bucketSeries(
  readings: { timestamp: number; bpm: number }[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
  thresholds: ThresholdProfile,
): ChartBucket[] {
  const spanMs = Math.max(1, windowEnd - windowStart);
  const bucketMs = spanMs / bucketCount;
  const sums = new Array<number>(bucketCount).fill(0);
  const mins = new Array<number>(bucketCount).fill(Number.POSITIVE_INFINITY);
  const maxs = new Array<number>(bucketCount).fill(Number.NEGATIVE_INFINITY);
  const counts = new Array<number>(bucketCount).fill(0);

  for (const r of readings) {
    const idx = Math.min(
      bucketCount - 1,
      Math.max(0, Math.floor((r.timestamp - windowStart) / bucketMs)),
    );
    sums[idx] += r.bpm;
    counts[idx] += 1;
    if (r.bpm < mins[idx]) mins[idx] = r.bpm;
    if (r.bpm > maxs[idx]) maxs[idx] = r.bpm;
  }

  return Array.from({ length: bucketCount }, (_, i) => {
    const startTs = windowStart + i * bucketMs;
    const hasData = counts[i] > 0;
    const avg = hasData ? sums[i] / counts[i] : 0;
    return {
      startTs,
      minBpm: hasData ? mins[i] : 0,
      avgBpm: avg,
      maxBpm: hasData ? maxs[i] : 0,
      hasData,
      belowThreshold:
        hasData && avg < activeLowThreshold(thresholds, new Date(startTs)),
    };
  });
}

/** Rolling trend from the most recent samples: ↗ rising, ↘ falling, → stable. */
export type HrTrend = 'rising' | 'falling' | 'stable';

/**
 * Compares the mean of the latest ~5 samples against the previous ~5.
 * A ±2 bpm deadband keeps the arrow from flickering on sensor jitter.
 */
export function computeTrend(readings: HRReading[]): HrTrend {
  if (readings.length < 10) return 'stable';
  const tail = readings.slice(-10);
  const prev = tail.slice(0, 5);
  const last = tail.slice(5);
  const mean = (rs: HRReading[]) =>
    rs.reduce((s, r) => s + r.bpm, 0) / rs.length;
  const delta = mean(last) - mean(prev);
  if (delta > 2) return 'rising';
  if (delta < -2) return 'falling';
  return 'stable';
}

/** Bucket indices containing at least one event — for chart markers. */
export function eventBucketIndices(
  events: AlertEvent[],
  windowStart: number,
  windowEnd: number,
  bucketCount: number,
): Set<number> {
  const spanMs = Math.max(1, windowEnd - windowStart);
  const bucketMs = spanMs / bucketCount;
  const marks = new Set<number>();
  for (const e of events) {
    const idx = Math.floor((e.timestamp - windowStart) / bucketMs);
    if (idx >= 0 && idx < bucketCount) marks.add(idx);
  }
  return marks;
}
