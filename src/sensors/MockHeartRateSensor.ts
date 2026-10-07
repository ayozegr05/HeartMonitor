import type { HRReading } from '@/domain/models';

import type { IHeartRateSensor, SensorConnectionState } from './types';

export type MockScenario = 'normal' | 'bradycardia' | 'pauses';

export const MOCK_SCENARIO_LABELS: Record<MockScenario, string> = {
  normal: 'Ritmo normal (~65 bpm)',
  bradycardia: 'Bradicardia (~38 bpm)',
  pauses: 'Pausas (latido perdido)',
};

/**
 * Synthetic heart-rate source. Lets the whole app run — UI, alerts,
 * persistence — without hardware, which makes it demoable anywhere
 * and keeps the domain logic testable end to end.
 *
 * Scenarios:
 *  - normal: steady ~65 bpm
 *  - bradycardia: ~38 bpm sustained (triggers the low-HR alert)
 *  - pauses: ~65 bpm with a doubled RR interval every few beats
 */
export class MockHeartRateSensor implements IHeartRateSensor {
  readonly label = 'Simulador';
  private listeners = new Set<(r: HRReading) => void>();
  private stateListeners = new Set<(s: SensorConnectionState) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private beatCounter = 0;

  constructor(
    private scenario: MockScenario = 'normal',
    private readonly intervalMs = 1_000,
  ) {}

  setScenario(scenario: MockScenario): void {
    this.scenario = scenario;
  }

  async start(): Promise<void> {
    this.setState('connecting');
    // Simulate a realistic connection delay.
    await new Promise((r) => setTimeout(r, 400));
    this.setState('streaming');
    this.timer = setInterval(() => this.emit(this.nextReading()), this.intervalMs);
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setState('idle');
  }

  subscribe(listener: (reading: HRReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(
    listener: (state: SensorConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private nextReading(): HRReading {
    this.beatCounter += 1;
    const jitter = () => Math.random() * 6 - 3;

    let bpm = 65 + jitter();
    let rr = 60_000 / bpm;

    if (this.scenario === 'bradycardia') {
      bpm = 38 + jitter();
      rr = 60_000 / bpm;
    } else if (this.scenario === 'pauses' && this.beatCounter % 12 === 0) {
      // A non-conducted beat: the next RR interval is ~2× normal.
      rr *= 2.05;
    }

    return {
      bpm: Math.round(bpm),
      rrIntervalsMs: [Math.round(rr)],
      timestamp: Date.now(),
    };
  }

  private emit(reading: HRReading): void {
    for (const l of this.listeners) l(reading);
  }

  private setState(state: SensorConnectionState): void {
    for (const l of this.stateListeners) l(state);
  }
}
