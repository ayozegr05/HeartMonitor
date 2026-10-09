import { removeBaselineWander } from '@/domain/ecgFilter';

const FS = 130;

describe('removeBaselineWander', () => {
  it('flattens a slow drift while keeping fast spikes', () => {
    // Slow ramp (baseline wander) + one fast spike (an R peak).
    const n = FS * 4;
    const samples = Array.from({ length: n }, (_, i) => i * 2); // ramp
    samples[n >> 1] += 1000; // spike
    const out = removeBaselineWander(samples, FS);
    // Near the spike the output still shows ~the spike amplitude.
    expect(Math.abs(out[n >> 1])).toBeGreaterThan(800);
    // Far from the spike, residual baseline is tiny.
    expect(Math.abs(out[Math.round(n * 0.1)])).toBeLessThan(20);
    expect(Math.abs(out[Math.round(n * 0.9)])).toBeLessThan(20);
  });

  it('removes a sinusoidal respiratory wander', () => {
    const n = FS * 10;
    const samples = Array.from(
      { length: n },
      (_, i) => 300 * Math.sin((2 * Math.PI * i) / (FS * 4)), // 0.25 Hz
    );
    const out = removeBaselineWander(samples, FS);
    // The clipped window at the array edges is biased — measure the
    // interior, which is what the strip shows mid-buffer.
    const inner = out.slice(Math.round(n * 0.2), Math.round(n * 0.8));
    const residual = inner.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
    expect(residual).toBeLessThan(40);
  });

  it('returns empty for empty input', () => {
    expect(removeBaselineWander([], FS)).toEqual([]);
  });
});
