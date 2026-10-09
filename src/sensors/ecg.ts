import type { SensorConnectionState } from './types';

/** A chunk of raw ECG samples as delivered by a sensor stream. */
export interface EcgFrame {
  /** Sample values in microvolts. */
  samples: number[];
  /** Stream rate (the H10 ECG is fixed at 130 Hz). */
  sampleRateHz: number;
  /** Host timestamp (ms) of the frame's first sample. */
  timestamp: number;
}

/**
 * Raw-ECG stream source — separate from IHeartRateSensor because the
 * payload is a waveform, not BPM readings. ECG is an on-demand mode:
 * the sentinel monitoring (HR + RR) keeps running on the standard
 * service while this stream is open.
 */
export interface IEcgSource {
  readonly label: string;
  start(): Promise<void>;
  stop(): Promise<void>;
  subscribe(listener: (frame: EcgFrame) => void): () => void;
  onStateChange(listener: (state: SensorConnectionState) => void): () => void;
  /**
   * Optional diagnostic snapshot for on-screen debugging — real-device
   * streams surface negotiated MTU, the last control ack and frame
   * counters here so failures are readable without a debugger.
   */
  getDebugInfo?(): Record<string, string | number>;
}
