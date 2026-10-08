import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { formatDuration } from '@/domain/morningReport';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import {
  loadSessionReports,
  type SessionWithReport,
} from '@/features/reports/sessionReports';
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
        : `${report.bradycardiaCount} bradicardia · ${report.pauseCount} pausa${
            report.pauseCount === 1 ? '' : 's'
          }`,
    ],
    [
      'Pausa más larga',
      report.longestPauseMs !== null ? `${report.longestPauseMs} ms` : '—',
    ],
  ];

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
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

export default function ReportsScreen() {
  const thresholds = useMonitorStore((s) => s.thresholds);
  const [items, setItems] = useState<SessionWithReport[]>([]);

  useFocusEffect(
    useCallback(() => {
      loadSessionReports(thresholds)
        .then(setItems)
        .catch(() => setItems([]));
    }, [thresholds]),
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Informes
        </ThemedText>
        <FlatList
          data={items}
          keyExtractor={(i) => String(i.session.id)}
          contentContainerStyle={{ paddingBottom: BottomTabInset }}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary">
              Aún no hay sesiones. El informe aparece al terminar de
              monitorizar.
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
  cardHeader: { gap: Spacing.half },
  cardTitle: { fontSize: 16 },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
