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
import { reconnectDelayMs } from '@/domain/reconnect';
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
import {
  startMonitoringService,
  stopMonitoringService,
  updateMonitoringNotification,
} from '@/features/monitoring/foregroundService';
import { fireAlert } from '@/shared/notifications';

type SensorSource = 'mock' | 'ble';

export interface BleDeviceRef {
  id: string;
  label: string;
}

interface MonitorState {
  connectionState: SensorConnectionState;
  source: SensorSource | null;
  sensorLabel: string | null;
  currentReading: HRReading | null;
  lastEvent: AlertEvent | null;
  eventCount: number;
  thresholds: ThresholdProfile;
  /** Whether a monitoring session is intended to be active — survives drops. */
  monitoringIntent: boolean;
  /** Last BLE sensor used; persisted so reconnects work without rescanning. */
  bleDevice: BleDeviceRef | null;
  /** Reconnection attempts since the last successful stream. */
  reconnectAttempt: number;

  startMock: (scenario: MockScenario) => Promise<void>;
  startBle: (deviceId: string) => Promise<void>;
  stop: () => Promise<void>;
  setThresholds: (t: ThresholdProfile) => void;
  /**
   * Called once at app start. If a BLE session was live when the app last
   * died (crash, process reclaim), resume it — the user intent was explicit.
   */
  resumeBleSession: () => Promise<void>;
}

// Sensor + detectors live outside React state — they are stateful services,
// not renderable data. Detectors are recreated on each session start.
let sensor: IHeartRateSensor | null = null;
let unsubscribeReading: (() => void) | null = null;
let unsubscribeState: (() => void) | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let bradycardia = new BradycardiaDetector(DEFAULT_THRESHOLDS.sustainedMs);
let pause = new PauseDetector(DEFAULT_THRESHOLDS.pauseRrMultiplier);

export const useMonitorStore = create<MonitorState>()(
  persist(
    (set, get) => {
      const handleReading = (reading: HRReading): void => {
        const { thresholds } = get();
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
        void updateMonitoringNotification(reading.bpm).catch(() => {});
        for (const event of detected) {
          void saveEvent(event).catch(console.warn);
          const body =
            event.type === 'bradycardia'
              ? `FC ${event.bpm} bpm durante ${Math.round((event.durationMs ?? 0) / 1000)}s`
              : `Pausa detectada: intervalo de ${event.rrIntervalMs} ms`;
          void fireAlert('⚠️ Evento cardíaco', body).catch(console.warn);
        }
      };

      const detachSensor = async (): Promise<void> => {
        unsubscribeReading?.();
        unsubscribeReading = null;
        unsubscribeState?.();
        unsubscribeState = null;
        if (sensor) {
          await sensor.stop().catch(() => {});
          sensor = null;
        }
      };

      const scheduleReconnect = (): void => {
        if (reconnectTimer) return;
        const delay = reconnectDelayMs(get().reconnectAttempt);
        set({ connectionState: 'reconnecting' });
        reconnectTimer = setTimeout(() => {
          reconnectTimer = null;
          void attemptReconnect();
        }, delay);
      };

      const wireSensor = (next: IHeartRateSensor): void => {
        sensor = next;
        unsubscribeState = next.onStateChange((connectionState) => {
          set({ connectionState });
          // A drop is not a stop: keep the session alive and retry the link.
          if (
            (connectionState === 'disconnected' ||
              connectionState === 'error') &&
            get().monitoringIntent
          ) {
            scheduleReconnect();
          }
        });
        unsubscribeReading = next.subscribe(handleReading);
      };

      const connectBle = async (deviceId: string): Promise<void> => {
        const device = await getBleManager().connectToDevice(deviceId);
        const next = new BleHeartRateSensor(getBleManager(), device);
        wireSensor(next);
        await next.start();
        set({
          source: 'ble',
          sensorLabel: next.label,
          bleDevice: { id: deviceId, label: next.label },
          reconnectAttempt: 0,
        });
      };

      const attemptReconnect = async (): Promise<void> => {
        const { monitoringIntent, bleDevice, reconnectAttempt } = get();
        if (!monitoringIntent || !bleDevice) return;
        try {
          await detachSensor();
          await connectBle(bleDevice.id);
        } catch {
          set({ reconnectAttempt: reconnectAttempt + 1 });
          scheduleReconnect();
        }
      };

      /** Shared session preamble: fresh detectors, clean sensor, FGS up. */
      const beginSession = async (): Promise<void> => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        await detachSensor();
        bradycardia = new BradycardiaDetector(get().thresholds.sustainedMs);
        pause = new PauseDetector(get().thresholds.pauseRrMultiplier);
        set({
          eventCount: 0,
          currentReading: null,
          monitoringIntent: true,
          reconnectAttempt: 0,
        });
        void startMonitoringService().catch(console.warn);
      };

      return {
        connectionState: 'idle',
        source: null,
        sensorLabel: null,
        currentReading: null,
        lastEvent: null,
        eventCount: 0,
        thresholds: DEFAULT_THRESHOLDS,
        monitoringIntent: false,
        bleDevice: null,
        reconnectAttempt: 0,

        startMock: async (scenario) => {
          await beginSession();
          const next = new MockHeartRateSensor(scenario);
          wireSensor(next);
          await next.start();
          set({ source: 'mock', sensorLabel: next.label });
        },

        startBle: async (deviceId) => {
          await beginSession();
          try {
            await connectBle(deviceId);
          } catch (e) {
            // Never connected — this is a failure, not a drop to retry.
            set({ monitoringIntent: false });
            void stopMonitoringService().catch(() => {});
            throw e;
          }
        },

        resumeBleSession: async () => {
          const { monitoringIntent, bleDevice, connectionState } = get();
          if (
            !monitoringIntent ||
            !bleDevice ||
            connectionState === 'streaming' ||
            connectionState === 'connecting'
          ) {
            return;
          }
          try {
            await connectBle(bleDevice.id);
          } catch {
            // Leave monitoringIntent set — the reconnect loop keeps retrying.
            set({ reconnectAttempt: 1 });
            scheduleReconnect();
          }
        },

        stop: async () => {
          set({ monitoringIntent: false, reconnectAttempt: 0 });
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          await detachSensor();
          void stopMonitoringService().catch(() => {});
          set({ connectionState: 'idle', source: null, sensorLabel: null });
        },

        setThresholds: (t) => set({ thresholds: t }),
      };
    },
    {
      name: 'heartmonitor-settings',
      storage: createJSONStorage(() => AsyncStorage),
      // bleDevice + monitoringIntent let a killed session resume on launch.
      partialize: (s) => ({
        thresholds: s.thresholds,
        bleDevice: s.bleDevice,
        monitoringIntent: s.monitoringIntent,
      }),
    },
  ),
);
