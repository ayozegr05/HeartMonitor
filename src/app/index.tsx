import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Animated, Pressable, ScrollView, StyleSheet } from 'react-native';
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
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { useTheme } from '@/hooks/use-theme';
import { getBleManager } from '@/sensors/bleManager';
import {
    MOCK_SCENARIO_LABELS,
    type MockScenario,
} from '@/sensors/MockHeartRateSensor';
import type { IEcgSource } from '@/sensors/ecg';
import { MockEcgSensor } from '@/sensors/polar/MockEcgSensor';
import { PolarEcgSource } from '@/sensors/polar/PolarEcgSource';

const STATE_LABELS: Record<string, string> = {
  idle: 'Inactivo',
  connecting: 'Conectando…',
  streaming: 'Monitorizando',
  disconnected: 'Desconectado',
  reconnecting: 'Reconectando…',
  error: 'Error',
};

type MonitorTab = 'fc' | 'ecg' | 'mock';
const TABS: { key: MonitorTab; label: string }[] = [
  { key: 'fc', label: 'FC' },
  { key: 'ecg', label: 'ECG' },
  { key: 'mock', label: 'Simulador' },
];

export default function MonitorScreen() {
  const theme = useTheme();
  const router = useRouter();
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
    startMock,
    startBle,
    stop,
    setMockScenario,
  } = useMonitorStore();

  const streaming = connectionState === 'streaming';
  const insets = useSafeAreaInsets();
  const [tab, setTab] = useState<MonitorTab>('fc');
  const [scenario, setScenario] = useState<MockScenario>('normal');
  const [error, setError] = useState<string | null>(null);

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

  const isPolar = !!bleDevice && /polar|h10/i.test(bleDevice.label);

  /** ECG source: the real Polar PMD stream on the strap, else the mock. */
  const makeEcgSource = (): IEcgSource => {
    if (isPolar && bleDevice) {
      return new PolarEcgSource(
        () => getBleManager().connectToDevice(bleDevice.id),
        `ECG ${bleDevice.label}`,
      );
    }
    return new MockEcgSensor();
  };

  const onStart = async () => {
    setError(null);
    try {
      if (tab === 'mock') {
        await startMock(scenario);
      } else if (bleDevice) {
        await startBle(bleDevice.id);
      }
    } catch {
      setError('No se pudo iniciar la monitorización');
    }
  };

  return (
    <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        {/* Mode switcher: FC monitor / ECG / Simulator */}
        <ThemedView style={styles.row}>
          {TABS.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[
                styles.chip,
                { backgroundColor: theme.backgroundElement },
                tab === t.key && {
                  backgroundColor: theme.backgroundSelected,
                },
              ]}>
              <ThemedText type="small">{t.label}</ThemedText>
            </Pressable>
          ))}
        </ThemedView>

        {tab === 'ecg' ? (
          <ScrollView
            style={styles.ecgScroll}
            contentContainerStyle={styles.ecgScrollContent}>
            <EcgPanel
              createSource={makeEcgSource}
              isMock={!isPolar}
              liveStatus={
                streaming
                  ? `❤️ ${currentReading ? currentReading.bpm : '—'} bpm · monitorizando`
                  : 'monitor parado'
              }
              title={isPolar ? `ECG — ${bleDevice?.label}` : 'ECG — simulado'}
            />
          </ScrollView>
        ) : (
          <>
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

            {tab === 'fc' ? (
              <>
                {connectionState === 'reconnecting' && bleDevice && (
                  <ThemedView
                    type="backgroundElement"
                    style={styles.alertBox}>
                    <ThemedText type="smallBold">
                      Reconectando a {bleDevice.label}…
                    </ThemedText>
                  </ThemedView>
                )}
                {!streaming && !bleDevice && (
                  <ThemedView
                    type="backgroundElement"
                    style={styles.alertBox}>
                    <ThemedText type="smallBold">Sin banda elegida</ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      Busca tu Polar H10 desde Ajustes → Conectividad
                    </ThemedText>
                    <Pressable
                      onPress={() => router.push('/settings')}
                      style={[
                        styles.button,
                        { backgroundColor: theme.backgroundSelected },
                      ]}>
                      <ThemedText type="smallBold">
                        Ir a Conectividad
                      </ThemedText>
                    </Pressable>
                  </ThemedView>
                )}
              </>
            ) : (
              <>
                <ThemedView style={styles.row}>
                  {(Object.keys(MOCK_SCENARIO_LABELS) as MockScenario[]).map(
                    (s) => (
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
                    ),
                  )}
                </ThemedView>
                <ThemedText
                  type="small"
                  themeColor="textSecondary"
                  style={styles.hint}>
                  {MOCK_SCENARIO_LABELS[scenario]} — el simulador finge ese
                  ritmo para probar las alertas sin banda
                </ThemedText>
              </>
            )}

            {error && (
              <ThemedText type="small" themeColor="textSecondary">
                {error}
              </ThemedText>
            )}

            <ThemedView style={styles.spacer} />

            <Pressable
              onPress={() => (streaming ? stop() : onStart())}
              disabled={!streaming && tab !== 'mock' && !bleDevice}
              style={[
                styles.primaryButton,
                {
                  backgroundColor: streaming
                    ? '#B3261E'
                    : !bleDevice && tab !== 'mock'
                      ? theme.backgroundElement
                      : '#2E7D32',
                },
              ]}>
              <ThemedText type="smallBold" style={styles.primaryButtonText}>
                {streaming
                  ? 'Detener'
                  : tab === 'mock'
                    ? 'Iniciar simulación'
                    : bleDevice
                      ? `Iniciar con ${bleDevice.label}`
                      : 'Elige una banda en Ajustes'}
              </ThemedText>
            </Pressable>
          </>
        )}
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
    alignSelf: 'center',
  },
  ecgScroll: { alignSelf: 'stretch', flex: 1 },
  ecgScrollContent: { gap: Spacing.two },
  hint: { textAlign: 'center' },
  primaryButton: {
    alignSelf: 'stretch',
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  primaryButtonText: { color: '#ffffff' },
});
