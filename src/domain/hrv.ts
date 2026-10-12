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

/**
 * Extracts every RR interval from a readings stream, tolerating the
 * column arriving as a JSON string (raw rows) or an already-parsed array.
 */
export function rrIntervalsFromReadings(
  readings: { rrIntervalsMs?: unknown }[],
): number[] {
  const out: number[] = [];
  for (const r of readings) {
    let v = r.rrIntervalsMs;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        continue;
      }
    }
    if (Array.isArray(v)) {
      for (const rr of v) if (typeof rr === 'number') out.push(rr);
    }
  }
  return out;
}

/** Rounded RMSSD (ms) for a readings stream, or null with too few RRs. */
export function rmssdOfReadings(
  readings: { rrIntervalsMs?: unknown }[],
): number | null {
  const rrs = rrIntervalsFromReadings(readings);
  return rrs.length >= 2 ? Math.round(rmssd(cleanRrIntervals(rrs))) : null;
}
