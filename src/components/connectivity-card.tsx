import { useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { useTheme } from '@/hooks/use-theme';
import {
    requestBlePermissions,
    scanForHeartRateSensors,
} from '@/sensors/BleHeartRateSensor';
import { getBleManager } from '@/sensors/bleManager';
import type { ScannedSensor } from '@/sensors/types';

/**
 * BLE connectivity card — lives in Ajustes. Scanning and picking the strap
 * no longer starts monitoring: the chosen device is just remembered and the
 * actual session starts from Monitor's Start button.
 */
export function ConnectivityCard() {
  const theme = useTheme();
  const { bleDevice, rememberBleDevice, connectionState, sensorLabel } =
    useMonitorStore();
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedSensor[]>([]);
  const [btPoweredOn, setBtPoweredOn] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const sub = getBleManager().onStateChange(
      (state) => setBtPoweredOn(state === 'PoweredOn'),
      true,
    );
    return () => sub.remove();
  }, []);

  const startScan = async () => {
    setError(null);
    if ((await getBleManager().state()) !== 'PoweredOn') {
      setError('Bluetooth apagado — enciéndelo para buscar sensores');
      return;
    }
    const granted = await requestBlePermissions();
    if (!granted) {
      setError('Permisos de Bluetooth denegados');
      return;
    }
    setDevices([]);
    setScanning(true);
    scanForHeartRateSensors(
      getBleManager(),
      (d) =>
        setDevices((prev) =>
          prev.some((p) => p.id === d.id) ? prev : [...prev, d],
        ),
      10_000,
    );
    setTimeout(() => setScanning(false), 10_000);
  };

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedText type="smallBold">📶 Conectividad</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {bleDevice
          ? `Banda elegida: ${bleDevice.label}`
          : 'Ninguna banda elegida — busca tu Polar H10 abajo'}
        {connectionState === 'streaming' && sensorLabel
          ? ` · activa (${sensorLabel})`
          : ''}
      </ThemedText>
      {!btPoweredOn && (
        <ThemedText type="small" style={{ color: '#FFB020' }}>
          ⚠️ Bluetooth apagado — enciéndelo para buscar la banda
        </ThemedText>
      )}
      <Pressable
        onPress={startScan}
        style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold">
          {scanning ? 'Buscando…' : 'Buscar sensores BLE'}
        </ThemedText>
      </Pressable>
      <FlatList
        data={devices}
        keyExtractor={(d) => d.id}
        style={styles.deviceList}
        renderItem={({ item }) => {
          const selected = bleDevice?.id === item.id;
          return (
            <Pressable
              onPress={() => {
                rememberBleDevice({ id: item.id, label: item.name });
                setDevices([]);
              }}
              style={[
                styles.deviceRow,
                { backgroundColor: theme.background },
                selected && { backgroundColor: theme.backgroundSelected },
              ]}>
              <ThemedText type="small">
                {item.name}
                {selected ? ' · elegida' : ''}
              </ThemedText>
            </Pressable>
          );
        }}
      />
      {bleDevice && (
        <Pressable
          onPress={() => rememberBleDevice(null)}
          style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">Olvidar banda</ThemedText>
        </Pressable>
      )}
      {error && (
        <ThemedText type="small" themeColor="textSecondary">
          {error}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        La monitorización se arranca desde la pestaña Monitor — aquí solo
        eliges la banda.
      </ThemedText>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  button: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  deviceList: { alignSelf: 'stretch', maxHeight: 160 },
  deviceRow: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
});
