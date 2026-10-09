/**
 * Synthetic ECG waveform — pure domain, no timers or sensors. Used by
 * MockEcgSensor for the UI and by tests for the morphology analysis.
 *
 * Morphology (microvolts, phase 0..1 of each beat, R at phase 0):
 *   P: +90 µV gaussian centred at -0.17 (~170 ms before R)
 *   Q: -120 µV at -24 ms · R: +1200 µV σ≈11 ms · S: -260 µV at +30 ms
 *   T: +280 µV broad gaussian at +0.34
 * plus baseline wander and noise so detectors can't cheat on silence.
 */
export type EcgScenario = 'normal' | 'noP' | 'wideQrs' | 'irregular';

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

  return (i: number): number => {
    let period = periodSamples;
    if (scenario === 'irregular') {
      // ±25% wobble — chaotic enough to trip a regularity check.
      period = periodSamples * (1 + 0.25 * Math.sin(i / (rate * 0.9)));
    }
    const phase = (i % period) / period;
    // wrap-around phase keeps waveforms near the beat edge smooth
    const ph = phase > 0.5 ? phase - 1 : phase;
    const gauss = (c: number, w: number) =>
      Math.exp(-((ph - c) * (ph - c)) / (2 * w * w));

    let v = 8 * Math.sin(i / (rate * 2.3)); // baseline wander
    v += (noise() - 0.5) * 14;

    const wide = scenario === 'wideQrs' ? 2.6 : 1;
    if (scenario !== 'noP') v += 90 * gauss(-0.17, 0.028);
    v += -120 * gauss(-0.024 * wide, 0.008 * wide);
    v += 1200 * gauss(0, 0.011 * wide);
    v += -260 * gauss(0.03 * wide, 0.011 * wide);
    v += 280 * gauss(0.34, 0.055);
    return v;
  };
}
