import { activeLowThreshold } from './thresholds';
import type { AlertEvent, HRReading, ThresholdProfile } from './models';

/**
 * Detects *sustained* bradycardia — not momentary dips.
 *
 * State machine:
 *   normal ──(bpm < threshold)──▶ below-threshold
 *   below-threshold ──(≥ sustainedMs elapsed)──▶ emits AlertEvent once
 *   alerted ──(bpm ≥ threshold)──▶ rearms
 *
 * The threshold is passed per-call so day/night contextual floors
 * can switch without resetting detection state.
 */
export class BradycardiaDetector {
  private belowSince: number | null = null;
  private alerted = false;
  private minObservedBpm = Number.POSITIVE_INFINITY;

  constructor(private readonly sustainedMs: number) {}

  evaluate(reading: HRReading, thresholdBpm: number): AlertEvent | null {
    if (reading.bpm < thresholdBpm) {
      this.belowSince ??= reading.timestamp;
      this.minObservedBpm = Math.min(this.minObservedBpm, reading.bpm);

      const durationMs = reading.timestamp - this.belowSince;
      if (!this.alerted && durationMs >= this.sustainedMs) {
        this.alerted = true;
        return {
          type: 'bradycardia',
          timestamp: reading.timestamp,
          bpm: this.minObservedBpm,
          durationMs,
        };
      }
      return null;
    }

    // Recovery above the floor rearms the detector.
    this.belowSince = null;
    this.alerted = false;
    this.minObservedBpm = Number.POSITIVE_INFINITY;
    return null;
  }

  reset(): void {
    this.belowSince = null;
    this.alerted = false;
    this.minObservedBpm = Number.POSITIVE_INFINITY;
  }
}

/**
 * Re-runs sustained-bradycardia detection over a stored reading stream
 * (e.g. readings restored from Health Connect), switching day/night floors
 * per reading timestamp. Returns every event it would have emitted live.
 */
export function detectBradycardiaEvents(
  readings: HRReading[],
  profile: ThresholdProfile,
): AlertEvent[] {
  const detector = new BradycardiaDetector(profile.sustainedMs);
  const found: AlertEvent[] = [];
  for (const reading of readings) {
    const event = detector.evaluate(
      reading,
      activeLowThreshold(profile, new Date(reading.timestamp)),
    );
    if (event) found.push(event);
  }
  return found;
}
