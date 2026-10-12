/**
 * Sleep estimation from heart-rate/RR data alone — no accelerometer.
 *
 * What this honestly derives: roughly when the person fell asleep and
 * woke up (sustained HR drop/recovery), brief awakenings (HR spikes
 * inside the sleep window), and a vagal-tone reading from night RMSSD.
 * It does NOT attempt sleep staging (light/deep/REM) — that needs
 * movement data and even then only guesses; Health Connect can import
 * the watch's own staging for comparison instead.
 */

export interface SleepReading {
  timestamp: number;
  bpm: number;
}

export type VagalTone = 'alto' | 'medio' | 'bajo';

export interface SleepMetrics {
  /** Estimated fall-asleep moment; null when no clear sleep window. */
  estimatedOnsetMs: number | null;
  /** Estimated wake moment; null when no clear sleep window. */
  estimatedWakeMs: number | null;
  /** Time inside the estimated sleep window. */
  asleepMs: number;
  /**
   * Awake episodes inside the sleep window — brief HR elevations long
   * enough to count as a wake-up, not just a roll-over.
   */
  awakenings: number;
  vagalTone: VagalTone | null;
}

const BUCKET_MS = 5 * 60_000;
/** Asleep when the bucket mean sits in the bottom 40% of the session range. */
const ASLEEP_FRACTION = 0.4;
/** Inside the sleep window an awake stretch must last ≥2 buckets to count. */
const MIN_AWAKE_BUCKETS = 2;
/** Need at least this much sleep-window coverage to claim a night. */
const MIN_SLEEP_BUCKETS = 12; // ~1 h

function percentile(sorted: number[], p: number): number {
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * sorted.length)));
  return sorted[i];
}

/**
 * Vagal tone from overnight RMSSD. Anchors: median healthy overnight
 * RMSSD lands ~25-40 ms; above that the parasympathetic brake dominates
 * (the state that makes nocturnal pauses and Wenckebach benign).
 */
export function vagalToneOf(rmssdMs: number | null): VagalTone | null {
  if (rmssdMs === null) return null;
  if (rmssdMs >= 40) return 'alto';
  if (rmssdMs >= 25) return 'medio';
  return 'bajo';
}

export function vagalNote(tone: VagalTone, pauses: number): string {
  switch (tone) {
    case 'alto':
      return pauses > 0
        ? 'tono vagal alto — consistente con pausas nocturnas benignas'
        : 'tono vagal alto — buen freno parasimpático';
    case 'medio':
      return 'tono vagal moderado';
    case 'bajo':
      return pauses > 0
        ? 'tono vagal bajo — las pausas conviene enseñarlas'
        : 'tono vagal bajo';
  }
}

/**
 * Estimates the sleep window of a monitoring session from the HR curve:
 * the longest stretch where the 5-minute mean stays in the lower part of
 * that session's own range. Personal-range anchoring avoids fixed bpm
 * thresholds that break across people.
 */
export function analyzeSleepSession(readings: SleepReading[]): SleepMetrics {
  const none: SleepMetrics = {
    estimatedOnsetMs: null,
    estimatedWakeMs: null,
    asleepMs: 0,
    awakenings: 0,
    vagalTone: null,
  };
  if (readings.length < 60) return none;

  const sorted = [...readings].sort((a, b) => a.timestamp - b.timestamp);
  const start = sorted[0].timestamp;
  const bucketCount = Math.ceil((sorted[sorted.length - 1].timestamp - start) / BUCKET_MS);
  if (bucketCount < MIN_SLEEP_BUCKETS) return none;

  // Average bpm per 5-min bucket; empty buckets mark as -1.
  const sums = new Array<number>(bucketCount).fill(0);
  const counts = new Array<number>(bucketCount).fill(0);
  for (const r of sorted) {
    const i = Math.min(bucketCount - 1, Math.floor((r.timestamp - start) / BUCKET_MS));
    sums[i] += r.bpm;
    counts[i] += 1;
  }
  const bpms = sorted.map((r) => r.bpm).sort((a, b) => a - b);
  const lo = percentile(bpms, 0.1);
  const hi = percentile(bpms, 0.9);
  const asleepMax = lo + (hi - lo) * ASLEEP_FRACTION;

  const asleep = sums.map((s, i) => (counts[i] > 0 ? s / counts[i] <= asleepMax : false));

  const firstAsleep = asleep.indexOf(true);
  const lastAsleep = asleep.lastIndexOf(true);
  if (firstAsleep < 0 || lastAsleep - firstAsleep + 1 < MIN_SLEEP_BUCKETS) {
    return none;
  }
  // A plausible night needs sleep to dominate the span between the first
  // and last asleep buckets — a scattered daytime session fails here.
  let asleepCount = 0;
  for (let i = firstAsleep; i <= lastAsleep; i++) if (asleep[i]) asleepCount += 1;
  if (asleepCount / (lastAsleep - firstAsleep + 1) < 0.5) return none;

  // Onset: the earliest bucket from which sleep dominates the rest of the
  // night (mid-night wake-ups lower the fraction slightly but can't
  // break the run the way run-detection did).
  let onset = -1;
  let counted = 0;
  const suffixFrac: number[] = new Array(bucketCount).fill(0);
  for (let i = lastAsleep; i >= firstAsleep; i--) {
    if (asleep[i]) counted += 1;
    suffixFrac[i] = counted / (lastAsleep - i + 1);
  }
  for (let i = firstAsleep; i <= lastAsleep; i++) {
    if (suffixFrac[i] >= 0.6) {
      onset = i;
      break;
    }
  }
  if (onset < 0 || lastAsleep - onset + 1 < MIN_SLEEP_BUCKETS) return none;

  // Awakenings: awake stretches of ≥2 full buckets inside the window.
  let awakenings = 0;
  let awakeRun = 0;
  for (let i = onset; i <= lastAsleep; i++) {
    if (!asleep[i] && counts[i] > 0) awakeRun += 1;
    else if (awakeRun > 0) {
      if (awakeRun >= MIN_AWAKE_BUCKETS) awakenings += 1;
      awakeRun = 0;
    }
  }
  if (awakeRun >= MIN_AWAKE_BUCKETS) awakenings += 1;

  return {
    estimatedOnsetMs: start + onset * BUCKET_MS,
    estimatedWakeMs: start + (lastAsleep + 1) * BUCKET_MS,
    asleepMs: (lastAsleep - onset + 1) * BUCKET_MS,
    awakenings,
    vagalTone: null, // filled by the caller once RMSSD is known
  };
}
