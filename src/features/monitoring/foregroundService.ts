import { Platform } from 'react-native';
import BackgroundService from 'react-native-background-actions';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const NOTIFICATION_UPDATE_MIN_INTERVAL_MS = 10_000;

let lastNotificationUpdate = 0;

/**
 * Android foreground service for all-night monitoring. The service posts a
 * persistent notification and holds the process (and with it the JS context,
 * the BLE link and the detectors) alive while the screen is off.
 *
 * The JS task itself is a keep-alive: the real work — sensor stream → domain
 * detectors → DB/alerts — runs in the app's context, which stays running
 * because the service prevents the OS from reclaiming it.
 */
const keepAliveTask = async (): Promise<void> => {
  while (BackgroundService.isRunning()) {
    await sleep(60_000);
  }
};

export async function startMonitoringService(): Promise<void> {
  if (Platform.OS !== 'android' || BackgroundService.isRunning()) return;
  await BackgroundService.start(keepAliveTask, {
    taskName: 'HeartMonitor',
    taskTitle: 'HeartMonitor activo',
    taskDesc: 'Monitorizando frecuencia cardíaca',
    taskIcon: { name: 'ic_launcher', type: 'mipmap' },
    color: '#B3261E',
    linkingURI: 'heartmonitor://',
    foregroundServiceType: ['connectedDevice'],
  });
}

export async function stopMonitoringService(): Promise<void> {
  if (Platform.OS !== 'android' || !BackgroundService.isRunning()) return;
  await BackgroundService.stop();
}

/**
 * Keeps the persistent notification's text in sync with the live reading.
 * Android rate-limits notification updates, so calls are throttled.
 */
export async function updateMonitoringNotification(bpm: number): Promise<void> {
  if (Platform.OS !== 'android' || !BackgroundService.isRunning()) return;
  const now = Date.now();
  if (now - lastNotificationUpdate < NOTIFICATION_UPDATE_MIN_INTERVAL_MS) return;
  lastNotificationUpdate = now;
  await BackgroundService.updateNotification({
    taskDesc: `Frecuencia cardíaca: ${bpm} bpm`,
  });
}
