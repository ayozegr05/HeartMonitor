import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { formatDuration } from '@/domain/morningReport';
import {
  buildWeeklyReport,
  type WeeklyReport,
} from '@/domain/weeklyReport';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { shareWeeklyPdf } from '@/features/reports/exportWeeklyPdf';
import {
  loadSessionReports,
  type SessionWithReport,
} from '@/features/reports/sessionReports';
import { weeklyReportHtml } from '@/features/reports/weeklyReportHtml';
import { useTheme } from '@/hooks/use-theme';

const SOURCE_LABELS: Record<string, string> = {
  ble: 'Bluetooth',
  mock: 'Simulador',
};

function formatRange(startedAt: number, endedAt: number | null): string {
  const start = new Date(startedAt);
  const day = start.toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const from = start.toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  const to = endedAt
    ? new Date(endedAt).toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      })
    : 'en curso';
  return `${day} · ${from} → ${to}`;
}

function ReportCard({ item }: { item: SessionWithReport }) {
  const theme = useTheme();
  const { session, report } = item;
  const live = session.endedAt === null;
  const hasEvents = report.eventCount > 0;

  const metrics: [string, string][] = [
    ['Duración', formatDuration(report.durationMs)],
    [
      'FC media (min–máx)',
      report.avgBpm !== null
        ? `${report.avgBpm} bpm (${report.minBpm}–${report.maxBpm})`
        : '—',
    ],
    [
      'Bajo umbral',
      report.timeBelowThresholdMs > 0
        ? formatDuration(report.timeBelowThresholdMs)
        : '—',
    ],
    [
      'Eventos',
      report.eventCount === 0
        ? 'Ninguno'
        : `⚠️ ${report.bradycardiaCount} bradicardia · ${report.pauseCount} pausa${
            report.pauseCount === 1 ? '' : 's'
          }`,
    ],
    [
      'Pausa más larga',
      report.longestPauseMs !== null ? `${report.longestPauseMs} ms` : '—',
    ],
  ];

  return (
    <ThemedView
      type="backgroundElement"
      style={[styles.card, hasEvents && styles.cardWithEvents]}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          {formatRange(session.startedAt, session.endedAt)}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={{ color: live ? '#2E7D32' : theme.textSecondary }}>
          {live ? 'Monitorizando' : (SOURCE_LABELS[session.source] ?? session.source)}
          {' · '}
          {session.sensorLabel}
        </ThemedText>
      </ThemedView>
      {report.readingsCount === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          Sin lecturas registradas.
        </ThemedText>
      ) : (
        metrics.map(([label, value]) => (
          <ThemedView key={label} style={styles.metricRow}>
            <ThemedText type="small" themeColor="textSecondary">
              {label}
            </ThemedText>
            <ThemedText type="small">{value}</ThemedText>
          </ThemedView>
        ))
      )}
    </ThemedView>
  );
}

function WeeklyCard({ weekly }: { weekly: WeeklyReport }) {
  const theme = useTheme();
  const [exporting, setExporting] = useState(false);

  const exportPdf = async () => {
    setExporting(true);
    try {
      await shareWeeklyPdf(weeklyReportHtml(weekly));
    } catch (e) {
      Alert.alert(
        'No se pudo exportar',
        e instanceof Error ? e.message : 'Error desconocido',
      );
    } finally {
      setExporting(false);
    }
  };

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          Últimos 7 días
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {weekly.sessionsCount} sesiones · {weekly.nightsCovered} noches
          cubiertas
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.metricRow}>
        <ThemedText type="small" themeColor="textSecondary">
          Tiempo monitorizado
        </ThemedText>
        <ThemedText type="small">
          {formatDuration(weekly.totalMonitoredMs)}
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.metricRow}>
        <ThemedText type="small" themeColor="textSecondary">
          FC media (min–máx)
        </ThemedText>
        <ThemedText type="small">
          {weekly.avgBpm !== null
            ? `${weekly.avgBpm} bpm (${weekly.minBpm}–${weekly.maxBpm})`
            : '—'}
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.metricRow}>
        <ThemedText type="small" themeColor="textSecondary">
          Bajo umbral
        </ThemedText>
        <ThemedText type="small">
          {weekly.timeBelowThresholdMs > 0
            ? formatDuration(weekly.timeBelowThresholdMs)
            : '—'}
        </ThemedText>
      </ThemedView>
      <ThemedView style={styles.metricRow}>
        <ThemedText type="small" themeColor="textSecondary">
          Eventos
        </ThemedText>
        <ThemedText type="small">
          {weekly.eventCount === 0
            ? 'Ninguno'
            : `${weekly.eventCount} (${weekly.bradycardiaCount} bradicardia · ${weekly.pauseCount} pausa)`}
        </ThemedText>
      </ThemedView>
      <Pressable
        onPress={exportPdf}
        disabled={exporting || weekly.sessionsCount === 0}
        style={[
          styles.exportButton,
          {
            backgroundColor:
              weekly.sessionsCount === 0
                ? theme.backgroundElement
                : theme.backgroundSelected,
          },
        ]}>
        <ThemedText type="smallBold">
          {exporting ? 'Generando…' : 'Exportar PDF'}
        </ThemedText>
      </Pressable>
    </ThemedView>
  );
}

export default function ReportsScreen() {
  const theme = useTheme();
  const thresholds = useMonitorStore((s) => s.thresholds);
  const [items, setItems] = useState<SessionWithReport[]>([]);
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [onlyWithEvents, setOnlyWithEvents] = useState(false);

  useFocusEffect(
    useCallback(() => {
      loadSessionReports(thresholds)
        .then((loaded) => {
          setItems(loaded);
          setWeekly(
            buildWeeklyReport(
              loaded.map((i) => i.report),
              Date.now(),
            ),
          );
        })
        .catch(() => {
          setItems([]);
          setWeekly(null);
        });
    }, [thresholds]),
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Informes
        </ThemedText>
        {items.some((i) => i.report.eventCount > 0) && (
          <Pressable
            onPress={() => setOnlyWithEvents((v) => !v)}
            style={[
              styles.filterChip,
              {
                backgroundColor: onlyWithEvents
                  ? theme.backgroundSelected
                  : theme.backgroundElement,
              },
            ]}>
            <ThemedText type="small">⚠️ Solo con eventos</ThemedText>
          </Pressable>
        )}
        <FlatList
          ListHeaderComponent={
            weekly && weekly.sessionsCount > 0 && !onlyWithEvents ? (
              <WeeklyCard weekly={weekly} />
            ) : null
          }
          data={
            onlyWithEvents
              ? items.filter((i) => i.report.eventCount > 0)
              : items
          }
          keyExtractor={(i) => String(i.session.id)}
          contentContainerStyle={{ paddingBottom: BottomTabInset }}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary">
              {onlyWithEvents && items.length > 0
                ? 'Ninguna sesión con eventos.'
                : 'Aún no hay sesiones. El informe aparece al terminar de monitorizar.'}
            </ThemedText>
          }
          renderItem={({ item }) => <ReportCard item={item} />}
        />
      </SafeAreaView>
    </ThemedView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, paddingHorizontal: Spacing.four },
  title: { paddingVertical: Spacing.three },
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.one,
  },
  cardWithEvents: {
    borderLeftWidth: 4,
    borderLeftColor: '#D32F2F',
  },
  filterChip: {
    alignSelf: 'flex-start',
    borderRadius: 999,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    marginBottom: Spacing.two,
  },
  exportButton: {
    borderRadius: Spacing.two,
    paddingVertical: Spacing.two,
    alignItems: 'center',
    marginTop: Spacing.two,
  },
  cardHeader: { gap: Spacing.half },
  cardTitle: { fontSize: 16 },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
