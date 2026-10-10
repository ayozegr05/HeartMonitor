import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, FlatList, Modal, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { EcgStrip } from '@/components/ecg-strip';
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
import { shareStripCsv, shareStripPdf } from '@/features/ecg/exportStrip';
import {
  listEcgSessions,
  removeEcgSession,
  shareEcgSessionCsv,
  type EcgSessionInfo,
} from '@/features/ecg/ecgSessionRecorder';
import { loadStrips, removeStrip, type CapturedStrip } from '@/features/ecg/stripStore';
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

/** One compact strip row — shared by session blocks and the orphan card. */
function StripRow({
  s,
  onOpen,
  onDelete,
}: {
  s: CapturedStrip;
  onOpen: (s: CapturedStrip) => void;
  onDelete: (s: CapturedStrip) => void;
}) {
  const theme = useTheme();
  const when = new Date(s.timestamp).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
  return (
    <Pressable
      onPress={() => onOpen(s)}
      onLongPress={() => onDelete(s)}
      style={({ pressed }) => [
        styles.stripRow,
        { backgroundColor: theme.background, opacity: pressed ? 0.7 : 1 },
      ]}>
      <View style={{ flex: 1 }}>
        <ThemedText type="smallBold">
          {when} · {s.report.meanBpm} bpm
          {s.auto ? ' · auto' : ''}
        </ThemedText>
        {s.label !== undefined && (
          <ThemedText type="small" themeColor="textSecondary">
            {s.label}
          </ThemedText>
        )}
      </View>
      <ThemedText
        type="small"
        themeColor="textSecondary"
        style={{ color: s.report.flags.length > 0 ? '#FFB020' : '#2E7D32' }}>
        {s.report.flags.length > 0
          ? `⚠️ ${s.report.flags.length} aviso${s.report.flags.length === 1 ? '' : 's'}`
          : '✓ sin avisos'}
      </ThemedText>
    </Pressable>
  );
}

/** One ECG recording row — shared by session blocks and the orphan card. */
function EcgSessionRow({
  s,
  onExport,
  onDelete,
}: {
  s: EcgSessionInfo;
  onExport: (s: EcgSessionInfo) => void;
  onDelete: (s: EcgSessionInfo) => void;
}) {
  const theme = useTheme();
  const when = new Date(s.startedAt).toLocaleString(undefined, {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
  const mins = Math.round(s.samples / s.sampleRateHz / 60);
  return (
    <Pressable
      onPress={() => onExport(s)}
      onLongPress={() => onDelete(s)}
      style={({ pressed }) => [
        styles.stripRow,
        { backgroundColor: theme.background, opacity: pressed ? 0.7 : 1 },
      ]}>
      <ThemedText type="smallBold" style={{ flex: 1 }}>
        {when}
      </ThemedText>
      <ThemedText type="small" themeColor="textSecondary">
        {mins} min · {s.samples.toLocaleString('es-ES')} muestras
      </ThemedText>
    </Pressable>
  );
}

function ReportCard({
  item,
  thresholds,
  strips,
  ecgSessions,
  onOpenStrip,
  onDeleteStrip,
  onExportSession,
  onDeleteSession,
}: {
  item: SessionWithReport;
  thresholds: ThresholdProfile;
  strips: CapturedStrip[];
  ecgSessions: EcgSessionInfo[];
  onOpenStrip: (s: CapturedStrip) => void;
  onDeleteStrip: (s: CapturedStrip) => void;
  onExportSession: (s: EcgSessionInfo) => void;
  onDeleteSession: (s: EcgSessionInfo) => void;
}) {
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
              {report.rmssdMs !== null && ` · VFC ${report.rmssdMs} ms`}
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
      {(strips.length > 0 || ecgSessions.length > 0) && (
        <ThemedText type="small" themeColor="textSecondary">
          {strips.length > 0 &&
            `📼 ${strips.length} tira${strips.length === 1 ? '' : 's'} ECG`}
          {strips.length > 0 && ecgSessions.length > 0 && ' · '}
          {ecgSessions.length > 0 && '💾 grabación completa (CSV)'}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        {expanded ? '▲ Ocultar' : '▼ Ver detalle'}
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
          {strips.length > 0 && (
            <View style={styles.eventList}>
              <ThemedText type="smallBold" themeColor="textSecondary">
                Tiras ECG de esta sesión
              </ThemedText>
              {strips.map((s) => (
                <StripRow
                  key={s.timestamp}
                  s={s}
                  onOpen={onOpenStrip}
                  onDelete={onDeleteStrip}
                />
              ))}
            </View>
          )}
          {ecgSessions.map((s) => (
            <EcgSessionRow
              key={s.startedAt}
              s={s}
              onExport={onExportSession}
              onDelete={onDeleteSession}
            />
          ))}
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
          {weekly.avgRmssdMs !== null && ` · VFC media ${weekly.avgRmssdMs} ms`}
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

function StripsCard({
  strips,
  onOpen,
  onDelete,
}: {
  strips: CapturedStrip[];
  onOpen: (s: CapturedStrip) => void;
  onDelete: (s: CapturedStrip) => void;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          Tiras ECG sueltas
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {strips.length} tira{strips.length === 1 ? '' : 's'} de 30 s sin sesión asociada · toca para ver
        </ThemedText>
      </ThemedView>
      {strips.map((s) => (
        <StripRow key={s.timestamp} s={s} onOpen={onOpen} onDelete={onDelete} />
      ))}
      <ThemedText type="small" themeColor="textSecondary">
        Mantén pulsada una tira para borrarla.
      </ThemedText>
    </ThemedView>
  );
}

function SessionsCard({
  sessions,
  onExport,
  onDelete,
}: {
  sessions: EcgSessionInfo[];
  onExport: (s: EcgSessionInfo) => void;
  onDelete: (s: EcgSessionInfo) => void;
}) {
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          Grabaciones ECG sueltas
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          stream completo · toca para exportar CSV entero
        </ThemedText>
      </ThemedView>
      {sessions.map((s) => (
        <EcgSessionRow
          key={s.startedAt}
          s={s}
          onExport={onExport}
          onDelete={onDelete}
        />
      ))}
      <ThemedText type="small" themeColor="textSecondary">
        Mantén pulsada una sesión para borrarla.
      </ThemedText>
    </ThemedView>
  );
}

export default function ReportsScreen() {
  const theme = useTheme();
  const thresholds = useMonitorStore((s) => s.thresholds);
  const [items, setItems] = useState<SessionWithReport[]>([]);
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [onlyWithEvents, setOnlyWithEvents] = useState(false);
  const [strips, setStrips] = useState<CapturedStrip[]>([]);
  const [sessions, setSessions] = useState<EcgSessionInfo[]>([]);
  const [activeStrip, setActiveStrip] = useState<CapturedStrip | null>(null);
  /** 'Now' at the last data load — window ends for live sessions. */
  const [nowMs, setNowMs] = useState(0);
  const hasAnyEvents = items.some((i) => i.report.eventCount > 0);

  // File each strip and ECG recording under the monitor session whose
  // window contains it (sessions never overlap, so no double-claim).
  const inWindow = (ts: number, item: SessionWithReport): boolean =>
    ts >= item.session.startedAt &&
    ts <= (item.session.endedAt ?? nowMs);
  const stripsOf = (item: SessionWithReport): CapturedStrip[] =>
    strips.filter((s) => inWindow(s.timestamp, item));
  const recOverlaps = (s: EcgSessionInfo, item: SessionWithReport): boolean =>
    s.startedAt <= (item.session.endedAt ?? nowMs) &&
    s.startedAt + (s.samples / s.sampleRateHz) * 1000 >=
      item.session.startedAt;
  const ecgSessionsOf = (item: SessionWithReport): EcgSessionInfo[] =>
    sessions.filter((s) => recOverlaps(s, item));
  const orphanStrips = strips.filter(
    (s) => !items.some((i) => inWindow(s.timestamp, i)),
  );
  const orphanSessions = sessions.filter(
    (s) => !items.some((i) => recOverlaps(s, i)),
  );

  useFocusEffect(
    useCallback(() => {
      setNowMs(Date.now());
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
      loadStrips()
        .then((loaded) => setStrips([...loaded]))
        .catch(() => setStrips([]));
      listEcgSessions()
        .then(setSessions)
        .catch(() => setSessions([]));
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
            <>
              {weekly && weekly.sessionsCount > 0 && !onlyWithEvents && (
                <WeeklyCard weekly={weekly} />
              )}
            </>
          }
          ListFooterComponent={
            !onlyWithEvents ? (
              <>
                {orphanSessions.length > 0 && (
                  <SessionsCard
                    sessions={orphanSessions}
                    onExport={(s) => {
                      shareEcgSessionCsv(s).catch((e) =>
                        Alert.alert(
                          'No se pudo exportar',
                          e instanceof Error ? e.message : 'Error desconocido',
                        ),
                      );
                    }}
                    onDelete={(s) => {
                      removeEcgSession(s.startedAt);
                      setSessions((prev) =>
                        prev.filter((x) => x.startedAt !== s.startedAt),
                      );
                    }}
                  />
                )}
                {orphanStrips.length > 0 && (
                  <StripsCard
                    strips={orphanStrips}
                    onOpen={setActiveStrip}
                    onDelete={(s) => {
                      removeStrip(s.timestamp);
                      setStrips((prev) =>
                        prev.filter((x) => x.timestamp !== s.timestamp),
                      );
                    }}
                  />
                )}
              </>
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
            <ReportCard
              item={item}
              thresholds={thresholds}
              strips={stripsOf(item)}
              ecgSessions={ecgSessionsOf(item)}
              onOpenStrip={setActiveStrip}
              onDeleteStrip={(s) => {
                removeStrip(s.timestamp);
                setStrips((prev) =>
                  prev.filter((x) => x.timestamp !== s.timestamp),
                );
              }}
              onExportSession={(s) => {
                shareEcgSessionCsv(s).catch((e) =>
                  Alert.alert(
                    'No se pudo exportar',
                    e instanceof Error ? e.message : 'Error desconocido',
                  ),
                );
              }}
              onDeleteSession={(s) => {
                removeEcgSession(s.startedAt);
                setSessions((prev) =>
                  prev.filter((x) => x.startedAt !== s.startedAt),
                );
              }}
            />
          )}
        />
        <Modal
          visible={activeStrip !== null}
          animationType="slide"
          onRequestClose={() => setActiveStrip(null)}>
          <ThemedView style={styles.stripModal}>
            <SafeAreaView style={styles.stripModalInner}>
              <ThemedText type="smallBold">Tira ECG · 30 s</ThemedText>
              {activeStrip && (
                <>
                  <EcgStrip samples={activeStrip.samples} height={240} />
                  <ThemedText type="small" themeColor="textSecondary">
                    {new Date(activeStrip.timestamp).toLocaleString(undefined, {
                      day: 'numeric',
                      month: 'short',
                      hour: '2-digit',
                      minute: '2-digit',
                    })}
                    {' · '}
                    {activeStrip.label !== undefined &&
                      `${activeStrip.label} · `}
                    {activeStrip.report.meanBpm} bpm · QRS{' '}
                    {Math.round(activeStrip.report.meanQrsWidthMs)} ms
                    {activeStrip.report.meanPrMs !== undefined &&
                      ` · PR ${activeStrip.report.meanPrMs} ms`}
                    {activeStrip.report.droppedBeats > 0 &&
                      ` · ${activeStrip.report.droppedBeats} bloqueados`}
                  </ThemedText>
                  {activeStrip.report.flags.map((f) => (
                    <ThemedText
                      key={f}
                      type="small"
                      style={{ color: '#FFB020' }}>
                      ⚠️ {f}
                    </ThemedText>
                  ))}
                </>
              )}
              {activeStrip && (
                <View style={styles.stripButtons}>
                  <Pressable
                    onPress={() =>
                      shareStripPdf(activeStrip).catch((e) =>
                        Alert.alert(
                          'No se pudo exportar',
                          e instanceof Error ? e.message : 'Error desconocido',
                        ),
                      )
                    }
                    style={[
                      styles.exportButton,
                      styles.stripButton,
                      { backgroundColor: theme.backgroundSelected },
                    ]}>
                    <ThemedText type="smallBold">PDF</ThemedText>
                  </Pressable>
                  <Pressable
                    onPress={() =>
                      shareStripCsv(activeStrip).catch((e) =>
                        Alert.alert(
                          'No se pudo exportar',
                          e instanceof Error ? e.message : 'Error desconocido',
                        ),
                      )
                    }
                    style={[
                      styles.exportButton,
                      styles.stripButton,
                      { backgroundColor: theme.backgroundSelected },
                    ]}>
                    <ThemedText type="smallBold">CSV</ThemedText>
                  </Pressable>
                </View>
              )}
              <Pressable
                onPress={() => setActiveStrip(null)}
                style={[
                  styles.exportButton,
                  { backgroundColor: theme.backgroundElement },
                ]}>
                <ThemedText type="smallBold">Cerrar</ThemedText>
              </Pressable>
            </SafeAreaView>
          </ThemedView>
        </Modal>
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
  stripRow: {
    borderRadius: Spacing.two,
    padding: Spacing.two,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  stripModal: { flex: 1 },
  stripModalInner: {
    flex: 1,
    paddingHorizontal: Spacing.four,
    gap: Spacing.two,
  },
  stripButtons: { flexDirection: 'row', gap: Spacing.two },
  stripButton: { flex: 1 },
  metricRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
});
