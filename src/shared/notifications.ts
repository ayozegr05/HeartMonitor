import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

const ALERT_CHANNEL_ID = 'heart-alerts-v2';
const LEGACY_CHANNEL_ID = 'heart-alerts';

/**
 * Local notifications only — alerts are generated on-device, not pushed
 * from a server (see docs/adr/0001-local-first-architecture.md).
 */
export function configureNotificationHandler(): void {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
}

/**
 * Android 13+ requires a runtime permission for notifications.
 * On Android the channel is what makes the alert actually loud & sticky.
 */
export async function ensureNotificationSetup(): Promise<boolean> {
  if (Platform.OS === 'android') {
    await Notifications.deleteNotificationChannelAsync(LEGACY_CHANNEL_ID);
    await Notifications.setNotificationChannelAsync(ALERT_CHANNEL_ID, {
      name: 'Alertas cardíacas',
      importance: Notifications.AndroidImportance.MAX,
      vibrationPattern: [0, 500, 250, 500],
      bypassDnd: true,
      lockscreenVisibility:
        Notifications.AndroidNotificationVisibility.PUBLIC,
    });
  }

  const { status } = await Notifications.requestPermissionsAsync();
  return status === 'granted';
}

/** Fires an immediate local notification — no server involved. */
export async function fireAlert(title: string, body: string): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title,
      body,
      // No `sound` here — content.sound means a bundled custom file and
      // expo-notifications errors looking for 'default' in dev builds.
      // The channel already carries the default alert sound.
      ...(Platform.OS === 'android' ? { channelId: ALERT_CHANNEL_ID } : {}),
    },
    trigger: null,
  });
}
