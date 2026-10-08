import type { HRReading } from '@/domain/models';

export type SensorConnectionState =
  | 'idle'
  | 'connecting'
  | 'streaming'
  | 'disconnected'
  | 'reconnecting'
  | 'error';

/** A sensor discovered during a BLE scan. */
export interface ScannedSensor {
  id: string;
  name: string;
}

/**
 * Hardware-agnostic heart-rate source.
 *
 * Implementations:
 *  - `BleHeartRateSensor` — any standard BLE HR device (Garmin broadcast,
 *    Polar/Wahoo/Coospo chest straps…)
 *  - `MockHeartRateSensor` — synthetic stream for demos and tests
 *  - (Phase 4) Polar ECG sensor extending this contract
 *
 * The app only ever talks to this interface, which is what lets one app
 * serve every sensor without code changes.
 */
export interface IHeartRateSensor {
  /** Human-readable label for the connected source. */
  readonly label: string;
  /** Begin streaming readings (connects if needed). */
  start(): Promise<void>;
  /** Stop streaming and release the connection. */
  stop(): Promise<void>;
  /** Subscribe to readings; returns an unsubscribe function. */
  subscribe(listener: (reading: HRReading) => void): () => void;
  /** Subscribe to connection-state changes; returns an unsubscribe function. */
  onStateChange(listener: (state: SensorConnectionState) => void): () => void;
}
