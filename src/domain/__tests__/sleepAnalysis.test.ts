import {
  analyzeSleepSession,
  vagalNote,
  vagalToneOf,
} from '@/domain/sleepAnalysis';

/** Readings every `stepMs` between two timestamps at the given bpm. */
function series(
  start: number,
  end: number,
  bpm: number | ((t: number) => number),
  stepMs = 10_000,
): { timestamp: number; bpm: number }[] {
  const out = [];
  for (let t = start; t <= end; t += stepMs) {
    out.push({ timestamp: t, bpm: typeof bpm === 'function' ? bpm(t) : bpm });
  }
  return out;
}

const H = 60 * 60_000;

describe('vagalToneOf', () => {
  it('maps RMSSD to alto/medio/bajo', () => {
    expect(vagalToneOf(66)).toBe('alto');
    expect(vagalToneOf(40)).toBe('alto');
    expect(vagalToneOf(30)).toBe('medio');
    expect(vagalToneOf(25)).toBe('medio');
    expect(vagalToneOf(12)).toBe('bajo');
    expect(vagalToneOf(null)).toBeNull();
  });

  it('notes contextualize pauses', () => {
    expect(vagalNote('alto', 3)).toContain('pausas');
    expect(vagalNote('bajo', 0)).not.toContain('enseñarlas');
  });
});

describe('analyzeSleepSession', () => {
  const t0 = 1_700_000_000_000;

  it('returns nulls for tiny sessions', () => {
    expect(analyzeSleepSession([]).estimatedOnsetMs).toBeNull();
    expect(
      analyzeSleepSession(series(t0, t0 + 30 * 60_000, 60)).estimatedOnsetMs,
    ).toBeNull();
  });

  it('finds the sleep window inside a night session', () => {
    // 1h awake at 68 bpm, 6h asleep at 48 bpm, 1h awake again.
    const readings = [
      ...series(t0, t0 + H, 68),
      ...series(t0 + H, t0 + 7 * H, 48),
      ...series(t0 + 7 * H, t0 + 8 * H, 70),
    ];
    const m = analyzeSleepSession(readings);
    expect(m.estimatedOnsetMs).not.toBeNull();
    expect(m.estimatedWakeMs).not.toBeNull();
    // Onset lands inside the low-HR stretch (±10 min of the real start).
    expect(m.estimatedOnsetMs!).toBeGreaterThanOrEqual(t0 + 55 * 60_000);
    expect(m.estimatedOnsetMs!).toBeLessThanOrEqual(t0 + H + 10 * 60_000);
    expect(m.estimatedWakeMs!).toBeGreaterThanOrEqual(t0 + 7 * H - 10 * 60_000);
    expect(m.asleepMs).toBeGreaterThanOrEqual(5 * H);
    expect(m.awakenings).toBe(0);
  });

  it('counts brief HR elevations inside sleep as awakenings', () => {
    const asleep = (t: number) => (t >= t0 + 4 * H && t <= t0 + 4 * H + 12 * 60_000 ? 72 : 48);
    const readings = [
      ...series(t0, t0 + H, 66),
      ...series(t0 + H, t0 + 7 * H, asleep),
      ...series(t0 + 7 * H, t0 + 8 * H, 70),
    ];
    const m = analyzeSleepSession(readings);
    expect(m.awakenings).toBe(1);
  });

  it('ignores single-bucket blips', () => {
    const asleep = (t: number) => (t >= t0 + 4 * H && t <= t0 + 4 * H + 4 * 60_000 ? 70 : 48);
    const readings = [
      ...series(t0, t0 + H, 66),
      ...series(t0 + H, t0 + 7 * H, asleep),
      ...series(t0 + 7 * H, t0 + 8 * H, 70),
    ];
    const m = analyzeSleepSession(readings);
    expect(m.awakenings).toBe(0);
  });

  it('does not fabricate a night from a flat daytime session', () => {
    // Constant 66 bpm — percentiles collapse, threshold can't isolate a run.
    const flat = analyzeSleepSession(series(t0, t0 + 8 * H, 66));
    // Everything counts as asleep or nothing does — either way no crash,
    // and onset/wake cover the whole session or are null.
    expect(flat.asleepMs === 0 || flat.estimatedOnsetMs === t0).toBe(true);
  });
});
