/**
 * Core domain models for HeartMonitor.
 *
 * These types are pure data — no React Native, no BLE, no DB dependencies.
 * Everything in `src/domain` must remain platform-agnostic and unit-testable.
 */

/** A single heart-rate sample emitted by any sensor. */
export interface HRReading {
  /** Beats per minute. */
  bpm: number;
  /**
   * Beat-to-beat intervals in milliseconds, when the sensor provides them
   * (ECG-grade on chest straps, optical-derived on wrist sensors).
   */
  rrIntervalsMs: number[];
  /** Unix timestamp (ms) at which the reading was produced. */
  timestamp: number;
}

export type AlertEventType = 'bradycardia' | 'pause';

/** A clinically-relevant event detected from the reading stream. */
export interface AlertEvent {
  type: AlertEventType;
  /** Unix timestamp (ms) when the event was confirmed. */
  timestamp: number;
  /** BPM observed at detection (bradycardia events). */
  bpm?: number;
  /** How long the condition had been sustained before alerting (ms). */
  durationMs?: number;
  /** The abnormal RR interval that triggered a pause event (ms). */
  rrIntervalMs?: number;
}

/**
 * Context-aware alert thresholds. Bradycardia during deep sleep is
 * physiologically normal, so the night floor is stricter than the day one.
 */
export interface ThresholdProfile {
  /** Alert floor (bpm) while awake. */
  dayLowBpm: number;
  /** Alert floor (bpm) during the configured sleep window. */
  nightLowBpm: number;
  /** How long HR must stay below the floor before alerting (ms). */
  sustainedMs: number;
  /** RR interval ÷ baseline above which a beat counts as a dropped beat. */
  pauseRrMultiplier: number;
}

export const DEFAULT_THRESHOLDS: ThresholdProfile = {
  dayLowBpm: 45,
  nightLowBpm: 35,
  sustainedMs: 30_000,
  pauseRrMultiplier: 1.8,
};
