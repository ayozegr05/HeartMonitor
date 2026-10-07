import { useState } from 'react';
import { Pressable, StyleSheet, TextInput } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { useTheme } from '@/hooks/use-theme';

export default function SettingsScreen() {
  const theme = useTheme();
  const { thresholds, setThresholds } = useMonitorStore();

  const [dayLow, setDayLow] = useState(String(thresholds.dayLowBpm));
  const [nightLow, setNightLow] = useState(String(thresholds.nightLowBpm));
  const [sustained, setSustained] = useState(
    String(Math.round(thresholds.sustainedMs / 1000)),
  );
  const [saved, setSaved] = useState(false);

  const save = () => {
    const day = parseInt(dayLow, 10);
    const night = parseInt(nightLow, 10);
    const secs = parseInt(sustained, 10);
    if ([day, night, secs].some(Number.isNaN)) return;

    setThresholds({
      ...thresholds,
      dayLowBpm: day,
      nightLowBpm: night,
      sustainedMs: secs * 1000,
    });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  };

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Umbrales de alerta
        </ThemedText>

        {[
          {
            label: 'FC mínima diurna (bpm)',
            value: dayLow,
            setter: setDayLow,
            hint: 'Despierto: alerta si baja de este valor',
          },
          {
            label: 'FC mínima nocturna (bpm)',
            value: nightLow,
            setter: setNightLow,
            hint: '23:00–07:00 · en sueño es normal latir más lento',
          },
          {
            label: 'Tiempo sostenido (s)',
            value: sustained,
            setter: setSustained,
            hint: 'Segundos bajo el umbral antes de alertar',
          },
        ].map(({ label, value, setter, hint }) => (
          <ThemedView key={label} style={styles.field}>
            <ThemedText type="smallBold">{label}</ThemedText>
            <TextInput
              value={value}
              onChangeText={setter}
              keyboardType="number-pad"
              style={[
                styles.input,
                { color: theme.text, borderColor: theme.backgroundSelected },
              ]}
            />
            <ThemedText type="small" themeColor="textSecondary">
              {hint}
            </ThemedText>
          </ThemedView>
        ))}

        <Pressable
          onPress={save}
          style={[styles.button, { backgroundColor: '#2E7D32' }]}>
          <ThemedText type="smallBold" style={styles.buttonText}>
            {saved ? 'Guardado ✓' : 'Guardar'}
          </ThemedText>
        </Pressable>

        <ThemedText type="small" themeColor="textSecondary" style={styles.disclaimer}>
          Esta app no es un dispositivo médico. Ajusta los umbrales con la
          orientación de tu cardiólogo.
        </ThemedText>
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
    paddingBottom: BottomTabInset,
    gap: Spacing.four,
  },
  title: { paddingVertical: Spacing.three },
  field: { gap: Spacing.one },
  input: {
    borderWidth: 1,
    borderRadius: Spacing.two,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    fontSize: 18,
  },
  button: {
    borderRadius: Spacing.three,
    paddingVertical: Spacing.three,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  buttonText: { color: '#ffffff' },
  disclaimer: { textAlign: 'center' },
});
