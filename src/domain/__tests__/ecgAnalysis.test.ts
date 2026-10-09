import { analyzeEcgStrip } from '@/domain/ecgAnalysis';
import { makeEcgWaveform, type EcgScenario } from '@/domain/ecgWaveform';

function strip(scenario: EcgScenario, secs = 10) {
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

  it('measures PR and flags first-degree block when it exceeds 200 ms', () => {
    const r = analyzeEcgStrip(strip('avBlock1'));
    expect(r.meanPrMs).toBeGreaterThan(200);
    expect(r.droppedBeats).toBe(0);
    expect(r.flags.join(' ')).toContain('1er grado');
  });

  it('flags Wenckebach: progressive PR before a blocked beat', () => {
    const r = analyzeEcgStrip(strip('wenckebach'));
    expect(r.droppedBeats).toBeGreaterThanOrEqual(1);
    expect(r.flags.join(' ')).toContain('Mobitz I');
  });

  it('flags Mobitz II: constant PR before a blocked beat', () => {
    const r = analyzeEcgStrip(strip('mobitz2'));
    expect(r.droppedBeats).toBeGreaterThanOrEqual(1);
    expect(r.flags.join(' ')).toContain('Mobitz II');
  });

  it('sees a normal PR on a normal strip', () => {
    const r = analyzeEcgStrip(strip('normal'));
    expect(r.droppedBeats).toBe(0);
    expect(r.meanPrMs).toBeGreaterThan(80);
    expect(r.meanPrMs).toBeLessThan(220);
  });

  it('returns an empty report on too-short input', () => {
    const r = analyzeEcgStrip([1, 2, 3, 4]);
    expect(r.beats).toBe(0);
    expect(r.flags).toHaveLength(0);
  });
});
