import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HrChart } from '@/components/hr-chart';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { getSessionReadingBuckets } from '@/data/readingsRepository';
import {
    eventBucketIndices,
    type ChartBucket,
} from '@/domain/hrChart';
import type { AlertEvent, ThresholdProfile } from '@/domain/models';
import { formatDuration } from '@/domain/morningReport';
import { activeLowThreshold } from '@/domain/thresholds';
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

function eventLine(e: AlertEvent): string {
  const time = new Date(e.timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  if (e.type === 'pause') {
    return `${time} · Pausa · RR ${e.rrIntervalMs ?? '?'} ms`;
  }
  const detail = [
    e.bpm !== undefined ? `${e.bpm} bpm` : null,
    e.durationMs !== undefined ? `sostenido ${formatDuration(e.durationMs)}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  return `${time} · Bradicardia${detail ? ` · ${detail}` : ''}`;
}

const CHART_BUCKETS = 120;

/** Loads the session's aggregated series lazily when the card expands. */
async function loadChart(
  sessionId: number,
  windowStart: number,
  windowEnd: number,
  thresholds: ThresholdProfile,
): Promise<ChartBucket[]> {
  const bucketMs = Math.max(1, (windowEnd - windowStart) / CHART_BUCKETS);
  const rows = await getSessionReadingBuckets(sessionId, windowStart, bucketMs);
  const byIndex = new Map(rows.map((r) => [r.bucket, r]));
  return Array.from({ length: CHART_BUCKETS }, (_, i) => {
    const startTs = windowStart + i * bucketMs;
    const row = byIndex.get(i);
    const hasData = row !== undefined;
    return {
      startTs,
      minBpm: row?.minBpm ?? 0,
      avgBpm: row?.avgBpm ?? 0,
      maxBpm: row?.maxBpm ?? 0,
      hasData,
      belowThreshold:
        hasData &&
        row.avgBpm < activeLowThreshold(thresholds, new Date(startTs)),
    };
  });
}

function StatBlock({
  label,
  value,
  color,
}: {
  label: string;
  value: string;
  color?: string;
}) {
  return (
    <View style={styles.statBlock}>
      <ThemedText type="small" themeColor="textSecondary">
        {label}
      </ThemedText>
      <ThemedText style={[styles.statValue, color ? { color } : undefined]}>
        {value}
      </ThemedText>
    </View>
  );
}

function ReportCard({ item, thresholds }: { item: SessionWithReport; thresholds: ThresholdProfile }) {
  const theme = useTheme();
  const { session, report, events } = item;
  const live = session.endedAt === null;
  const hasEvents = report.eventCount > 0;
  const [expanded, setExpanded] = useState(false);
  const [chart, setChart] = useState<ChartBucket[] | null>(null);

  const coveragePct =
    report.durationMs > 0
      ? Math.min(
          100,
          Math.round((report.readingsCount / (report.durationMs / 1000)) * 100),
        )
      : 0;

  const toggleExpand = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && chart === null && report.readingsCount > 0) {
      const end = session.endedAt ?? report.windowEnd;
      loadChart(session.id, session.startedAt, end, thresholds)
        .then(setChart)
        .catch(() => setChart([]));
    }
  };

  return (
    <Pressable
      onPress={toggleExpand}
      style={({ pressed }) => [
        styles.card,
        hasEvents && styles.cardWithEvents,
        { backgroundColor: theme.backgroundElement },
        pressed && { opacity: 0.8 },
      ]}>
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
        <>
          <View style={styles.statsRow}>
            <StatBlock
              label="MÍN"
              value={report.minBpm !== null ? String(report.minBpm) : '—'}
              color="#E5484D"
            />
            <StatBlock
              label="MEDIA"
              value={report.avgBpm !== null ? String(report.avgBpm) : '—'}
            />
            <StatBlock
              label="MÁX"
              value={report.maxBpm !== null ? String(report.maxBpm) : '—'}
            />
            <StatBlock
              label="DURACIÓN"
              value={formatDuration(report.durationMs)}
            />
          </View>
          <View style={styles.subRow}>
            <ThemedText type="small" themeColor="textSecondary">
              {report.timeBelowThresholdMs > 0
                ? `${formatDuration(report.timeBelowThresholdMs)} bajo umbral`
                : 'sin tiempo bajo umbral'}
              {' · '}
              {coveragePct}% cobertura
            </ThemedText>
            <ThemedText
              type="small"
              themeColor="textSecondary"
              style={{ color: hasEvents ? '#E5484D' : '#2E7D32' }}>
              {hasEvents
                ? `⚠️ ${report.eventCount} evento${report.eventCount === 1 ? '' : 's'}`
                : '✓ sin eventos'}
            </ThemedText>
          </View>
        </>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        {expanded ? '▲ Ocultar' : '▼ Ver gráfica'}
      </ThemedText>
      {expanded && (
        <>
          {chart === null ? (
            <ThemedText type="small" themeColor="textSecondary">
              Cargando gráfica…
            </ThemedText>
          ) : chart.length === 0 ? (
            <ThemedText type="small" themeColor="textSecondary">
              Sin datos para graficar.
            </ThemedText>
          ) : (
            <HrChart
              buckets={chart}
              eventMarks={eventBucketIndices(
                events,
                session.startedAt,
                session.endedAt ?? report.windowEnd,
                CHART_BUCKETS,
              )}
              thresholdBpm={activeLowThreshold(
                thresholds,
                new Date(session.startedAt),
              )}
              height={96}
            />
          )}
          {events.length > 0 && (
            <View style={styles.eventList}>
              {events.map((e, i) => (
                <ThemedText key={i} type="small">
                  {e.type === 'pause' ? '⏸' : '⚠️'} {eventLine(e)}
                </ThemedText>
              ))}
            </View>
          )}
        </>
      )}
    </Pressable>
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
      <View style={styles.statsRow}>
        <StatBlock
          label="MÍN"
          value={weekly.minBpm !== null ? String(weekly.minBpm) : '—'}
          color="#E5484D"
        />
        <StatBlock
          label="MEDIA"
          value={weekly.avgBpm !== null ? String(weekly.avgBpm) : '—'}
        />
        <StatBlock
          label="MÁX"
          value={weekly.maxBpm !== null ? String(weekly.maxBpm) : '—'}
        />
        <StatBlock
          label="TOTAL"
          value={formatDuration(weekly.totalMonitoredMs)}
        />
      </View>
      <View style={styles.subRow}>
        <ThemedText type="small" themeColor="textSecondary">
          {weekly.timeBelowThresholdMs > 0
            ? `${formatDuration(weekly.timeBelowThresholdMs)} bajo umbral`
            : 'sin tiempo bajo umbral'}
        </ThemedText>
        <ThemedText
          type="small"
          themeColor="textSecondary"
          style={{ color: weekly.eventCount > 0 ? '#E5484D' : '#2E7D32' }}>
          {weekly.eventCount === 0
            ? '✓ sin eventos'
            : `⚠️ ${weekly.eventCount} (${weekly.bradycardiaCount} bradicardia · ${weekly.pauseCount} pausa)`}
        </ThemedText>
      </View>
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
  const hasAnyEvents = items.some((i) => i.report.eventCount > 0);

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
        {/* Keep the toggle reachable while the filter is active, even if
            the loaded sessions happen to contain no events right now. */}
        {(hasAnyEvents || onlyWithEvents) && (
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
          renderItem={({ item }) => (
            <ReportCard item={item} thresholds={thresholds} />
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
  statsRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    paddingVertical: Spacing.one,
  },
  statBlock: { flex: 1, alignItems: 'center', gap: 2 },
  statValue: { fontSize: 24, fontWeight: 700 },
  subRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    flexWrap: 'wrap',
    gap: Spacing.one,
  },
  eventList: { gap: 4, paddingTop: Spacing.one },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
