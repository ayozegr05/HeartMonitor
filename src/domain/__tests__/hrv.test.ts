import { cleanRrIntervals, rmssd, sessionRmssd } from '@/domain/hrv';

describe('rmssd', () => {
  it('is 0 on a metronome', () => {
    expect(rmssd([900, 900, 900, 900])).toBe(0);
  });

  it('computes root-mean-square of successive diffs', () => {
    // diffs: +10, -10, +10 → ms² mean = 100 → 10
    expect(rmssd([900, 910, 900, 910])).toBeCloseTo(10, 5);
  });

  it('returns 0 with fewer than 2 intervals', () => {
    expect(rmssd([])).toBe(0);
    expect(rmssd([800])).toBe(0);
  });
});

describe('cleanRrIntervals', () => {
  it('drops physiological impossibles', () => {
    expect(cleanRrIntervals([50, 900, 950, 20000])).toEqual([900, 950]);
  });
});

describe('sessionRmssd', () => {
  it('concatenates intervals across readings', () => {
    const readings = [
      { rrIntervalsMs: [900, 910] },
      { rrIntervalsMs: [900] },
      { rrIntervalsMs: [] },
    ];
    expect(sessionRmssd(readings)).toBeCloseTo(10, 5);
  });
});
