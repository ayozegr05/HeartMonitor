import { PauseDetector } from '../pauseDetection';
import type { HRReading } from '../models';

const reading = (rrIntervalsMs: number[], timestamp = 0): HRReading => ({
  bpm: 60,
  rrIntervalsMs,
  timestamp,
});

/** Feed the detector with a stable ~1000 ms rhythm (60 bpm). */
function warmUp(d: PauseDetector) {
  d.evaluate(reading([1000, 1000, 1000, 1000]));
}

describe('PauseDetector', () => {
  it('stays silent on a regular rhythm', () => {
    const d = new PauseDetector(1.8);
    expect(d.evaluate(reading([1000, 1010, 990, 1005]))).toBeNull();
    expect(d.evaluate(reading([1000, 1020, 980]))).toBeNull();
  });

  it('waits for a baseline before judging', () => {
    const d = new PauseDetector(1.8);
    // A doubled interval without enough baseline cannot be classified.
    expect(d.evaluate(reading([2000]))).toBeNull();
  });

  it('detects a dropped beat (RR ≈ 2× baseline)', () => {
    const d = new PauseDetector(1.8);
    warmUp(d);
    const event = d.evaluate(reading([2050], 10_000));

    expect(event).not.toBeNull();
    expect(event?.type).toBe('pause');
    expect(event?.rrIntervalMs).toBe(2050);
  });

  it('does not let a pause corrupt the baseline', () => {
    const d = new PauseDetector(1.8);
    warmUp(d);
    d.evaluate(reading([2050]));
    // After the pause, baseline is still ~1000 → another pause is caught.
    const event = d.evaluate(reading([1980]));
    expect(event).not.toBeNull();
  });
});
