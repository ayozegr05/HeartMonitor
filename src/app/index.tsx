import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useEffect, useState } from 'react';
import {
  Animated,
  FlatList,
  Modal,
  Pressable,
  StyleSheet,
} from 'react-native';
import {
    SafeAreaView,
    useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { HrChart } from '@/components/hr-chart';
import { EcgPanel } from '@/components/ecg-panel';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { bucketSeries, computeTrend } from '@/domain/hrChart';
import { formatDuration } from '@/domain/morningReport';
import { activeLowThreshold } from '@/domain/thresholds';
import { openWhatsappAlert } from '@/features/caregiver/whatsapp';
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
import type { IEcgSource } from '@/sensors/ecg';
import { MockEcgSensor } from '@/sensors/polar/MockEcgSensor';
import { PolarEcgSource } from '@/sensors/polar/PolarEcgSource';
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
    recentReadings,
    sessionMinBpm,
    sessionMaxBpm,
    sessionStartedAt,
    thresholds,
    lastEvent,
    eventCount,
    sensorLabel,
    bleDevice,
    reconnectAttempt,
    whatsappNumber,
    pendingWhatsappMessage,
    clearPendingWhatsapp,
    startMock,
    startBle,
    stop,
    setMockScenario,
  } = useMonitorStore();

  const streaming = connectionState === 'streaming';
  const insets = useSafeAreaInsets();

  // Honest readout: a link that delivers nothing for a while is not
  // 'monitoring'. Tick only while streaming so the check re-renders.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!streaming) return;
    const t = setInterval(() => setNow(Date.now()), 2_000);
    return () => clearInterval(t);
  }, [streaming]);
  const staleData =
    streaming && (!currentReading || now - currentReading.timestamp > 8_000);

  const activeThreshold = activeLowThreshold(thresholds, new Date(now));
  const currentBpm = currentReading?.bpm;
  const belowThreshold =
    currentBpm !== undefined && currentBpm < activeThreshold;
  const trend = computeTrend(recentReadings);
  const trendGlyph =
    trend === 'rising' ? '↗' : trend === 'falling' ? '↘' : '→';

  const liveBuckets =
    recentReadings.length >= 2
      ? bucketSeries(
          recentReadings,
          recentReadings[0].timestamp,
          now,
          60,
          thresholds,
        )
      : [];

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
  const [ecgOpen, setEcgOpen] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [devices, setDevices] = useState<ScannedSensor[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [btPoweredOn, setBtPoweredOn] = useState(true);

  useEffect(() => {
    if (mode !== 'ble') return;
    const sub = getBleManager().onStateChange(
      (state) => setBtPoweredOn(state === 'PoweredOn'),
      true,
    );
    return () => sub.remove();
  }, [mode]);

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
      (d) => setDevices((prev) => [...prev, d]),
      10_000,
    );
    setTimeout(() => setScanning(false), 10_000);
  };

  const connectTo = async (device: ScannedSensor) => {
    setError(null);
    if ((await getBleManager().state()) !== 'PoweredOn') {
      setError('Bluetooth apagado — enciéndelo para conectar');
      return;
    }
    try {
      await startBle(device.id);
    } catch {
      setError(`No se pudo conectar a ${device.name}`);
    }
  };

  /** ECG source: the real Polar PMD stream on the strap, else the mock. */
  const makeEcgSource = (): IEcgSource => {
    if (bleDevice && /polar|h10/i.test(bleDevice.label)) {
      return new PolarEcgSource(
        () => getBleManager().connectToDevice(bleDevice.id),
        `ECG ${bleDevice.label}`,
      );
    }
    return new MockEcgSensor();
  };

  return (
    <ThemedView
      style={[styles.container, { paddingTop: insets.top }]}>

      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        {/* Big live BPM readout */}
        <ThemedView style={styles.hero}>
          <ThemedText type="small" themeColor="textSecondary">
            {staleData
              ? currentReading
                ? 'Sin datos nuevos — revisa el reloj'
                : 'Conectado — esperando FC'
              : STATE_LABELS[connectionState]}
            {connectionState === 'reconnecting' && reconnectAttempt > 0
              ? ` (intento ${reconnectAttempt})`
              : ''}
            {sensorLabel ? ` · ${sensorLabel}` : ''}
          </ThemedText>
          <Animated.Text
            style={[styles.heart, { transform: [{ scale: pulse }] }]}>
            ❤️
          </Animated.Text>
          <ThemedText
            style={[
              styles.bpm,
              { color: belowThreshold ? '#E5484D' : theme.text },
            ]}>
            {currentReading ? currentReading.bpm : '--'}
            {streaming && currentReading ? (
              <ThemedText style={styles.trend}> {trendGlyph}</ThemedText>
            ) : null}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            bpm · umbral {activeThreshold} · eventos: {eventCount}
          </ThemedText>
          {streaming && sessionStartedAt && (
            <ThemedText type="small" themeColor="textSecondary">
              {formatDuration(now - sessionStartedAt)} monitorizando
              {sessionMinBpm !== null && sessionMaxBpm !== null
                ? ` · mín ${sessionMinBpm} · máx ${sessionMaxBpm}`
                : ''}
            </ThemedText>
          )}
        </ThemedView>

        {liveBuckets.length > 1 && (
          <ThemedView style={styles.sparkline}>
            <HrChart
              buckets={liveBuckets}
              thresholdBpm={activeThreshold}
              height={56}
              compact
            />
          </ThemedView>
        )}

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

        {pendingWhatsappMessage !== null && whatsappNumber !== null && (
          <Pressable
            onPress={() => {
              void openWhatsappAlert(
                whatsappNumber,
                pendingWhatsappMessage,
              );
              clearPendingWhatsapp();
            }}
            onLongPress={clearPendingWhatsapp}
            style={[
              styles.alertBox,
              { backgroundColor: '#1F7A46', alignSelf: 'stretch' },
            ]}>
            <ThemedText type="smallBold" style={{ color: '#fff' }}>
              📤 Aviso pendiente — enviar por WhatsApp
            </ThemedText>
            <ThemedText type="small" style={{ color: '#d7f0e0' }}>
              Un toque abre el chat con el aviso ya escrito. Mantén para
              descartar.
            </ThemedText>
          </Pressable>
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
          <Pressable
            onPress={() => setEcgOpen(true)}
            style={[
              styles.chip,
              { backgroundColor: theme.backgroundElement },
            ]}>
            <ThemedText type="small">ECG</ThemedText>
          </Pressable>
        </ThemedView>

        {mode === 'mock' ? (
          <>
            <ThemedView style={styles.row}>
              {(Object.keys(MOCK_SCENARIO_LABELS) as MockScenario[]).map((s) => (
                <Pressable
                  key={s}
                  onPress={() => {
                    setScenario(s);
                    setMockScenario(s);
                  }}
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
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={styles.hint}>
              {MOCK_SCENARIO_LABELS[scenario]} — el simulador finge ese
              ritmo para probar las alertas sin reloj
            </ThemedText>
          </>
        ) : (
          <>
            {!btPoweredOn && (
              <ThemedView type="backgroundElement" style={styles.alertBox}>
                <ThemedText type="smallBold">Bluetooth apagado</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  Enciéndelo para buscar o reconectar sensores
                </ThemedText>
              </ThemedView>
            )}
            {(streaming ||
              connectionState === 'connecting' ||
              connectionState === 'reconnecting') &&
            bleDevice ? (
              <ThemedView type="backgroundElement" style={styles.alertBox}>
                <ThemedText type="smallBold">
                  {connectionState === 'reconnecting'
                    ? `Reconectando a ${bleDevice.label}…`
                    : `✓ ${bleDevice.label} conectado`}
                </ThemedText>
                {staleData && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Esperando datos — activa «Emitir FC» en el reloj
                  </ThemedText>
                )}
              </ThemedView>
            ) : null}
            <Pressable
              onPress={startScan}
              style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">
                {scanning
                  ? 'Buscando…'
                  : streaming
                    ? 'Buscar otros sensores'
                    : 'Buscar sensores BLE'}
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

        <ThemedView style={styles.spacer} />

        <Modal
          visible={ecgOpen}
          animationType="slide"
          onRequestClose={() => setEcgOpen(false)}>
          <ThemedView
            style={[
              styles.ecgModal,
              { paddingTop: insets.top + Spacing.three },
            ]}>
            <EcgPanel
              createSource={makeEcgSource}
              isMock={!(bleDevice && /polar|h10/i.test(bleDevice.label))}
              title={
                bleDevice && /polar|h10/i.test(bleDevice.label)
                  ? `ECG — ${bleDevice.label}`
                  : 'ECG — simulado'
              }
            />
            <Pressable
              onPress={() => setEcgOpen(false)}
              style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
              <ThemedText type="smallBold">Cerrar</ThemedText>
            </Pressable>
          </ThemedView>
        </Modal>

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
  hero: {
    alignItems: 'center',
    gap: Spacing.one,
    paddingTop: Spacing.five,
    paddingBottom: Spacing.three,
  },
  spacer: { flex: 1 },
  heart: { fontSize: 60 },
  bpm: { fontSize: 80, fontWeight: 700, lineHeight: 88 },
  trend: { fontSize: 40, fontWeight: 400 },
  sparkline: { alignSelf: 'stretch', paddingHorizontal: Spacing.two },
  alertBox: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.half,
    marginTop: Spacing.two,
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
  hint: { textAlign: 'center' },
  deviceRow: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
  },
  ecgModal: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.three,
  },
  primaryButton: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#ffffff' },
});
