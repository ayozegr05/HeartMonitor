/**
 * ECG morphology analysis — the "evidence" layer of the H10 milestone.
 *
 * Everything here is observational: flags describe the strip, never a
 * diagnosis. The intended use is "the strip looked like X — show it to
 * your cardiologist", matching the app's not-a-medical-device stance.
 *
 * Pipeline:
 *   1. Band-pass-lite: subtract a wide moving average (kills baseline
 *      wander) then square the first difference (energy envelope).
 *   2. Adaptive-threshold QRS detection with a refractory period.
 *   3. Per beat: QRS width from the energy envelope, P-wave presence
 *      from the pre-QRS window.
 *   4. Rhythm summary: missing-P fraction, mean QRS width, RR
 *      irregularity → observational flags.
 */

export interface EcgBeat {
  /** Sample index of the R peak within the analysed buffer. */
  rIndex: number;
  /** Interval to the previous beat (ms); undefined on the first beat. */
  rrMs?: number;
  /** QRS width measured on the energy envelope (ms). */
  qrsWidthMs: number;
  /** A P-like bump was found in the pre-QRS window. */
  pPresent: boolean;
}

export interface EcgRhythmReport {
  beats: number;
  /** Fraction of beats with no detectable P wave (0..1). */
  pMissingFraction: number;
  meanQrsWidthMs: number;
  /** Coefficient of variation of RR intervals (0 = metronome). */
  rrIrregularity: number;
  /** Mean heart rate across the strip. */
  meanBpm: number;
  /** Observational flags, Spanish strings for the UI. */
  flags: string[];
}

/** Fraction of the mean energy inside the QRS envelope. */
const QRS_EDGE = 0.18;
/** Samples on each side the refractory window blanks. */
const REFRACTORY_MS = 250;
/** Search window (ms before R) that may contain a P wave. */
const P_WINDOW: [number, number] = [-210, -70];

function movingAverage(samples: number[], radius: number): number[] {
  const out = new Array<number>(samples.length);
  // sliding window [i-radius, i+radius], clipped at the edges
  let acc = 0;
  for (let j = 0; j <= Math.min(samples.length - 1, radius); j++) {
    acc += samples[j];
  }
  for (let i = 0; i < samples.length; i++) {
    const lo = Math.max(0, i - radius);
    const hi = Math.min(samples.length - 1, i + radius);
    out[i] = acc / (hi - lo + 1);
    const nLo = Math.max(0, i + 1 - radius);
    const nHi = Math.min(samples.length - 1, i + 1 + radius);
    if (nLo > lo) acc -= samples[lo];
    if (nHi > hi) acc += samples[nHi];
  }
  return out;
}

/**
 * Squared-derivative energy envelope: large exactly where the signal
 * moves fast — the QRS complex stands out from P/T and noise.
 */
function energyEnvelope(samples: number[]): number[] {
  const out = new Array<number>(samples.length).fill(0);
  for (let i = 1; i < samples.length - 1; i++) {
    const d = (samples[i + 1] - samples[i - 1]) / 2;
    out[i] = d * d;
  }
  // smooth with a short box filter (~40 ms at 130 Hz)
  const sm = new Array<number>(samples.length).fill(0);
  const w = Math.max(1, Math.round(samples.length / 1000));
  let acc = 0;
  for (let i = 0; i < samples.length; i++) {
    acc += out[i];
    if (i >= w) acc -= out[i - w];
    sm[i] = acc / Math.min(i + 1, w);
  }
  return sm;
}

function qrsWidthMs(
  centered: number[],
  env: number[],
  r: number,
  rateHz: number,
): number {
  const peak = env[r];
  const edge = peak * QRS_EDGE;
  let a = r;
  while (a > 0 && env[a] > edge) a--;
  let b = r;
  while (b < env.length - 1 && env[b] > edge) b++;
  return ((b - a) / rateHz) * 1000;
}

function pPresent(
  centered: number[],
  r: number,
  rateHz: number,
  noiseFloor: number,
): boolean {
  const a = r + Math.round((P_WINDOW[0] / 1000) * rateHz);
  const b = r + Math.round((P_WINDOW[1] / 1000) * rateHz);
  if (a < 1 || b >= centered.length) return false;
  // A P wave is a rounded positive bump: look for a peak whose
  // prominence above the window's own minima is a few noise floors.
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = Math.max(0, a); i <= Math.min(centered.length - 1, b); i++) {
    if (centered[i] > hi) hi = centered[i];
    if (centered[i] < lo) lo = centered[i];
  }
  return hi - lo > noiseFloor * 4 && hi > 0;
}

/**
 * Analyse a strip of µV samples. Returns the beats found plus a rhythm
 * summary with observational flags.
 */
export function analyzeEcgStrip(
  samples: number[],
  sampleRateHz = 130,
): EcgRhythmReport {
  const beats: EcgBeat[] = [];
  const empty: EcgRhythmReport = {
    beats: 0,
    pMissingFraction: 0,
    meanQrsWidthMs: 0,
    rrIrregularity: 0,
    meanBpm: 0,
    flags: [],
  };
  if (samples.length < sampleRateHz) return empty;

  const det = detectRPeaksDetailed(samples, sampleRateHz);
  const { peaks, centered, env } = det;

  // noise floor from the signal's own small-scale jitter
  let jitter = 0;
  for (let i = 1; i < centered.length; i++) {
    jitter += Math.abs(centered[i] - centered[i - 1]);
  }
  jitter /= Math.max(1, centered.length - 1);

  const rrs: number[] = [];
  let widthSum = 0;
  let pMissing = 0;
  for (let k = 0; k < peaks.length; k++) {
    const r = peaks[k];
    const rrMs = k > 0 ? ((r - peaks[k - 1]) / sampleRateHz) * 1000 : undefined;
    if (rrMs !== undefined) rrs.push(rrMs);
    const w = qrsWidthMs(centered, env, r, sampleRateHz);
    widthSum += w;
    const p = pPresent(centered, r, sampleRateHz, jitter);
    if (!p) pMissing++;
    beats.push({ rIndex: r, rrMs, qrsWidthMs: w, pPresent: p });
  }

  const n = beats.length;
  const meanQrs = n ? widthSum / n : 0;
  const rrMean = rrs.length ? rrs.reduce((a, b) => a + b, 0) / rrs.length : 0;
  let rrSd = 0;
  for (const rr of rrs) rrSd += (rr - rrMean) * (rr - rrMean);
  rrSd = rrs.length ? Math.sqrt(rrSd / rrs.length) : 0;
  const irr = rrMean > 0 ? rrSd / rrMean : 0;
  const pFrac = n ? pMissing / n : 0;
  const meanBpm = rrMean > 0 ? 60_000 / rrMean : 0;

  const flags: string[] = [];
  if (n >= 3 && pFrac >= 0.7) {
    flags.push('posible ausencia de onda P — enseña la tira a tu cardiólogo');
  }
  if (n >= 3 && meanQrs >= 120) {
    flags.push('QRS ancho (>120 ms) — enseña la tira a tu cardiólogo');
  }
  if (rrs.length >= 4 && irr >= 0.15) {
    flags.push('ritmo irregular — posible arritmia, enseña la tira');
  }

  return {
    beats: n,
    pMissingFraction: pFrac,
    meanQrsWidthMs: meanQrs,
    rrIrregularity: irr,
    meanBpm: Math.round(meanBpm * 10) / 10,
    flags,
  };
}

function detectRPeaksDetailed(
  samples: number[],
  rateHz: number,
): { peaks: number[]; centered: number[]; env: number[] } {
  const baseline = movingAverage(samples, Math.round(rateHz * 0.14));
  const centered = samples.map((v, i) => v - baseline[i]);
  const env = energyEnvelope(centered);

  let mean = 0;
  for (const v of env) mean += v;
  mean /= env.length;
  let max = 0;
  for (const v of env) if (v > max) max = v;
  const thr = Math.max(mean * 12, max * 0.25);

  const refractory = Math.round((REFRACTORY_MS / 1000) * rateHz);
  const peaks: number[] = [];
  let last = -refractory - 1;
  for (let i = 1; i < env.length - 1; i++) {
    if (env[i] < thr || i - last <= refractory) continue;
    const span = Math.max(1, Math.round(refractory / 4));
    let best = i;
    for (
      let j = Math.max(1, i - span);
      j <= Math.min(env.length - 2, i + span);
      j++
    ) {
      if (env[j] > env[best]) best = j;
    }
    let r = best;
    const rs = Math.max(1, Math.round(span / 2));
    for (
      let j = Math.max(1, best - rs);
      j <= Math.min(centered.length - 2, best + rs);
      j++
    ) {
      if (Math.abs(centered[j]) > Math.abs(centered[r])) r = j;
    }
    peaks.push(r);
    last = best;
    i = best + refractory;
  }
  return { peaks, centered, env };
}
