/**
 * Baseline-wander removal for the H10's raw µV stream.
 *
 * A chest strap picks up respiration and electrode drift as a slow
 * (~0.1-0.3 Hz) baseline swing — that is the "inclined" look between
 * beats that hospital ECGs remove with a high-pass filter. Subtracting
 * a slow moving average is the same trick, cheap enough to run on
 * every repaint: the beat morphology (P, QRS, T — all above ~1 Hz)
 * passes through untouched.
 *
 * Pure domain code — no RN dependencies, unit-testable.
 */

/**
 * Returns `samples` minus its slow moving average.
 *
 * @param windowMs length of the averaging window; ~600 ms tracks the
 *   respiratory swing without eating the T wave.
 */
export function removeBaselineWander(
  samples: number[],
  sampleRateHz: number,
  windowMs = 600,
): number[] {
  const n = samples.length;
  if (n === 0) return [];
  const radius = Math.max(1, Math.round((windowMs / 1000) * sampleRateHz / 2));

  // Prefix sums → O(n) box filter; the running sum trick from
  // movingAverage would also work, this version is easier to read.
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i] + samples[i];

  const out = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(n, i + radius + 1);
    const mean = (prefix[hi] - prefix[lo]) / (hi - lo);
    out[i] = samples[i] - mean;
  }
  return out;
}
