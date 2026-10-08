import { useCallback, useState } from 'react';
import { FlatList, StyleSheet } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { formatReportSummary } from '@/domain/morningReport';
import { getRecentEvents } from '@/data/readingsRepository';
import { events } from '@/data/schema';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { loadSessionReports } from '@/features/reports/sessionReports';
import { useTheme } from '@/hooks/use-theme';
import type { AlertEvent } from '@/domain/models';

type EventRow = typeof events.$inferSelect;

function describe(row: EventRow): string {
  try {
    const e = JSON.parse(row.payload) as AlertEvent;
    if (e.type === 'bradycardia') {
      return `Bradicardia · ${e.bpm ?? '?'} bpm durante ${Math.round((e.durationMs ?? 0) / 1000)}s`;
    }
    return `Pausa · intervalo de ${e.rrIntervalMs ?? '?'} ms`;
  } catch {
    return row.type;
  }
}

export default function HistoryScreen() {
  const theme = useTheme();
  const thresholds = useMonitorStore((s) => s.thresholds);
  const [rows, setRows] = useState<EventRow[]>([]);
  const [latestSummary, setLatestSummary] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      getRecentEvents(100)
        .then(setRows)
        .catch(() => setRows([]));
      loadSessionReports(thresholds, 1)
        .then(([latest]) =>
          setLatestSummary(latest ? formatReportSummary(latest.report) : null),
        )
        .catch(() => setLatestSummary(null));
    }, [thresholds]),
  );

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Eventos
        </ThemedText>
        {latestSummary && (
          <ThemedView type="backgroundElement" style={styles.summaryCard}>
            <ThemedText type="smallBold">Última sesión</ThemedText>
            <ThemedText type="small" themeColor="textSecondary">
              {latestSummary}
            </ThemedText>
          </ThemedView>
        )}
        <FlatList
          data={rows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ paddingBottom: BottomTabInset }}
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary">
              Aún no hay eventos registrados.
            </ThemedText>
          }
          renderItem={({ item }) => (
            <ThemedView
              type="backgroundElement"
              style={styles.row}>
              <ThemedText type="smallBold">{describe(item)}</ThemedText>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={{ color: theme.textSecondary }}>
                {new Date(item.timestamp).toLocaleString()}
              </ThemedText>
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
  title: { paddingVertical: Spacing.three },
  summaryCard: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.half,
  },
  row: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.half,
  },
});
