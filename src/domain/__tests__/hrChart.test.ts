import {
  bucketSeries,
  computeTrend,
  eventBucketIndices,
} from '@/domain/hrChart';
import { DEFAULT_THRESHOLDS } from '@/domain/models';

const T0 = new Date('2025-06-01T12:00:00').getTime(); // midday → day floor (45)

const r = (offsetMin: number, bpm: number) => ({
  timestamp: T0 + offsetMin * 60_000,
  bpm,
});

describe('bucketSeries', () => {
  const windowEnd = T0 + 10 * 60_000;

  it('aggregates readings into avg/min/max per bucket', () => {
    const readings = [
      r(0, 60), r(0.5, 70),   // bucket 0
      r(5, 80),             // bucket 5
    ];
    const buckets = bucketSeries(readings, T0, windowEnd, 10, DEFAULT_THRESHOLDS);
    expect(buckets).toHaveLength(10);
    expect(buckets[0].avgBpm).toBe(65);
    expect(buckets[0].minBpm).toBe(60);
    expect(buckets[0].maxBpm).toBe(70);
    expect(buckets[5].avgBpm).toBe(80);
  });

  it('marks empty time slices as hasData=false (honest gaps)', () => {
    const buckets = bucketSeries([r(0, 60)], T0, windowEnd, 10, DEFAULT_THRESHOLDS);
    expect(buckets[0].hasData).toBe(true);
    expect(buckets[9].hasData).toBe(false);
    expect(buckets[9].belowThreshold).toBe(false);
  });

  it('flags buckets whose average is below the active threshold', () => {
    const buckets = bucketSeries(
      [r(0, 60), r(5, 40)],
      T0, windowEnd, 10, DEFAULT_THRESHOLDS,
    );
    expect(buckets[0].belowThreshold).toBe(false);
    expect(buckets[5].belowThreshold).toBe(true);
  });

  it('clamps out-of-window readings into edge buckets', () => {
    const buckets = bucketSeries(
      [{ timestamp: T0 - 1000, bpm: 55 }, { timestamp: T0 + 999 * 60_000, bpm: 99 }],
      T0, windowEnd, 10, DEFAULT_THRESHOLDS,
    );
    expect(buckets[0].minBpm).toBe(55);
    expect(buckets[9].maxBpm).toBe(99);
  });
});

describe('computeTrend', () => {
  const reading = (bpm: number) => ({ bpm, timestamp: 0, rrIntervalsMs: [] });

  it('is stable with fewer than 10 readings', () => {
    expect(computeTrend([reading(50), reading(90)])).toBe('stable');
  });

  it('detects rising and falling means beyond the deadband', () => {
    const up = [...Array(5).fill(50), ...Array(5).fill(58)].map(reading);
    const down = [...Array(5).fill(60), ...Array(5).fill(50)].map(reading);
    expect(computeTrend(up)).toBe('rising');
    expect(computeTrend(down)).toBe('falling');
  });

  it('ignores jitter inside the ±2 bpm deadband', () => {
    const flat = [...Array(5).fill(50), ...Array(5).fill(51)].map(reading);
    expect(computeTrend(flat)).toBe('stable');
  });
});

describe('eventBucketIndices', () => {
  it('maps event timestamps to their bucket index', () => {
    const marks = eventBucketIndices(
      [{ type: 'bradycardia', timestamp: T0 + 5.2 * 60_000 }],
      T0, T0 + 10 * 60_000, 10,
    );
    expect(marks.has(5)).toBe(true);
    expect(marks.size).toBe(1);
  });

  it('ignores events outside the window', () => {
    const marks = eventBucketIndices(
      [{ type: 'pause', timestamp: T0 - 60_000, rrIntervalMs: 2000 }],
      T0, T0 + 10 * 60_000, 10,
    );
    expect(marks.size).toBe(0);
  });
});
