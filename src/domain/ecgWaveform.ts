/**
 * Synthetic ECG waveform — pure domain, no timers or sensors. Used by
 * MockEcgSensor for the UI and by tests for the morphology analysis.
 *
 * Morphology (microvolts; each beat's R sits at the cycle boundary, so
 * its left half lives at the end of the previous cycle):
 *   P: +90 µV gaussian at `pOffset` (~170 ms before R by default)
 *   Q: -120 µV at -24 ms · R: +1200 µV σ≈11 ms · S: -260 µV at +30 ms
 *   T: +280 µV broad gaussian at +0.34 of the cycle
 * plus baseline wander and noise so detectors can't cheat on silence.
 *
 * Beat times accumulate per-beat RR intervals (stateful closure —
 * callers stream i monotonically), so 'irregular' jitters real RR
 * spacing instead of warping the phase.
 *
 * Conduction scenarios (AV blocks): a "dropped" beat emits only its P
 * wave — the atrium fires but nothing conducts to the ventricles.
 *   avBlock1   — every beat conducts with PR ≈ 240 ms
 *   wenckebach — PR lengthens each beat (157→198→240 ms), 4th drops
 *   mobitz2    — PR fixed at ~175 ms, every 3rd beat drops
 */
export type EcgScenario =
  | 'normal'
  | 'noP'
  | 'wideQrs'
  | 'irregular'
  | 'avBlock1'
  | 'wenckebach'
  | 'mobitz2';

export interface EcgWaveformOpts {
  scenario?: EcgScenario;
  bpm?: number;
  sampleRateHz?: number;
  /** Deterministic noise seed (tests); defaults to Math.random. */
  noise?: () => number;
}

export function makeEcgWaveform(opts: EcgWaveformOpts = {}): (i: number) => number {
  const scenario = opts.scenario ?? 'normal';
  const bpm = opts.bpm ?? 65;
  const rate = opts.sampleRateHz ?? 130;
  const noise = opts.noise ?? Math.random;
  const periodSamples = (rate * 60) / bpm;

  /** RR length (samples) for beat k — irregular jitters ±25% per beat. */
  const rrOf = (k: number): number =>
    scenario === 'irregular'
      ? periodSamples * (1 + 0.25 * Math.sin(k * 1.7))
      : periodSamples;

  // Beat start positions (samples), extended lazily as i advances.
  const beatStart: number[] = [0];
  let lo = 0; // memoised lower bound for the binary search

  return (i: number): number => {
    while (beatStart[beatStart.length - 1] <= i) {
      beatStart.push(beatStart[beatStart.length - 1] + rrOf(beatStart.length - 1));
    }
    // largest m with beatStart[m] <= i (i is monotonically increasing)
    if (beatStart[lo + 1] <= i) {
      let hi = beatStart.length - 1;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (beatStart[mid] <= i) lo = mid;
        else hi = mid;
      }
    }
    const m = lo;
    const rr = beatStart[m + 1] - beatStart[m];
    const phase = (i - beatStart[m]) / rr;
    // wrap-around phase keeps waveforms near the beat edge smooth
    const ph = phase > 0.5 ? phase - 1 : phase;
    // Waves at negative phase (the tail of cycle m, approaching the
    // boundary) belong to beat m+1; waves at positive phase to beat m.
    // A dropped beat suppresses QRS on both sides of its boundary.
    const beat = ph < 0 ? m + 1 : m;
    const gauss = (c: number, w: number) =>
      Math.exp(-((ph - c) * (ph - c)) / (2 * w * w));

    let v = 8 * Math.sin(i / (rate * 2.3)); // baseline wander
    v += (noise() - 0.5) * 14;

    // P position (negative phase = ms before R as a fraction of the cycle)
    // and whether this beat's impulse fails to conduct.
    let pOffset = -0.17;
    let dropped = false;
    if (scenario === 'avBlock1') {
      pOffset = -0.26; // PR ≈ 240 ms at 65 bpm
    } else if (scenario === 'wenckebach') {
      const b = beat % 4;
      pOffset = -0.17 - 0.045 * b; // PR 157 → 198 → 240 ms, then a drop
      dropped = b === 3;
    } else if (scenario === 'mobitz2') {
      pOffset = -0.19; // constant PR ≈ 175 ms
      dropped = beat % 3 === 2;
    }

    if (scenario !== 'noP') v += 90 * gauss(pOffset, 0.028);
    if (dropped) return v; // P aislada: se ve la aurícula, no hay QRS

    const wide = scenario === 'wideQrs' ? 2.6 : 1;
    v += -120 * gauss(-0.024 * wide, 0.008 * wide);
    v += 1200 * gauss(0, 0.011 * wide);
    v += -260 * gauss(0.03 * wide, 0.011 * wide);
    v += 280 * gauss(0.34, 0.055);
    return v;
  };
}
