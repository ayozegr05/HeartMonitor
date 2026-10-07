import type { AlertEvent, HRReading } from './models';

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
