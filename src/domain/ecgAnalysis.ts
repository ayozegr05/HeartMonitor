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
 *   3. Per beat: QRS width from the energy envelope, P-wave position
 *      (and PR interval) from the smoothed pre-QRS window.
 *   4. Gap analysis: an RR > 1.6× the median is a pause — if a lone P
 *      wave sits inside it, the beat was blocked, not skipped.
 *   5. Rhythm summary: missing-P fraction, mean QRS width, RR
 *      irregularity, mean PR, conduction pattern → observational flags
 *      (prolonged PR / Wenckebach / Mobitz II / sinus pause).
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
  /** Sample index of the P peak when found. */
  pIndex?: number;
  /** PR interval (ms) when a P was found — atrial→ventricular delay. */
  prMs?: number;
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
  /** Mean PR interval across conducted beats; undefined if no P found. */
  meanPrMs?: number;
  /** Pauses containing a lone P wave = blocked (non-conducted) beats. */
  droppedBeats: number;
  /** Observational flags, Spanish strings for the UI. */
  flags: string[];
}

/** Fraction of the mean energy inside the QRS envelope. */
const QRS_EDGE = 0.18;
/** Samples on each side the refractory window blanks. */
const REFRACTORY_MS = 250;
/** Search window (ms before R) that may contain a P wave. The long
 *  -320 ms edge catches first-degree-block PRs (>200 ms); the start is
 *  clamped to 45% of the RR so the previous T can't bleed in. */
const P_WINDOW: [number, number] = [-320, -70];
/** An RR longer than this multiple of the median is a pause (a single
 *  blocked beat doubles the gap; benign variability stays under ~1.7). */
const PAUSE_RATIO = 1.9;
/** 1st-degree AV block threshold. */
const LONG_PR_MS = 200;
/** PR step between consecutive beats that counts as progression. */
const PR_PROGRESSION_MS = 15;

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

/**
 * Find a P-wave bump inside [a, b] on the smoothed signal: the highest
 * peak whose prominence above both side minima clears the noise floor.
 * Returns the sample index or -1.
 */
function findBump(
  sm: number[],
  a: number,
  b: number,
  noiseFloor: number,
): number {
  const lo = Math.max(1, a);
  const hi = Math.min(sm.length - 2, b);
  if (hi <= lo) return -1;
  let pk = lo;
  for (let i = lo; i <= hi; i++) if (sm[i] > sm[pk]) pk = i;
  if (sm[pk] <= 0) return -1;
  let minL = Infinity;
  for (let i = lo; i <= pk; i++) if (sm[i] < minL) minL = sm[i];
  let minR = Infinity;
  for (let i = pk; i <= hi; i++) if (sm[i] < minR) minR = sm[i];
  const prominence = sm[pk] - Math.max(minL, minR);
  return prominence > noiseFloor * 4 ? pk : -1;
}

/**
 * Locate the P wave before beat `r`. Searches [-320, -70] ms, clamped
 * to the nearest 45% of the RR so the previous T wave can't be picked
 * up as a P at high rates.
 */
function detectP(
  sm: number[],
  r: number,
  rateHz: number,
  noiseFloor: number,
  rrMs?: number,
): number {
  let a = r + Math.round((P_WINDOW[0] / 1000) * rateHz);
  const b = r + Math.round((P_WINDOW[1] / 1000) * rateHz);
  if (rrMs !== undefined) {
    a = Math.max(a, r - Math.round(((rrMs * 0.45) / 1000) * rateHz));
  }
  return findBump(sm, a, b, noiseFloor);
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
    droppedBeats: 0,
    flags: [],
  };
  if (samples.length < sampleRateHz) return empty;

  const det = detectRPeaksDetailed(samples, sampleRateHz);
  const { peaks, centered, env } = det;

  // Mild smoothing for P-wave work (3 samples ≈ 23 ms at 130 Hz — keeps
  // the ~50 ms P bump, halves the per-sample noise).
  const sm = movingAverage(centered, 1);
  // noise floor: MEDIAN |sample-to-sample| of the smoothed signal —
  // robust, so the huge QRS slopes can't inflate it
  const diffs: number[] = [];
  for (let i = 1; i < sm.length; i++) {
    diffs.push(Math.abs(sm[i] - sm[i - 1]));
  }
  diffs.sort((a, b) => a - b);
  const jitter = diffs.length ? diffs[Math.floor(diffs.length / 2)] : 0;

  const rrs: number[] = [];
  let widthSum = 0;
  let pMissing = 0;
  for (let k = 0; k < peaks.length; k++) {
    const r = peaks[k];
    const rrMs = k > 0 ? ((r - peaks[k - 1]) / sampleRateHz) * 1000 : undefined;
    if (rrMs !== undefined) rrs.push(rrMs);
    const w = qrsWidthMs(centered, env, r, sampleRateHz);
    widthSum += w;
    const pIdx = detectP(sm, r, sampleRateHz, jitter, rrMs);
    if (pIdx < 0) pMissing++;
    beats.push({
      rIndex: r,
      rrMs,
      qrsWidthMs: w,
      pPresent: pIdx >= 0,
      pIndex: pIdx >= 0 ? pIdx : undefined,
      prMs: pIdx >= 0 ? ((r - pIdx) / sampleRateHz) * 1000 : undefined,
    });
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

  const prs = beats
    .map((b) => b.prMs)
    .filter((v): v is number => v !== undefined);
  const meanPr = prs.length
    ? prs.reduce((a, b) => a + b, 0) / prs.length
    : undefined;

  // --- pause analysis: is there a lone P inside each long gap? ---
  const sortedRrs = [...rrs].sort((a, b) => a - b);
  const medianRr = sortedRrs.length
    ? sortedRrs[Math.floor(sortedRrs.length / 2)]
    : 0;
  const medianRrSamples = (medianRr / 1000) * sampleRateHz;
  let droppedBeats = 0;
  let sinusPauses = 0;
  let wenckebachVotes = 0;
  let mobitzVotes = 0;
  for (let k = 1; k < beats.length; k++) {
    const rr = beats[k].rrMs ?? 0;
    if (medianRr <= 0 || rr < medianRr * PAUSE_RATIO) continue;
    // scan the middle of the gap: after the previous T wave, but stop
    // before the next beat's own P window so a conducted P can't be
    // mistaken for a non-conducted one
    const a = peaks[k - 1] + Math.round(medianRrSamples * 0.55);
    const b =
      peaks[k] + Math.round((P_WINDOW[0] / 1000) * sampleRateHz) - 2;
    if (findBump(sm, a, b, jitter) >= 0) {
      droppedBeats++;
      // How did the PRs behave in the run-up to this blocked beat?
      const seq: number[] = [];
      for (let j = k - 1; j >= 0 && seq.length < 3; j--) {
        if (beats[j].prMs !== undefined) seq.unshift(beats[j].prMs!);
      }
      if (seq.length >= 2) {
        let progressive = true;
        let constant = true;
        for (let j = 1; j < seq.length; j++) {
          if (seq[j] - seq[j - 1] < PR_PROGRESSION_MS) progressive = false;
          if (Math.abs(seq[j] - seq[j - 1]) > PR_PROGRESSION_MS) {
            constant = false;
          }
        }
        if (progressive) wenckebachVotes++;
        else if (constant) mobitzVotes++;
      }
    } else {
      sinusPauses++;
    }
  }

  const flags: string[] = [];
  if (n >= 3 && pFrac >= 0.7) {
    flags.push('posible ausencia de onda P — enseña la tira a tu cardiólogo');
  }
  if (n >= 3 && meanQrs >= 120) {
    flags.push('QRS ancho (>120 ms) — enseña la tira a tu cardiólogo');
  }
  if (
    meanPr !== undefined &&
    meanPr > LONG_PR_MS &&
    droppedBeats === 0
  ) {
    flags.push(
      'PR prolongado (>200 ms) — posible bloqueo AV de 1er grado, enseña la tira',
    );
  }
  if (droppedBeats > 0) {
    if (wenckebachVotes > mobitzVotes) {
      flags.push(
        'PR cada vez más largo + latido bloqueado — patrón compatible con Mobitz I (Wenckebach), enseña la tira',
      );
    } else {
      flags.push(
        'latidos bloqueados con PR constante — patrón compatible con Mobitz II, enseña la tira',
      );
    }
  }
  if (sinusPauses > 0) {
    flags.push(
      'pausas sin onda P — probable pausa sinusal (frecuente dormido), enseña la tira',
    );
  }
  if (rrs.length >= 4 && irr >= 0.15 && droppedBeats === 0) {
    flags.push('ritmo irregular — posible arritmia, enseña la tira');
  }

  return {
    beats: n,
    pMissingFraction: pFrac,
    meanQrsWidthMs: meanQrs,
    rrIrregularity: irr,
    meanBpm: Math.round(meanBpm * 10) / 10,
    meanPrMs: meanPr !== undefined ? Math.round(meanPr) : undefined,
    droppedBeats,
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
