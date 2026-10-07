import type { AlertEvent, HRReading } from './models';

/** Number of recent RR intervals used to compute the baseline. */
const BASELINE_WINDOW = 8;
/** Minimum baseline samples before pause detection arms. */
const MIN_BASELINE_SAMPLES = 4;

/**
 * Detects dropped beats from RR intervals — the signature of a
 * non-conducted beat is an RR interval ≈ 2× the running baseline.
 *
 * Pauses are excluded from the baseline so one dropped beat does not
 * corrupt the reference for the next one.
 */
export class PauseDetector {
  private baseline: number[] = [];

  constructor(private readonly rrMultiplier: number) {}

  evaluate(reading: HRReading): AlertEvent | null {
    let event: AlertEvent | null = null;

    for (const rr of reading.rrIntervalsMs) {
      if (this.isArmed() && rr >= this.baselineMean() * this.rrMultiplier) {
        event ??= {
          type: 'pause',
          timestamp: reading.timestamp,
          rrIntervalMs: Math.round(rr),
        };
        // Do not feed the abnormal interval into the baseline.
        continue;
      }
      this.push(rr);
    }

    return event;
  }

  reset(): void {
    this.baseline = [];
  }

  private isArmed(): boolean {
    return this.baseline.length >= MIN_BASELINE_SAMPLES;
  }

  private baselineMean(): number {
    return this.baseline.reduce((sum, v) => sum + v, 0) / this.baseline.length;
  }

  private push(rr: number): void {
    this.baseline.push(rr);
    if (this.baseline.length > BASELINE_WINDOW) this.baseline.shift();
  }
}
