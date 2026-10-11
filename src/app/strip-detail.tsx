import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import {
  Alert,
  Dimensions,
  Pressable,
  ScrollView,
  StyleSheet,
  View,
} from 'react-native';
import {
    SafeAreaView,
    useSafeAreaInsets,
} from 'react-native-safe-area-context';

import { EcgStrip } from '@/components/ecg-strip';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { Spacing } from '@/constants/theme';
import {
    shareStripCsv,
    shareStripPdf,
} from '@/features/ecg/exportStrip';
import {
    loadStrips,
    type CapturedStrip,
} from '@/features/ecg/stripStore';
import { useTheme } from '@/hooks/use-theme';

/** ~8 s of trace per screen-width at 130 Hz — scroll reveals the rest. */
const SCREENS_WIDE = 4;

function Metric({ label, value }: { label: string; value: string }) {
  const theme = useTheme();
  return (
    <View style={[styles.metric, { borderColor: theme.backgroundSelected }]}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText type="smallBold">{value}</ThemedText>
    </View>
  );
}

export default function StripDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { ts } = useLocalSearchParams<{ ts: string }>();
  const [strip, setStrip] = useState<CapturedStrip | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    const wanted = Number(ts);
    loadStrips()
      .then((all) => {
        const found = all.find((s) => s.timestamp === wanted) ?? null;
        setStrip(found);
        setNotFound(found === null);
      })
      .catch(() => setNotFound(true));
  }, [ts]);

  const stripWidth = Dimensions.get('window').width * SCREENS_WIDE;
  const seconds =
    strip && strip.sampleRateHz > 0
      ? strip.samples.length / strip.sampleRateHz
      : 0;

  return (
    <ThemedView style={[styles.container, { paddingTop: insets.top }]}>
      <SafeAreaView style={styles.safeArea} edges={['bottom']}>
        <ScrollView contentContainerStyle={styles.scrollContent}>
          <View style={styles.header}>
            <Pressable onPress={() => router.back()} hitSlop={12}>
              <ThemedText type="smallBold">‹ Volver</ThemedText>
            </Pressable>
            <ThemedText type="smallBold">Tira ECG</ThemedText>
          </View>

          {notFound && (
            <ThemedText type="small" themeColor="textSecondary">
              No se encontró la tira — pudo haberse borrado.
            </ThemedText>
          )}

          {strip && (
            <>
              <ThemedText type="small" themeColor="textSecondary">
                {new Date(strip.timestamp).toLocaleString(undefined, {
                  day: 'numeric',
                  month: 'short',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
                {' · '}
                {seconds.toFixed(0)} s{strip.auto ? ' · auto' : ' · manual'}
                {strip.label ? ` · ${strip.label}` : ''}
              </ThemedText>

              {/* Scrollable waveform — drag sideways to walk the strip */}
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator
                style={styles.waveScroll}>
                <View style={{ width: stripWidth }}>
                  <EcgStrip samples={strip.samples} height={240} />
                </View>
              </ScrollView>
              <ThemedText type="small" themeColor="textSecondary">
                desliza para recorrer la tira
              </ThemedText>

              {/* Pattern report */}
              <ThemedView type="backgroundElement" style={styles.card}>
                <ThemedText type="smallBold">
                  📋 Análisis del trazado
                </ThemedText>
                <View style={styles.metricsGrid}>
                  <Metric
                    label="latidos"
                    value={String(strip.report.beats)}
                  />
                  <Metric
                    label="FC media"
                    value={`${strip.report.meanBpm} bpm`}
                  />
                  <Metric
                    label="QRS medio"
                    value={`${Math.round(strip.report.meanQrsWidthMs)} ms`}
                  />
                  <Metric
                    label="PR medio"
                    value={
                      strip.report.meanPrMs !== undefined
                        ? `${strip.report.meanPrMs} ms`
                        : '—'
                    }
                  />
                  <Metric
                    label="latidos bloqueados"
                    value={String(strip.report.droppedBeats)}
                  />
                  <Metric
                    label="P ausente"
                    value={`${Math.round(strip.report.pMissingFraction * 100)}%`}
                  />
                  <Metric
                    label="irregularidad RR"
                    value={strip.report.rrIrregularity.toFixed(2)}
                  />
                </View>
                {strip.report.flags.length === 0 ? (
                  <ThemedText type="small" themeColor="textSecondary">
                    Sin patrones llamativos en esta tira.
                  </ThemedText>
                ) : (
                  strip.report.flags.map((f) => (
                    <ThemedText
                      key={f}
                      type="small"
                      style={{ color: '#FFB020' }}>
                      ⚠️ {f}
                    </ThemedText>
                  ))
                )}
                <ThemedText type="small" themeColor="textSecondary">
                  Lectura orientativa — enseña la tira a tu cardiólogo para
                  confirmar cualquier patrón.
                </ThemedText>
              </ThemedView>

              <View style={styles.buttons}>
                <Pressable
                  onPress={() =>
                    shareStripPdf(strip).catch((e) =>
                      Alert.alert(
                        'No se pudo exportar',
                        e instanceof Error ? e.message : 'Error desconocido',
                      ),
                    )
                  }
                  style={[
                    styles.exportButton,
                    { backgroundColor: theme.backgroundSelected },
                  ]}>
                  <ThemedText type="smallBold">PDF</ThemedText>
                </Pressable>
                <Pressable
                  onPress={() =>
                    shareStripCsv(strip).catch((e) =>
                      Alert.alert(
                        'No se pudo exportar',
                        e instanceof Error ? e.message : 'Error desconocido',
                      ),
                    )
                  }
                  style={[
                    styles.exportButton,
                    { backgroundColor: theme.backgroundSelected },
                  ]}>
                  <ThemedText type="smallBold">CSV</ThemedText>
                </Pressable>
              </View>
            </>
          )}
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scrollContent: {
    paddingHorizontal: Spacing.four,
    paddingBottom: Spacing.five,
    gap: Spacing.three,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
    paddingVertical: Spacing.two,
  },
  waveScroll: {
    alignSelf: 'stretch',
    borderRadius: Spacing.two,
  },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
  },
  metric: {
    borderRadius: Spacing.two,
    borderWidth: StyleSheet.hairlineWidth,
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    alignItems: 'center',
    minWidth: '28%',
    flexGrow: 1,
  },
  buttons: { flexDirection: 'row', gap: Spacing.two },
  exportButton: {
    flex: 1,
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
  },
});
