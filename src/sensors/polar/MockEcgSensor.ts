import { makeEcgWaveform, type EcgScenario } from '@/domain/ecgWaveform';

import type { EcgFrame, IEcgSource } from '../ecg';
import type { SensorConnectionState } from '../types';

export type { EcgScenario as MockEcgScenario };

export const MOCK_ECG_SCENARIO_LABELS: Record<EcgScenario, string> = {
  normal: 'Sinus normal (~65 bpm)',
  noP: 'Sin onda P (ritmo junctional)',
  wideQrs: 'QRS ancho (~160 ms)',
  irregular: 'Ritmo irregular',
};

const SAMPLE_RATE = 130;
/** Samples per emitted frame, like a real PMD notification batch. */
const FRAME_SAMPLES = 65;

/**
 * Synthetic ECG source — streams frames from `makeEcgWaveform` so the
 * strip screen, morphology analysis and capture path can all be
 * exercised without the chest strap.
 */
export class MockEcgSensor implements IEcgSource {
  readonly label = 'ECG simulado';
  private listeners = new Set<(f: EcgFrame) => void>();
  private stateListeners = new Set<(s: SensorConnectionState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private sampleIdx = 0;

  constructor(
    private scenario: EcgScenario = 'normal',
    private readonly bpm = 65,
    private readonly frameMs = 500,
  ) {}

  setScenario(s: EcgScenario): void {
    this.scenario = s;
  }

  async start(): Promise<void> {
    this.setState('connecting');
    await new Promise((r) => setTimeout(r, 300));
    this.setState('streaming');
    this.timer = setInterval(() => this.emitFrame(), this.frameMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setState('idle');
  }

  subscribe(listener: (frame: EcgFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(
    listener: (state: SensorConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private emitFrame(): void {
    const wave = makeEcgWaveform({ scenario: this.scenario, bpm: this.bpm });
    const samples: number[] = [];
    for (let i = 0; i < FRAME_SAMPLES; i++) {
      samples.push(Math.round(wave(this.sampleIdx++)));
    }
    const frame: EcgFrame = {
      samples,
      sampleRateHz: SAMPLE_RATE,
      timestamp: Date.now(),
    };
    for (const l of this.listeners) l(frame);
  }

  private setState(state: SensorConnectionState): void {
    for (const l of this.stateListeners) l(state);
  }
}
