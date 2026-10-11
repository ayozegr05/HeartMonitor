import { ScrollView, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { PATTERN_CATALOG } from '@/domain/patternInfo';

const DEVICE_ROWS: { device: string; caps: string }[] = [
  { device: 'Polar H10', caps: 'FC · bradicardia · pausas · VFC · ECG' },
  {
    device: 'Otra banda / óptico (OH1, Wahoo, HRM)',
    caps: 'FC · bradicardia · pausas · VFC — sin ECG',
  },
  { device: 'Reloj (Instinct, etc.)', caps: 'FC · bradicardia — solo eso' },
];

/** Guía tab — how detection works + the pattern catalogue in plain words. */
export default function LearnScreen() {
  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ScrollView
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
          <ThemedText type="subtitle" style={styles.title}>
            Guía
          </ThemedText>

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">🧭 Cómo detecta la app</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Con la FC se vigilan bradicardias (bajo tu umbral día/noche).
              Con los intervalos RR se cazan las pausas. Y con el ECG de la
              H10 se analiza la forma de cada latido: onda P, duración QRS,
              intervalo PR — de ahí salen los patrones de abajo.
            </ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              Todo son lecturas orientativas: «patrón compatible con…» —
              nunca un diagnóstico. La tira es la evidencia para tu
              cardiólogo.
            </ThemedText>
          </ThemedView>

          <ThemedView type="backgroundElement" style={styles.card}>
            <ThemedText type="smallBold">
              ⌚ Qué detecta cada dispositivo
            </ThemedText>
            {DEVICE_ROWS.map((r) => (
              <View key={r.device} style={styles.deviceRow}>
                <ThemedText type="smallBold">{r.device}</ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {r.caps}
                </ThemedText>
              </View>
            ))}
          </ThemedView>

          <ThemedText type="smallBold" style={styles.sectionTitle}>
            Patrones que la app reconoce
          </ThemedText>
          {PATTERN_CATALOG.map((p) => (
            <ThemedView
              key={p.id}
              type="backgroundElement"
              style={styles.card}>
              <ThemedText type="smallBold">{p.title}</ThemedText>
              <ThemedText type="small" themeColor="textSecondary">
                {p.what}
              </ThemedText>
              <ThemedText type="small">{p.explain}</ThemedText>
              <ThemedText type="small" style={{ color: '#FFB020' }}>
                {p.note}
              </ThemedText>
            </ThemedView>
          ))}

          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.footer}>
            HeartMonitor no es un dispositivo médico — es un vigilante que
            te guarda las pruebas. Cualquier flag repetido o con síntomas,
            al cardiólogo con la tira.
          </ThemedText>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: {
    flex: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
    paddingHorizontal: Spacing.four,
  },
  scrollContent: {
    paddingBottom: BottomTabInset + Spacing.three,
    gap: Spacing.three,
  },
  title: { paddingVertical: Spacing.three, alignSelf: 'center' },
  sectionTitle: { alignSelf: 'flex-start' },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    gap: Spacing.two,
  },
  deviceRow: { gap: Spacing.half },
  footer: { textAlign: 'center', paddingVertical: Spacing.two },
});
