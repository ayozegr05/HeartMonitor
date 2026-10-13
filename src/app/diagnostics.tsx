import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
    fetchGarminApiDiagnostics,
    type GarminApiDiagnostics,
} from '@/features/garmin/garminApi';
import {
    GarminAuthError,
    garminConnectedEmail,
    garminLogout,
} from '@/features/garmin/garminClient';
import { useTheme } from '@/hooks/use-theme';

import type { GarminDayPoint } from '@/features/healthconnect/garminSummary';

const DAYS = 30;

const FIELD_LABELS: { key: keyof GarminDayPoint; label: string }[] = [
  { key: 'sleep', label: 'sueño' },
  { key: 'hrvRmssdMs', label: 'VFC' },
  { key: 'spo2AvgPct', label: 'SpO₂' },
  { key: 'respirationPerMin', label: 'resp' },
  { key: 'restingBpm', label: 'reposo' },
  { key: 'steps', label: 'pasos' },
  { key: 'hrMaxBpm', label: 'FC' },
];

/**
 * Provisional diagnostics screen: for each of the last 14 days shows which
 * endpoint of the Garmin account API actually produced data (and which
 * threw), so API gaps can be told apart from parser gaps.
 */
export default function DiagnosticsScreen() {
  const theme = useTheme();
  const [email, setEmail] = useState<string | null>(null);
  const [diag, setDiag] = useState<GarminApiDiagnostics | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [queriedAt, setQueriedAt] = useState<number | null>(null);

  const checkAccount = useCallback(() => {
    garminConnectedEmail()
      .then(setEmail)
      .catch(() => setEmail(null));
  }, []);

  useEffect(() => {
    checkAccount();
  }, [checkAccount]);

  const query = async () => {
    setLoading(true);
    setError(null);
    try {
      setDiag(await fetchGarminApiDiagnostics(DAYS));
      setQueriedAt(Date.now());
    } catch (e) {
      setDiag(null);
      setError(
        e instanceof GarminAuthError
          ? `${e.message} (código: ${e.code})`
          : e instanceof Error
            ? e.message
            : 'Error desconocido',
      );
    } finally {
      setLoading(false);
    }
  };

  const unlink = () => {
    garminLogout()
      .then(() => {
        setEmail(null);
        setDiag(null);
      })
      .catch(() => {});
  };

  const mark = (ok: boolean) => (ok ? '✓' : '·');

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Diagnóstico
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary" style={styles.note}>
          Provisional — qué devuelve cada endpoint de Garmin por día: ✓ datos,
          · vacío (día sin registro), ⚠ error de llamada.
        </ThemedText>

        <FlatList
          data={diag?.days ?? []}
          keyExtractor={(r) => r.day}
          contentContainerStyle={{ paddingBottom: BottomTabInset }}
          ListHeaderComponent={
            <>
              <ThemedView type="backgroundElement" style={styles.card}>
                <ThemedText type="smallBold" style={styles.cardTitle}>
                  Cuenta Garmin
                </ThemedText>
                <ThemedText type="small" themeColor="textSecondary">
                  {email
                    ? `vinculada: ${email}`
                    : 'sin vincular — Ajustes → Cuenta Garmin'}
                </ThemedText>
                <View style={styles.buttonRow}>
                  <Pressable
                    onPress={query}
                    disabled={loading || !email}
                    style={[
                      styles.button,
                      {
                        backgroundColor: theme.backgroundSelected,
                        opacity: loading || !email ? 0.5 : 1,
                      },
                    ]}>
                    <ThemedText type="smallBold">
                      {loading ? 'Consultando…' : 'Consultar API ahora'}
                    </ThemedText>
                  </Pressable>
                  {email && (
                    <Pressable
                      onPress={unlink}
                      style={[
                        styles.button,
                        { backgroundColor: theme.backgroundElement },
                      ]}>
                      <ThemedText type="small">Desvincular</ThemedText>
                    </Pressable>
                  )}
                </View>
                {error && (
                  <ThemedText type="small" style={{ color: '#E5484D' }}>
                    {error}
                  </ThemedText>
                )}
                {queriedAt && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Última consulta:{' '}
                    {new Date(queriedAt).toLocaleTimeString(undefined, {
                      hour: '2-digit',
                      minute: '2-digit',
                      second: '2-digit',
                    })}
                  </ThemedText>
                )}
              </ThemedView>

              {diag && (
                <ThemedView type="backgroundElement" style={styles.card}>
                  <ThemedText type="smallBold" style={styles.cardTitle}>
                    Endpoints de rango
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    VFC (30 días):{' '}
                    {diag.hrvError
                      ? `⚠ ${diag.hrvError}`
                      : `${diag.hrvDays} días con datos`}
                  </ThemedText>
                  <ThemedText type="small" themeColor="textSecondary">
                    Estadísticas diarias (rango):{' '}
                    {diag.dailyStatsError
                      ? `⚠ ${diag.dailyStatsError}`
                      : `${diag.dailyStatsDays} días con datos`}
                  </ThemedText>
                </ThemedView>
              )}

              {diag && (
                <ThemedText type="smallBold" style={styles.listTitle}>
                  Campos obtenidos por día (⚠ debajo = endpoint que falló)
                </ThemedText>
              )}
            </>
          }
          renderItem={({ item }) => (
            <ThemedView type="backgroundElement" style={styles.dayRow}>
              <ThemedText type="smallBold" style={styles.dayLabel}>
                {item.day.slice(5)}
              </ThemedText>
              <View style={styles.fieldRow}>
                {item.point ? (
                  FIELD_LABELS.map(({ key, label }) => {
                    const present = item.point![key] !== undefined;
                    return (
                      <ThemedText
                        key={key}
                        type="small"
                        style={{
                          color: present
                            ? '#2E7D32'
                            : theme.backgroundSelected,
                        }}>
                        {mark(present)} {label}
                      </ThemedText>
                    );
                  })
                ) : (
                  <ThemedText type="small" themeColor="textSecondary">
                    sin datos
                  </ThemedText>
                )}
              </View>
              {item.errors.length > 0 && (
                <ThemedText type="small" style={{ color: '#FFB020' }}>
                  ⚠ {item.errors.join(' · ')}
                </ThemedText>
              )}
            </ThemedView>
          )}
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, paddingHorizontal: Spacing.four },
  title: { paddingVertical: Spacing.three, alignSelf: 'center' },
  note: { paddingBottom: Spacing.two },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.one,
  },
  cardTitle: { fontSize: 16 },
  buttonRow: { flexDirection: 'row', gap: Spacing.two },
  button: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    paddingHorizontal: Spacing.three,
    alignItems: 'center',
  },
  listTitle: { paddingVertical: Spacing.two },
  dayRow: {
    borderRadius: Spacing.two,
    padding: Spacing.two,
    marginBottom: Spacing.one,
    flexDirection: 'row',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: 2,
  },
  dayLabel: { width: 40 },
  fieldRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: Spacing.two,
    flex: 1,
  },
});
