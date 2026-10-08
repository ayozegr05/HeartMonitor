import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import { Animated, FlatList, Pressable, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { useTheme } from '@/hooks/use-theme';
import {
    requestBlePermissions,
    scanForHeartRateSensors,
} from '@/sensors/BleHeartRateSensor';
import { getBleManager } from '@/sensors/bleManager';
import {
    MOCK_SCENARIO_LABELS,
    type MockScenario,
} from '@/sensors/MockHeartRateSensor';
import type { ScannedSensor } from '@/sensors/types';

const STATE_LABELS: Record<string, string> = {
  idle: 'Inactivo',
  connecting: 'Conectando…',
  streaming: 'Monitorizando',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando…',
  error: 'Error',
};

export default function MonitorScreen() {
  const theme = useTheme();
  const {
    connectionState,
    currentReading,
    lastEvent,
    eventCount,
    sensorLabel,
    bleDevice,
    reconnectAttempt,
    startMock,
    startBle,
    stop,
  } = useMonitorStore();

  const streaming = connectionState === 'streaming';

  const [pulse] = useState(() => new Animated.Value(1));
  const liveBpm = currentReading?.bpm ?? 60;
  // Snap the period to ~5 bpm steps: ordinary 1 Hz jitter then leaves
  // beatMs unchanged and the loop below keeps running — a 38 bpm beat
  // needs ~1.6 s to finish a cycle and must not restart every reading.
  const beatMs = Math.max(300, 60_000 / Math.max(30, Math.round(liveBpm / 5) * 5));

  useEffect(() => {
    if (!streaming) {
      pulse.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1.3,
          duration: beatMs * 0.2,
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 1,
          duration: beatMs * 0.8,
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [streaming, beatMs, pulse]);

  useEffect(() => {
    if (streaming) {
      activateKeepAwakeAsync('monitor').catch(() => {});
      return () => {
        void deactivateKeepAwake('monitor');
      };
    }
  }, [streaming]);
  const [mode, setMode] = useState<'mock' | 'ble'>('mock');
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedSensor[]>([]);
  const [error, setError] = useState<string | null>(null);

  const startScan = async () => {
    setError(null);
    const granted = await requestBlePermissions();
    if (!granted) {
      setError('Permisos de Bluetooth denegados');
      return;
    }
    setDevices([]);
    setScanning(true);
    scanForHeartRateSensors(
      getBleManager(),
      (d) => setDevices((prev) => [...prev, d]),
      10_000,
    );
    setTimeout(() => setScanning(false), 10_000);
  };

  const connectTo = async (device: ScannedSensor) => {
    setError(null);
    try {
      await startBle(device.id);
    } catch {
      setError(`No se pudo conectar a ${device.name}`);
    }
  };

  return (
    <ThemedView style={styles.container}>

      <SafeAreaView style={styles.safeArea}>
        {/* Big live BPM readout */}
        <ThemedView style={styles.hero}>
          <ThemedText type="small" themeColor="textSecondary">
            {STATE_LABELS[connectionState]}
            {connectionState === 'reconnecting' && reconnectAttempt > 0
              ? ` (intento ${reconnectAttempt})`
              : ''}
            {sensorLabel ? ` · ${sensorLabel}` : ''}
          </ThemedText>
          <Animated.Text
            style={[styles.heart, { transform: [{ scale: pulse }] }]}>
            ❤️
          </Animated.Text>
          <ThemedText style={styles.bpm}>
            {currentReading ? currentReading.bpm : '--'}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            bpm · eventos esta sesión: {eventCount}
          </ThemedText>
        </ThemedView>

        {lastEvent && (
          <ThemedView type="backgroundElement" style={styles.alertBox}>
            <ThemedText type="smallBold">
              {lastEvent.type === 'bradycardia'
                ? `Bradicardia: ${lastEvent.bpm} bpm`
                : `Pausa: ${lastEvent.rrIntervalMs} ms`}
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {new Date(lastEvent.timestamp).toLocaleTimeString()}
            </ThemedText>
          </ThemedView>
        )}

        {/* Source picker */}
        <ThemedView style={styles.row}>
          {(['mock', 'ble'] as const).map((m) => (
            <Pressable
              key={m}
              onPress={() => setMode(m)}
              style={[
                styles.chip,
                { backgroundColor: theme.backgroundElement },
                mode === m && { backgroundColor: theme.backgroundSelected },
              ]}>
              <ThemedText type="small">
                {m === 'mock' ? 'Simulador' : 'Bluetooth'}
              </ThemedText>
            </Pressable>
          ))}
        </ThemedView>

        {mode === 'mock' ? (
          <ThemedView style={styles.row}>
            {(Object.keys(MOCK_SCENARIO_LABELS) as MockScenario[]).map((s) => (
              <Pressable
                key={s}
                onPress={() => setScenario(s)}
                style={[
                  styles.chip,
                  { backgroundColor: theme.backgroundElement },
                  scenario === s && {
                    backgroundColor: theme.backgroundSelected,
                  },
                ]}>
                <ThemedText type="small">
                  {MOCK_SCENARIO_LABELS[s].split(' ')[0]}
                </ThemedText>
              </Pressable>
            ))}
          </ThemedView>
        ) : (
          <>
            <Pressable
              onPress={startScan}
              style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">
                {scanning ? 'Buscando…' : 'Buscar sensores BLE'}
              </ThemedText>
            </Pressable>
            {bleDevice && !streaming && connectionState !== 'reconnecting' && (
              <Pressable
                onPress={() => connectTo({ id: bleDevice.id, name: bleDevice.label })}
                style={[styles.button, { backgroundColor: theme.backgroundSelected }]}>
                <ThemedText type="smallBold">
                  Reconectar a {bleDevice.label}
                </ThemedText>
              </Pressable>
            )}
            <FlatList
              data={devices}
              keyExtractor={(d) => d.id}
              style={styles.deviceList}
              renderItem={({ item }) => (
                <Pressable
                  onPress={() => connectTo(item)}
                  style={[
                    styles.deviceRow,
                    { backgroundColor: theme.backgroundElement },
                  ]}>
                  <ThemedText type="small">{item.name}</ThemedText>
                </Pressable>
              )}
            />
          </>
        )}

        {error && (
          <ThemedText type="small" themeColor="textSecondary">
            {error}
          </ThemedText>
        )}

        <Pressable
          onPress={() =>
            streaming ? stop() : mode === 'mock' ? startMock(scenario) : undefined
          }
          style={[
            styles.primaryButton,
            { backgroundColor: streaming ? '#B3261E' : '#2E7D32' },
          ]}>
          <ThemedText type="smallBold" style={styles.primaryButtonText}>
            {streaming
              ? 'Detener'
              : mode === 'mock'
                ? 'Iniciar simulación'
                : 'Selecciona un sensor'}
          </ThemedText>
        </Pressable>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: {
    flex: 1,
    alignItems: 'center',
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
    paddingBottom: BottomTabInset + Spacing.three,
    gap: Spacing.three,
  },
  hero: { alignItems: 'center', gap: Spacing.one, flex: 1, justifyContent: 'center' },
  heart: { fontSize: 72 },
  bpm: { fontSize: 96, fontWeight: 700, lineHeight: 104 },
  alertBox: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
  },
  row: { flexDirection: 'row', gap: Spacing.two },
  chip: {
    borderRadius: Spacing.five,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  button: {
    borderRadius: Spacing.three,
    paddingHorizontal: Spacing.four,
    paddingVertical: Spacing.two,
  },
  deviceList: { alignSelf: 'stretch', maxHeight: 160 },
  deviceRow: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
  primaryButton: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#ffffff' },
});
