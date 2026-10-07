import AsyncStorage from '@react-native-async-storage/async-storage';
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';

import { BradycardiaDetector } from '@/domain/bradycardia';
import {
  DEFAULT_THRESHOLDS,
  type AlertEvent,
  type HRReading,
  type ThresholdProfile,
} from '@/domain/models';
import { PauseDetector } from '@/domain/pauseDetection';
import { activeLowThreshold } from '@/domain/thresholds';
import { getBleManager } from '@/sensors/bleManager';
import { BleHeartRateSensor } from '@/sensors/BleHeartRateSensor';
import {
  MockHeartRateSensor,
  type MockScenario,
} from '@/sensors/MockHeartRateSensor';
import type {
  IHeartRateSensor,
  SensorConnectionState,
} from '@/sensors/types';
import { saveEvent, saveReading } from '@/data/readingsRepository';
import { fireAlert } from '@/shared/notifications';

type SensorSource = 'mock' | 'ble';

interface MonitorState {
  connectionState: SensorConnectionState;
  source: SensorSource | null;
  sensorLabel: string | null;
  currentReading: HRReading | null;
  lastEvent: AlertEvent | null;
  eventCount: number;
  thresholds: ThresholdProfile;

  startMock: (scenario: MockScenario) => Promise<void>;
  startBle: (deviceId: string) => Promise<void>;
  stop: () => Promise<void>;
  setThresholds: (t: ThresholdProfile) => void;
}

// Sensor + detectors live outside React state — they are stateful services,
// not renderable data. Detectors are recreated on each session start.
let sensor: IHeartRateSensor | null = null;
let unsubscribe: (() => void) | null = null;
let bradycardia = new BradycardiaDetector(DEFAULT_THRESHOLDS.sustainedMs);
let pause = new PauseDetector(DEFAULT_THRESHOLDS.pauseRrMultiplier);

export const useMonitorStore = create<MonitorState>()(
  persist(
    (set, get) => {
      const handleReading = (reading: HRReading): void => {
        const { thresholds, source } = get();
        const label = sensor?.label ?? 'unknown';
        const detected: AlertEvent[] = [];

        const lowThreshold = activeLowThreshold(
          thresholds,
          new Date(reading.timestamp),
        );
        const bradyEvent = bradycardia.evaluate(reading, lowThreshold);
        if (bradyEvent) detected.push(bradyEvent);

        const pauseEvent = pause.evaluate(reading);
        if (pauseEvent) detected.push(pauseEvent);

        set((s) => ({
          currentReading: reading,
          lastEvent: detected.at(-1) ?? s.lastEvent,
          eventCount: s.eventCount + detected.length,
        }));

        // Side effects — persisted + alerted, never blocking the stream.
        void saveReading(reading, label).catch(console.warn);
        for (const event of detected) {
          void saveEvent(event).catch(console.warn);
          const body =
            event.type === 'bradycardia'
              ? `FC ${event.bpm} bpm durante ${Math.round((event.durationMs ?? 0) / 1000)}s`
              : `Pausa detectada: intervalo de ${event.rrIntervalMs} ms`;
          void fireAlert('⚠️ Evento cardíaco', body).catch(console.warn);
        }
        void source; // reserved for per-source policies (Phase 2)
      };

      const attach = async (next: IHeartRateSensor, src: SensorSource) => {
        await get().stop();

        bradycardia = new BradycardiaDetector(get().thresholds.sustainedMs);
        pause = new PauseDetector(get().thresholds.pauseRrMultiplier);
        set({ eventCount: 0, currentReading: null });

        sensor = next;
        next.onStateChange((connectionState) => set({ connectionState }));
        unsubscribe = next.subscribe(handleReading);
        await next.start();
        set({ source: src, sensorLabel: next.label });
      };

      return {
        connectionState: 'idle',
        source: null,
        sensorLabel: null,
        currentReading: null,
        lastEvent: null,
        eventCount: 0,
        thresholds: DEFAULT_THRESHOLDS,

        startMock: (scenario) => attach(new MockHeartRateSensor(scenario), 'mock'),

        startBle: async (deviceId) => {
          const device = await getBleManager().connectToDevice(deviceId);
          await attach(new BleHeartRateSensor(getBleManager(), device), 'ble');
        },

        stop: async () => {
          unsubscribe?.();
          unsubscribe = null;
          if (sensor) {
            await sensor.stop().catch(() => {});
            sensor = null;
          }
          set({ connectionState: 'idle', source: null, sensorLabel: null });
        },

        setThresholds: (t) => set({ thresholds: t }),
      };
    },
    {
      name: 'heartmonitor-settings',
      storage: createJSONStorage(() => AsyncStorage),
      partialize: (s) => ({ thresholds: s.thresholds }),
    },
  ),
);
