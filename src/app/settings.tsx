import { useCallback, useState } from 'react';
import { Alert, Platform, Pressable, StyleSheet, TextInput } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import * as IntentLauncher from 'expo-intent-launcher';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import {
  healthConnectStatus,
  requestHealthConnectAccess,
  type HealthConnectAvailability,
} from '@/features/healthconnect/healthConnectSync';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { useTheme } from '@/hooks/use-theme';

const HC_STATUS_LABELS: Record<HealthConnectAvailability, string> = {
  available: 'Disponible',
  needs_update: 'Requiere actualizar Health Connect',
  unavailable: 'No disponible en este dispositivo',
  not_android: 'Solo en Android',
};

function HealthConnectCard() {
  const theme = useTheme();
  const {
    healthConnectEnabled,
    lastHcSyncAt,
    setHealthConnectEnabled,
    syncHealthConnect,
  } = useMonitorStore();
  const [status, setStatus] = useState<HealthConnectAvailability | null>(null);
  const [busy, setBusy] = useState(false);

  useFocusEffect(
    useCallback(() => {
      healthConnectStatus().then(setStatus).catch(() => setStatus(null));
    }, []),
  );

  const enable = async () => {
    setBusy(true);
    try {
      const granted = await requestHealthConnectAccess();
      if (granted) {
        setHealthConnectEnabled(true);
      } else {
        Alert.alert(
          'Permiso denegado',
          'Health Connect no concedió acceso de escritura a la frecuencia cardíaca.',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <ThemedView style={styles.field}>
      <ThemedText type="smallBold">Health Connect</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {status === null ? 'Comprobando…' : HC_STATUS_LABELS[status]}
        {healthConnectEnabled
          ? ` · sincronizado${
              lastHcSyncAt
                ? ` hasta ${new Date(lastHcSyncAt).toLocaleString()}`
                : ''
            }`
          : ''}
      </ThemedText>
      {status === 'available' && !healthConnectEnabled && (
        <Pressable
          onPress={enable}
          disabled={busy}
          style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">
            {busy ? 'Solicitando…' : 'Activar sincronización'}
          </ThemedText>
        </Pressable>
      )}
      {healthConnectEnabled && (
        <>
          <Pressable
            onPress={() => void syncHealthConnect()}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundElement },
            ]}>
            <ThemedText type="smallBold">Sincronizar ahora</ThemedText>
          </Pressable>
          <Pressable
            onPress={() => setHealthConnectEnabled(false)}
            style={[
              styles.button,
              { backgroundColor: theme.backgroundElement },
            ]}>
            <ThemedText type="smallBold">Desactivar</ThemedText>
          </Pressable>
        </>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        Copia las lecturas de FC al almacén de Health Connect del móvil al
        terminar cada sesión y al abrir la app. Todo sigue en el dispositivo.
      </ThemedText>
    </ThemedView>
  );
}

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

        {Platform.OS === 'android' && <HealthConnectCard />}

        {Platform.OS === 'android' && (
          <ThemedView style={styles.field}>
            <ThemedText type="smallBold">Monitorización nocturna</ThemedText>
            <Pressable
              onPress={() =>
                IntentLauncher.startActivityAsync(
                  IntentLauncher.ActivityAction
                    .IGNORE_BATTERY_OPTIMIZATION_SETTINGS,
                ).catch(() => {})
              }
              style={[
                styles.button,
                { backgroundColor: theme.backgroundElement },
              ]}>
              <ThemedText type="smallBold">
                Desactivar optimización de batería
              </ThemedText>
            </Pressable>
            <ThemedText type="small" themeColor="textSecondary">
              Si el sistema mata la app por la noche, exclúyela de la
              optimización en los ajustes que se abren con este botón.
            </ThemedText>
          </ThemedView>
        )}

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
