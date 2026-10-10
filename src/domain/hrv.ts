/**
 * Heart-rate variability — RMSSD (root mean square of successive RR
 * differences). Computable only when the sensor sends real RR
 * intervals: a chest strap (Polar H10) or ECG-derived beats — the
 * Garmin optical broadcast does not provide them.
 *
 * Night RMSSD is a useful recovery/stress proxy for the reports; the
 * absolute value depends on artifact handling, so we median-filter
 * the interval list first (one bad RR otherwise dominates).
 */
export function rmssd(rrIntervalsMs: number[]): number {
  const diffs: number[] = [];
  for (let i = 1; i < rrIntervalsMs.length; i++) {
    diffs.push(rrIntervalsMs[i] - rrIntervalsMs[i - 1]);
  }
  if (diffs.length === 0) return 0;
  let acc = 0;
  for (const d of diffs) acc += d * d;
  return Math.sqrt(acc / diffs.length);
}

/** Median-filter obvious artifacts before computing RMSSD. */
export function cleanRrIntervals(
  rrs: number[],
  minMs = 300,
  maxMs = 3000,
): number[] {
  const out: number[] = [];
  for (const rr of rrs) {
    if (rr >= minMs && rr <= maxMs) out.push(rr);
  }
  return out;
}

/** RMSSD over a reading stream: all RR intervals concatenated. */
export function sessionRmssd(
  readings: { rrIntervalsMs: number[] }[],
): number {
  const all: number[] = [];
  for (const r of readings) {
    for (const rr of r.rrIntervalsMs) all.push(rr);
  }
  return rmssd(cleanRrIntervals(all));
}
