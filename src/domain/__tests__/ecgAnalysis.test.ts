import { analyzeEcgStrip } from '@/domain/ecgAnalysis';
import { makeEcgWaveform } from '@/domain/ecgWaveform';

function strip(scenario: 'normal' | 'noP' | 'wideQrs' | 'irregular', secs = 10) {
  const f = makeEcgWaveform({ scenario, noise: () => 0.5 });
  const n = Math.round(130 * secs);
  const samples: number[] = [];
  for (let i = 0; i < n; i++) samples.push(f(i));
  return samples;
}

describe('analyzeEcgStrip', () => {
  it('finds ~65 bpm on a normal strip', () => {
    const r = analyzeEcgStrip(strip('normal'));
    expect(r.beats).toBeGreaterThanOrEqual(9);
    expect(r.meanBpm).toBeGreaterThan(58);
    expect(r.meanBpm).toBeLessThan(72);
    expect(r.flags).toHaveLength(0);
  });

  it('flags missing P waves on a junctional rhythm', () => {
    const r = analyzeEcgStrip(strip('noP'));
    expect(r.pMissingFraction).toBeGreaterThanOrEqual(0.7);
    expect(r.flags.join(' ')).toContain('onda P');
  });

  it('flags a wide QRS', () => {
    const r = analyzeEcgStrip(strip('wideQrs'));
    expect(r.meanQrsWidthMs).toBeGreaterThan(120);
    expect(r.flags.join(' ')).toContain('QRS ancho');
  });

  it('flags an irregular rhythm', () => {
    const r = analyzeEcgStrip(strip('irregular'));
    expect(r.rrIrregularity).toBeGreaterThanOrEqual(0.15);
    expect(r.flags.join(' ')).toContain('irregular');
  });

  it('sees P waves on a normal strip (control)', () => {
    const r = analyzeEcgStrip(strip('normal'));
    expect(r.pMissingFraction).toBeLessThan(0.5);
    expect(r.meanQrsWidthMs).toBeLessThan(120);
    expect(r.rrIrregularity).toBeLessThan(0.15);
  });

  it('returns an empty report on too-short input', () => {
    const r = analyzeEcgStrip([1, 2, 3, 4]);
    expect(r.beats).toBe(0);
    expect(r.flags).toHaveLength(0);
  });
});
