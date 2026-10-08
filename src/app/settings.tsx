import * as IntentLauncher from 'expo-intent-launcher';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import {
    Alert,
    Modal,
    Platform,
    Pressable,
    ScrollView,
    StyleSheet,
    TextInput
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, MaxContentWidth, Spacing } from '@/constants/theme';
import { getRecentSessions } from '@/data/readingsRepository';
import {
    exportBackup,
    importBackup,
    importBackupFromUri,
    listBackupsInFolder,
    pickBackupFolder,
    type BackupEntry
} from '@/features/backup/deviceBackup';
import { restoreFromHealthConnect } from '@/features/healthconnect/healthConnectRestore';
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
  const thresholds = useMonitorStore((s) => s.thresholds);
  const [status, setStatus] = useState<HealthConnectAvailability | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreMsg, setRestoreMsg] = useState<string | null>(null);

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
      {status === 'available' && (
        <Pressable
          onPress={async () => {
            setRestoring(true);
            setRestoreMsg(null);
            try {
              const res = await restoreFromHealthConnect(thresholds);
              setRestoreMsg(
                res === null
                  ? 'No se pudo acceder a Health Connect.'
                  : res.importedReadings === 0 && res.restoredSessions === 0
                    ? 'No hay lecturas nuevas que restaurar.'
                    : `${res.importedReadings} lecturas · ${res.importedBradycardias} bradicardias · ${res.restoredSessions} sesiones restauradas`,
              );
            } catch {
              setRestoreMsg('La restauración falló.');
            } finally {
              setRestoring(false);
            }
          }}
          disabled={restoring}
          style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
          <ThemedText type="smallBold">
            {restoring ? 'Restaurando…' : 'Restaurar histórico'}
          </ThemedText>
        </Pressable>
      )}
      {restoreMsg !== null && (
        <ThemedText type="small" themeColor="textSecondary">
          {restoreMsg}
        </ThemedText>
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

/**
 * Manual backup card. Android Auto Backup already mirrors the DB silently
 * (see plugins/withAndroidAutoBackup); this adds the user-visible export/
 * import plus a one-time nag the first time real history is at stake.
 */
/** Decodes a SAF tree uri like "primary:Documents/HeartMonitor" for display. */
function folderDisplayName(directoryUri: string): string {
  const tail = decodeURIComponent(directoryUri).split('/tree/').pop() ?? '';
  return tail.replace(/^primary:/, '');
}

function BackupCard() {
  const theme = useTheme();
  const {
    lastBackupExportAt,
    backupNagDismissed,
    backupFolderUri,
    setLastBackupExportAt,
    setBackupNagDismissed,
    setBackupFolderUri,
  } = useMonitorStore();
  const [busy, setBusy] = useState<'export' | 'import' | null>(null);
  const [importList, setImportList] = useState<BackupEntry[] | null>(null);

  const ensureFolder = async (): Promise<string | null> => {
    if (backupFolderUri) return backupFolderUri;
    const uri = await pickBackupFolder();
    if (uri) setBackupFolderUri(uri);
    return uri;
  };

  useFocusEffect(
    useCallback(() => {
      if (lastBackupExportAt !== null || backupNagDismissed) return;
      getRecentSessions(3)
        .then((sessions) => {
          if (sessions.length >= 3) {
            Alert.alert(
              'Protege tu histórico',
              'Tus datos solo viven en esta app y se pierden al desinstalarla. ' +
                'Android ya guarda una copia automática, y aquí puedes exportar ' +
                'un archivo de respaldo cuando quieras.',
              [{ text: 'Entendido', onPress: setBackupNagDismissed }],
            );
          }
        })
        .catch(() => {});
    }, [lastBackupExportAt, backupNagDismissed, setBackupNagDismissed]),
  );

  const doExport = async () => {
    setBusy('export');
    try {
      const dir = await ensureFolder();
      if (!dir) return;
      const res = await exportBackup(dir);
      setLastBackupExportAt(Date.now());
      Alert.alert(
        'Copia guardada',
        `${res.fileName}\n${res.readings} lecturas · ${res.events} eventos · ${res.sessions} sesiones`,
      );
    } catch {
      Alert.alert('Error', 'No se pudo exportar la copia.');
    } finally {
      setBusy(null);
    }
  };

  const importFromUri = async (uri: string) => {
    setImportList(null);
    setBusy('import');
    try {
      const res = await importBackupFromUri(uri);
      Alert.alert(
        'Copia importada',
        `${res.readings} lecturas · ${res.events} eventos · ${res.sessions} sesiones nuevos`,
      );
    } catch {
      Alert.alert('Error', 'El archivo no es una copia válida de HeartMonitor.');
    } finally {
      setBusy(null);
    }
  };

  const doImport = async () => {
    try {
      const dir = backupFolderUri ?? (await ensureFolder());
      if (dir) {
        const files = await listBackupsInFolder(dir);
        if (files.length > 0) {
          setImportList(files);
          return;
        }
      }
      // No folder or no backups inside it — fall back to the system picker.
      await doImportPicker();
    } catch {
      Alert.alert('Error', 'El archivo no es una copia válida de HeartMonitor.');
    }
  };

  const doImportPicker = async () => {
    setImportList(null);
    setBusy('import');
    try {
      const res = await importBackup();
      if (res) {
        Alert.alert(
          'Copia importada',
          `${res.readings} lecturas · ${res.events} eventos · ${res.sessions} sesiones nuevos`,
        );
      }
    } catch {
      Alert.alert('Error', 'El archivo no es una copia válida de HeartMonitor.');
    } finally {
      setBusy(null);
    }
  };

  const changeFolder = async () => {
    const uri = await pickBackupFolder();
    if (uri) setBackupFolderUri(uri);
  };

  return (
    <ThemedView style={styles.field}>
      <ThemedText type="smallBold">Copia de seguridad</ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        Copia automática de Android: activa
        {lastBackupExportAt
          ? ` · última exportación ${new Date(lastBackupExportAt).toLocaleString()}`
          : ' · sin exportaciones manuales aún'}
      </ThemedText>
      <Pressable onPress={() => void changeFolder()}>
        <ThemedText type="small" themeColor="textSecondary">
          {backupFolderUri
            ? `Carpeta: ${folderDisplayName(backupFolderUri)} (tocar para cambiar)`
            : 'Elige la carpeta donde guardar las copias (se pide una vez)'}
        </ThemedText>
      </Pressable>
      <Pressable
        onPress={() => void doExport()}
        disabled={busy !== null}
        style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold">
          {busy === 'export' ? 'Exportando…' : 'Exportar copia'}
        </ThemedText>
      </Pressable>
      <Pressable
        onPress={() => void doImport()}
        disabled={busy !== null}
        style={[styles.button, { backgroundColor: theme.backgroundElement }]}>
        <ThemedText type="smallBold">
          {busy === 'import' ? 'Importando…' : 'Importar copia'}
        </ThemedText>
      </Pressable>
      <ThemedText type="small" themeColor="textSecondary">
        Exporta lecturas, eventos y sesiones a un JSON en la carpeta que
        elijas; importar lista los backups de esa misma carpeta.
      </ThemedText>

      <Modal
        visible={importList !== null}
        transparent
        animationType="fade"
        onRequestClose={() => setImportList(null)}>
        <Pressable
          style={styles.modalBackdrop}
          onPress={() => setImportList(null)}>
          <ThemedView style={styles.modalCard}>
            <ThemedText type="smallBold">Elige una copia</ThemedText>
            <ScrollView style={styles.modalList}>
              {(importList ?? []).map((f) => (
                <Pressable
                  key={f.uri}
                  onPress={() => void importFromUri(f.uri)}
                  style={[
                    styles.button,
                    { backgroundColor: theme.backgroundElement },
                  ]}>
                  <ThemedText type="small">{f.name}</ThemedText>
                </Pressable>
              ))}
            </ScrollView>
            <Pressable
              onPress={() => void doImportPicker()}
              style={[
                styles.button,
                { backgroundColor: theme.backgroundSelected },
              ]}>
              <ThemedText type="smallBold">Buscar otro archivo…</ThemedText>
            </Pressable>
          </ThemedView>
        </Pressable>
      </Modal>
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
        <ScrollView
          style={styles.scroll}
          contentContainerStyle={styles.scrollContent}
          showsVerticalScrollIndicator={false}>
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

        {Platform.OS === 'android' && <BackupCard />}

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

          <ThemedText
            type="small"
            themeColor="textSecondary"
            style={styles.disclaimer}>
            Esta app no es un dispositivo médico. Ajusta los umbrales con la
            orientación de tu cardiólogo.
          </ThemedText>
        </ScrollView>
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1 },
  scroll: {
    flex: 1,
    alignSelf: 'center',
    width: '100%',
    maxWidth: MaxContentWidth,
  },
  scrollContent: {
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
  modalBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    justifyContent: 'center',
    padding: Spacing.four,
  },
  modalCard: {
    borderRadius: Spacing.three,
    padding: Spacing.four,
    gap: Spacing.two,
    maxHeight: '70%',
  },
  modalList: { flexGrow: 0 },
});
