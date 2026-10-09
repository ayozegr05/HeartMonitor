import { classifyPauseEvent } from '@/domain/ecgAnalysis';
import { makeEcgWaveform } from '@/domain/ecgWaveform';

const FS = 130;

function strip(
  scenario: 'normal' | 'mobitz2' | 'wenckebach',
  secs = 15,
): number[] {
  const f = makeEcgWaveform({ scenario, noise: () => 0.5 });
  const n = Math.round(FS * secs);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(f(i));
  return samples;
}

/** Flat-gap pause: normal beats, then ~2 s of baseline, then beats. */
function sinusPauseStrip(): number[] {
  const normal = strip('normal', 6);
  const gap = new Array<number>(Math.round(FS * 2.2)).fill(0);
  const tail = strip('normal', 5);
  return [...normal, ...gap, ...tail];
}

/**
 * Extrasystole — stamped deterministically: normal beats at 0.9 s RR,
 * then a premature WIDE QRS at ~0.55 RR (no P, ~160 ms wide) and a
 * compensatory pause before the next normal beat.
 */
function prematureStrip(): number[] {
  const secs = 8;
  const samples = new Array<number>(Math.round(FS * secs)).fill(0);
  const gauss = (centerSec: number, amp: number, widthSec: number) => {
    const c = centerSec * FS;
    const r = Math.round(widthSec * FS * 5);
    for (let i = Math.max(0, Math.round(c - r)); i < Math.min(samples.length, Math.round(c + r)); i++) {
      const t = (i - c) / FS;
      samples[i] += amp * Math.exp(-(t * t) / (2 * widthSec * widthSec));
    }
  };
  const normalBeat = (t: number) => {
    gauss(t - 0.16, 90, 0.03); // P
    gauss(t - 0.03, -120, 0.01); // Q
    gauss(t, 1200, 0.011); // R
    gauss(t + 0.03, -260, 0.012); // S
    gauss(t + 0.32, 280, 0.05); // T
  };
  // Normal beats at ~0.9 s RR
  for (const t of [0.9, 1.8, 2.7]) normalBeat(t);
  // Premature wide QRS at 3.25 (RR 0.55 → < 0.8 × 0.9)
  gauss(3.25 - 0.06, -120, 0.025);
  gauss(3.25, 1400, 0.05); // ~120 ms+ wide R
  gauss(3.25 + 0.09, -300, 0.04);
  // Compensatory pause: next normal beat at 5.0 (gap 1.75 s > 1.6×0.9)
  for (const t of [5.0, 5.9, 6.8]) normalBeat(t);
  return samples;
}

describe('classifyPauseEvent', () => {
  it('labels a lone-P gap as a blocked beat (Mobitz II)', () => {
    const r = classifyPauseEvent(strip('mobitz2'), FS);
    expect(r.kind).toBe('blocked');
    expect(r.gapMs).toBeGreaterThan(1400);
  });

  it('labels a flat gap as a sinus pause', () => {
    const r = classifyPauseEvent(sinusPauseStrip(), FS);
    expect(r.kind).toBe('sinus');
    expect(r.gapMs).toBeGreaterThan(1800);
  });

  it('labels a premature wide beat + pause as extrasystole', () => {
    const r = classifyPauseEvent(prematureStrip(), FS);
    expect(r.kind).toBe('premature');
    expect(r.gapMs).toBeGreaterThan(1000);
  });

  it('reports none on a normal strip', () => {
    const r = classifyPauseEvent(strip('normal'), FS);
    expect(r.kind).toBe('none');
  });

  it('reports none on too-short input', () => {
    expect(classifyPauseEvent([0, 1, 2], FS).kind).toBe('none');
  });
});
