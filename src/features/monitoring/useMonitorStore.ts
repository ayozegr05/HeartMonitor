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
import {
  buildSessionReport,
  formatReportSummary,
} from '@/domain/morningReport';
import { PauseDetector } from '@/domain/pauseDetection';
import { reconnectDelayMs } from '@/domain/reconnect';
import {
  activeLowThreshold,
  isNightTime,
  SLEEP_END_HOUR,
} from '@/domain/thresholds';
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
import {
  endSession,
  getSessionAlertEvents,
  getSessionReadings,
  saveEvent,
  saveReading,
  startSession,
} from '@/data/readingsRepository';
import {
  startMonitoringService,
  stopMonitoringService,
  updateMonitoringNotification,
} from '@/features/monitoring/foregroundService';
import { syncReadingsToHealthConnect } from '@/features/healthconnect/healthConnectSync';
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
  /**
   * Id of the open `sessions` row this monitoring run writes under.
   * Persisted so a session that outlives the process (crash, reclaim)
   * keeps accumulating under the same night for the morning report.
   */
  sessionId: number | null;
  sessionStartedAt: number | null;
  /** Watermark of the last emitted morning report (Unix ms). */
  lastReportedAt: number | null;
  /** Whether readings are mirrored to Android Health Connect. */
  healthConnectEnabled: boolean;
  /** Watermark of the last reading pushed to Health Connect (Unix ms). */
  lastHcSyncAt: number | null;
  /** Last manual backup export (Unix ms); null = never exported. */
  lastBackupExportAt: number | null;
  /** The one-time "protect your history" nag has been acknowledged. */
  backupNagDismissed: boolean;

  startMock: (scenario: MockScenario) => Promise<void>;
  startBle: (deviceId: string) => Promise<void>;
  stop: () => Promise<void>;
  setThresholds: (t: ThresholdProfile) => void;
  setHealthConnectEnabled: (enabled: boolean) => void;
  /** Pushes new readings to Health Connect; no-op when disabled. */
  syncHealthConnect: () => Promise<void>;
  setLastBackupExportAt: (ts: number) => void;
  setBackupNagDismissed: () => void;
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
let reportTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectAlertTimer: ReturnType<typeof setTimeout> | null = null;
let disconnectAlerted = false;

/** Skip the morning notification for trivially short coverage (~5 min @1Hz). */
const MIN_REPORT_READINGS = 300;

/** A BLE dropout longer than this is worth a notification, not a blip. */
const DISCONNECT_ALERT_MS = 2 * 60_000;

/** Next local occurrence of the sleep-window end hour. */
const msUntilNextWake = (): number => {
  const next = new Date();
  next.setHours(SLEEP_END_HOUR, 0, 0, 0);
  if (next.getTime() <= Date.now()) next.setDate(next.getDate() + 1);
  return next.getTime() - Date.now();
};

/** Most recent past occurrence of the sleep-window end hour. */
const lastWakeTime = (): number => {
  const prev = new Date();
  prev.setHours(SLEEP_END_HOUR, 0, 0, 0);
  if (prev.getTime() > Date.now()) prev.setDate(prev.getDate() - 1);
  return prev.getTime();
};
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
        void saveReading(reading, label, get().sessionId).catch(console.warn);
        void updateMonitoringNotification(reading.bpm).catch(() => {});
        for (const event of detected) {
          void saveEvent(event, get().sessionId).catch(console.warn);
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
        // The persistent banner doesn't distinguish "streaming" from
        // "waiting to reconnect" — flag a long outage explicitly.
        if (!disconnectAlertTimer && !disconnectAlerted) {
          disconnectAlertTimer = setTimeout(() => {
            disconnectAlertTimer = null;
            disconnectAlerted = true;
            void fireAlert(
              '⌚ Reloj sin conexión',
              'Sin datos — reintentando la conexión…',
            ).catch(console.warn);
          }, DISCONNECT_ALERT_MS);
        }
      };

      const wireSensor = (next: IHeartRateSensor): void => {
        sensor = next;
        unsubscribeState = next.onStateChange((connectionState) => {
          set({ connectionState });
          if (connectionState === 'streaming') {
            // Link back: re-arm the outage alert for the next drop.
            if (disconnectAlertTimer) {
              clearTimeout(disconnectAlertTimer);
              disconnectAlertTimer = null;
            }
            disconnectAlerted = false;
          }
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

      const connectBle = async (
        deviceId: string,
        beforeStart?: (label: string) => Promise<void>,
      ): Promise<void> => {
        const device = await getBleManager().connectToDevice(deviceId);
        const next = new BleHeartRateSensor(getBleManager(), device);
        wireSensor(next);
        // Session row must exist before the stream can emit — readings and
        // events are tagged with sessionId from the first sample.
        await beforeStart?.(next.label);
        await next.start();
        set({
          source: 'ble',
          sensorLabel: next.label,
          bleDevice: { id: deviceId, label: next.label },
          reconnectAttempt: 0,
        });
      };

      const attemptReconnect = async (): Promise<void> => {
        const { monitoringIntent, bleDevice, reconnectAttempt, source } =
          get();
        // Only a BLE session may be reconnected — a mock run shares
        // monitoringIntent but must never wake the watch.
        if (!monitoringIntent || !bleDevice || source !== 'ble') return;
        try {
          await detachSensor();
          await connectBle(bleDevice.id);
        } catch {
          set({ reconnectAttempt: reconnectAttempt + 1 });
          scheduleReconnect();
        }
      };

      /**
       * Morning report: while a session is open, a timer fires at the wake
       * hour (SLEEP_END_HOUR), summarizes the unreported night span and
       * notifies. Re-arms each morning for multi-day sessions.
       */
      const emitMorningReport = async (
        reportEnd = Date.now(),
      ): Promise<void> => {
        const { sessionId, sessionStartedAt, lastReportedAt, thresholds } =
          get();
        if (sessionId == null || sessionStartedAt == null) return;
        try {
          const since = lastReportedAt ?? sessionStartedAt;
          const [readingRows, events] = await Promise.all([
            getSessionReadings(sessionId),
            getSessionAlertEvents(sessionId),
          ]);
          const scoped = readingRows.filter(
            (r) => r.timestamp >= since && r.timestamp < reportEnd,
          );
          // Only worth a notification when a real night was covered.
          if (
            scoped.length < MIN_REPORT_READINGS ||
            !scoped.some((r) => isNightTime(new Date(r.timestamp)))
          ) {
            return;
          }
          const report = buildSessionReport(
            { startedAt: since, endedAt: reportEnd },
            scoped,
            events,
            thresholds,
          );
          await fireAlert('🌅 Informe nocturno', formatReportSummary(report));
          // Watermark advances only after the notification went out — a
          // failed alert must not mark the night as reported.
          set({ lastReportedAt: reportEnd });
        } catch (e) {
          console.warn('morning report failed', e);
        }
      };

      const scheduleMorningReport = (): void => {
        if (reportTimer) clearTimeout(reportTimer);
        reportTimer = setTimeout(() => {
          reportTimer = null;
          void emitMorningReport().finally(() => {
            if (get().monitoringIntent) scheduleMorningReport();
          });
        }, msUntilNextWake());
      };

      /** Opens the `sessions` row and arms the morning-report timer. */
      const openSessionRow = async (
        source: SensorSource,
        label: string,
      ): Promise<void> => {
        const startedAt = Date.now();
        try {
          const id = await startSession(source, label, startedAt);
          set({
            sessionId: id,
            sessionStartedAt: startedAt,
            lastReportedAt: null,
          });
        } catch (e) {
          console.warn('session row failed', e);
          set({
            sessionId: null,
            sessionStartedAt: startedAt,
            lastReportedAt: null,
          });
        }
        scheduleMorningReport();
      };

      /** Shared session preamble: fresh detectors, clean sensor, FGS up. */
      const beginSession = async (): Promise<void> => {
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
        }
        if (disconnectAlertTimer) {
          clearTimeout(disconnectAlertTimer);
          disconnectAlertTimer = null;
        }
        disconnectAlerted = false;
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
        sessionId: null,
        sessionStartedAt: null,
        lastReportedAt: null,
        healthConnectEnabled: false,
        lastHcSyncAt: null,
        lastBackupExportAt: null,
        backupNagDismissed: false,

        startMock: async (scenario) => {
          await beginSession();
          const next = new MockHeartRateSensor(scenario);
          wireSensor(next);
          await openSessionRow('mock', next.label);
          await next.start();
          set({ source: 'mock', sensorLabel: next.label });
        },

        startBle: async (deviceId) => {
          await beginSession();
          try {
            await connectBle(deviceId, (label) =>
              openSessionRow('ble', label),
            );
          } catch (e) {
            // Never connected — this is a failure, not a drop to retry.
            set({ monitoringIntent: false });
            const sid = get().sessionId;
            if (sid != null) {
              void endSession(sid, Date.now()).catch(() => {});
              set({ sessionId: null, sessionStartedAt: null });
            }
            void stopMonitoringService().catch(() => {});
            throw e;
          }
        },

        resumeBleSession: async () => {
          const {
            monitoringIntent,
            bleDevice,
            connectionState,
            sessionId,
            source,
          } = get();
          if (
            monitoringIntent &&
            sessionId != null &&
            (!bleDevice || source !== 'ble')
          ) {
            // Only BLE sessions survive process death — a mock run that lost
            // its process can't resume, so close it at its last reading
            // instead of showing "Monitorizando" forever.
            try {
              const rows = await getSessionReadings(sessionId);
              await endSession(
                sessionId,
                rows.at(-1)?.timestamp ?? Date.now(),
              );
            } catch (e) {
              console.warn('closing stale session failed', e);
            }
            set({
              monitoringIntent: false,
              sessionId: null,
              sessionStartedAt: null,
              lastReportedAt: null,
            });
            return;
          }
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
          // Timers don't survive process death — re-arm the wake report and,
          // if the app died overnight before the 07:00 report could fire,
          // emit it now so the morning summary isn't lost.
          scheduleMorningReport();
          const {
            sessionId: resumedId,
            sessionStartedAt,
            lastReportedAt,
          } = get();
          if (
            resumedId != null &&
            sessionStartedAt != null &&
            (lastReportedAt ?? sessionStartedAt) < lastWakeTime()
          ) {
            // Bound the delayed report to the missed wake boundary — not
            // now, or a late restart would fold daytime monitoring into
            // the overnight summary.
            void emitMorningReport(lastWakeTime());
          } else if (resumedId == null) {
            // Session predates session tracking — open a row so new
            // readings still land under a reportable session.
            void openSessionRow('ble', bleDevice.label);
          }
        },

        stop: async () => {
          set({ monitoringIntent: false, reconnectAttempt: 0 });
          if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
          }
          if (reportTimer) {
            clearTimeout(reportTimer);
            reportTimer = null;
          }
          if (disconnectAlertTimer) {
            clearTimeout(disconnectAlertTimer);
            disconnectAlertTimer = null;
          }
          disconnectAlerted = false;
          const { sessionId } = get();
          if (sessionId != null) {
            void endSession(sessionId, Date.now()).catch(console.warn);
          }
          await detachSensor();
          void stopMonitoringService().catch(() => {});
          set({
            connectionState: 'idle',
            source: null,
            sensorLabel: null,
            sessionId: null,
            sessionStartedAt: null,
            lastReportedAt: null,
          });
          // Session closed — flush its readings to Health Connect.
          void get().syncHealthConnect();
        },

        setThresholds: (t) => set({ thresholds: t }),

        setHealthConnectEnabled: (enabled) => {
          set({ healthConnectEnabled: enabled });
          if (enabled) void get().syncHealthConnect();
        },

        setLastBackupExportAt: (ts) => set({ lastBackupExportAt: ts }),
        setBackupNagDismissed: () => set({ backupNagDismissed: true }),

        syncHealthConnect: async () => {
          const { healthConnectEnabled, lastHcSyncAt } = get();
          if (!healthConnectEnabled) return;
          const syncedUntil = await syncReadingsToHealthConnect(
            lastHcSyncAt ?? 0,
          );
          if (syncedUntil !== null) set({ lastHcSyncAt: syncedUntil });
        },
      };
    },
    {
      name: 'heartmonitor-settings',
      storage: createJSONStorage(() => AsyncStorage),
      // bleDevice + monitoringIntent let a killed session resume on launch;
      // session fields keep overnight readings under one reportable session.
      partialize: (s) => ({
        thresholds: s.thresholds,
        bleDevice: s.bleDevice,
        monitoringIntent: s.monitoringIntent,
        source: s.source,
        sessionId: s.sessionId,
        sessionStartedAt: s.sessionStartedAt,
        lastReportedAt: s.lastReportedAt,
        healthConnectEnabled: s.healthConnectEnabled,
        lastHcSyncAt: s.lastHcSyncAt,
        lastBackupExportAt: s.lastBackupExportAt,
        backupNagDismissed: s.backupNagDismissed,
      }),
    },
  ),
);
