import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { AnimatedSplashOverlay } from '@/components/animated-icon';
import AppTabs from '@/components/app-tabs';
import { initializeDatabase } from '@/data/db';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import {
    configureNotificationHandler,
    ensureNotificationSetup,
} from '@/shared/notifications';

SplashScreen.preventAutoHideAsync();
configureNotificationHandler();

export default function TabLayout() {
  const colorScheme = useColorScheme();

  useEffect(() => {
    initializeDatabase().catch((e) => console.warn('DB init failed', e));
    ensureNotificationSetup().catch(() => {});
    // If the app died mid-session (crash, process reclaim), pick up where
    // it left off — the user's intent to monitor overnight was explicit.
    void useMonitorStore.getState().resumeBleSession();
    // Catch up Health Connect with readings written while the app was down.
    void useMonitorStore.getState().syncHealthConnect();
  }, []);

  return (
    <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
      <AnimatedSplashOverlay />
      <AppTabs />
    </ThemeProvider>
  );
}
