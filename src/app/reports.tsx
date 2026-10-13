import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, FlatList, Pressable, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { HrChart } from '@/components/hr-chart';
import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import {
    deleteSessionCascade,
    getSessionReadingBuckets,
} from '@/data/readingsRepository';
import {
    eventBucketIndices,
    type ChartBucket,
} from '@/domain/hrChart';
import type { AlertEvent, ThresholdProfile } from '@/domain/models';
import { formatDuration } from '@/domain/morningReport';
import { vagalNote, type SleepMetrics } from '@/domain/sleepAnalysis';
import { activeLowThreshold } from '@/domain/thresholds';
import {
    buildWeeklyReport,
    type WeeklyReport,
} from '@/domain/weeklyReport';
import {
    listEcgSessions,
    removeEcgSession,
    shareEcgSessionCsv,
    type EcgSessionInfo,
} from '@/features/ecg/ecgSessionRecorder';
import { loadStrips, removeStrip, type CapturedStrip } from '@/features/ecg/stripStore';
import {
    readGarminSeries,
    requestGarminReadAccess,
    type GarminDayPoint,
    type GarminSeries,
} from '@/features/healthconnect/garminSummary';
import { useMonitorStore } from '@/features/monitoring/useMonitorStore';
import { shareWeeklyPdf } from '@/features/reports/exportWeeklyPdf';
import {
    loadRmssdSeries,
    loadSessionReports,
    type RmssdPoint,
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
  onDeleteReport,
}: {
  item: SessionWithReport;
  thresholds: ThresholdProfile;
  strips: CapturedStrip[];
  ecgSessions: EcgSessionInfo[];
  onOpenStrip: (s: CapturedStrip) => void;
  onDeleteStrip: (s: CapturedStrip) => void;
  onExportSession: (s: EcgSessionInfo) => void;
  onDeleteSession: (s: EcgSessionInfo) => void;
  onDeleteReport?: (item: SessionWithReport) => void;
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
      onLongPress={
        onDeleteReport ? () => onDeleteReport(item) : undefined
      }
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

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "⌚ Tu reloj dice" — latest night + today's extras from Health Connect. */
function GarminCard({
  series,
  onConnect,
}: {
  series: GarminSeries | null;
  onConnect: () => void;
}) {
  const theme = useTheme();
  const latest = series?.points.at(-1);
  const hasData = (series?.points.length ?? 0) > 0;
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          ⌚ Tu reloj dice
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {series?.source === 'cuenta Garmin'
            ? 'vía cuenta Garmin Connect'
            : `vía Health Connect${series?.source ? ` · ${series.source}` : ''}`}
        </ThemedText>
      </ThemedView>
      {hasData && latest ? (
        <>
          {latest.sleep && (
            <ThemedText type="small">
              Último sueño: {formatClock(latest.sleep.startedAt)} →{' '}
              {formatClock(latest.sleep.endedAt)} (
              {formatDuration(
                latest.sleep.endedAt - latest.sleep.startedAt,
              )}
              )
            </ThemedText>
          )}
          {latest.sleep &&
            (latest.sleep.stagesMs.deep +
              latest.sleep.stagesMs.light +
              latest.sleep.stagesMs.rem >
              0) && (
              <ThemedText type="small" themeColor="textSecondary">
                💤 profundo {formatDuration(latest.sleep.stagesMs.deep)} · REM{' '}
                {formatDuration(latest.sleep.stagesMs.rem)} · ligero{' '}
                {formatDuration(latest.sleep.stagesMs.light)}
                {latest.sleep.stagesMs.awake > 0 &&
                  ` · despierto ${formatDuration(latest.sleep.stagesMs.awake)}`}
              </ThemedText>
            )}
          <ThemedText type="small" themeColor="textSecondary">
            {[
              latest.hrvRmssdMs !== undefined &&
                `VFC reloj ${latest.hrvRmssdMs} ms`,
              latest.restingBpm !== undefined &&
                `FC reposo ${latest.restingBpm} bpm`,
              latest.respirationPerMin !== undefined &&
                `resp ${latest.respirationPerMin.toFixed(1)}/min`,
              latest.spo2AvgPct !== undefined &&
                `SpO2 ${Math.round(latest.spo2AvgPct)}%` +
                  (latest.spo2MinPct !== undefined
                    ? ` (mín ${Math.round(latest.spo2MinPct)}%)`
                    : ''),
            ]
              .filter(Boolean)
              .join(' · ')}
          </ThemedText>
          <ThemedText type="small" themeColor="textSecondary">
            {[
              latest.steps !== undefined &&
                `pasos ${latest.steps.toLocaleString('es-ES')}`,
              latest.hrMinBpm !== undefined &&
                `FC día ${latest.hrMinBpm}–${latest.hrMaxBpm} bpm`,
            ]
              .filter(Boolean)
              .join(' · ')}
          </ThemedText>
        </>
      ) : (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            El resumen del reloj (sueño, fases, VFC, SpO2) llega si activas en
            Garmin Connect → Ajustes → Health Connect la escritura de datos —
            aunque Garmin nunca publica VFC ni SpO2 ahí. Para esos datos,
            vincula tu cuenta Garmin en Ajustes → Cuenta Garmin.
          </ThemedText>
          <Pressable
            onPress={onConnect}
            style={[styles.exportButton, { backgroundColor: theme.backgroundSelected }]}>
            <ThemedText type="smallBold">Leer datos del reloj</ThemedText>
          </Pressable>
        </>
      )}
    </ThemedView>
  );
}

type TrendRange = '4s' | '3m' | '6m' | '1a';
const TREND_RANGES: { key: TrendRange; label: string; days: number }[] = [
  { key: '4s', label: '4S', days: 28 },
  { key: '3m', label: '3M', days: 91 },
  { key: '6m', label: '6M', days: 183 },
  { key: '1a', label: '1A', days: 366 },
];

function rmssdColor(v: number): string {
  return v >= 40 ? '#2E7D32' : v >= 25 ? '#FFB020' : '#E5484D';
}

/**
 * Buckets per-night points into weekly or monthly averages so long
 * ranges stay readable (one bar per bucket, height = bucket mean).
 */
function bucketPoints(
  points: RmssdPoint[],
  mode: 'week' | 'month',
): { key: string; value: number }[] {
  const groups = new Map<string, number[]>();
  for (const p of points) {
    const d = new Date(p.startedAt);
    const key =
      mode === 'month'
        ? `${d.getFullYear()}-${d.getMonth()}`
        : String(
            new Date(
              d.getFullYear(),
              d.getMonth(),
              d.getDate() - ((d.getDay() + 6) % 7),
            ).getTime(),
          );
    const list = groups.get(key) ?? [];
    list.push(p.rmssdMs);
    groups.set(key, list);
  }
  return [...groups.entries()]
    .map(([key, vals]) => ({
      key,
      value: Math.round(vals.reduce((a, b) => a + b, 0) / vals.length),
    }))
    .reverse();
}

/**
 * RMSSD trend card. 4 weeks = one bar per night; longer ranges show
 * weekly (3M/6M) or monthly (1A) averages of the same data.
 */
const dayKeyOf = (ms: number): string => {
  const d = new Date(ms);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * VFC comparativa: nuestra banda (verde) vs el reloj (azul), barra por día.
 * Solo aparece cuando el reloj ha publicado VFC en Health Connect.
 */
function WatchVsBandTrend({
  items,
  watch,
}: {
  items: SessionWithReport[];
  watch: GarminSeries | null;
}) {
  const watchByDay = new Map(
    (watch?.points ?? [])
      .filter((p) => p.hrvRmssdMs !== undefined)
      .map((p) => [p.day, p.hrvRmssdMs as number]),
  );
  if (watchByDay.size === 0) return null;

  const oursByDay = new Map<string, number>();
  for (const i of items) {
    const v = i.session.rmssdMs;
    if (v != null) {
      // File our night under the wake day, same as the watch.
      oursByDay.set(dayKeyOf(i.session.endedAt ?? i.session.startedAt), v);
    }
  }
  const days = [...new Set([...watchByDay.keys(), ...oursByDay.keys()])]
    .sort()
    .slice(-14);
  const max = Math.max(
    1,
    ...days.map((d) =>
      Math.max(watchByDay.get(d) ?? 0, oursByDay.get(d) ?? 0),
    ),
  );

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          VFC: banda vs reloj
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          ms por noche
        </ThemedText>
      </ThemedView>
      <View style={styles.trendRow}>
        {days.map((d) => {
          const ours = oursByDay.get(d);
          const theirs = watchByDay.get(d);
          return (
            <View key={d} style={styles.trendPair}>
              <View style={styles.trendPairBars}>
                <View
                  style={[
                    styles.trendBar,
                    {
                      height: `${ours ? Math.max(6, (ours / max) * 100) : 0}%`,
                      backgroundColor: '#2E7D32',
                    },
                  ]}
                />
                <View
                  style={[
                    styles.trendBar,
                    {
                      height: `${theirs ? Math.max(6, (theirs / max) * 100) : 0}%`,
                      backgroundColor: '#3B82F6',
                    },
                  ]}
                />
              </View>
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={styles.trendPairLabel}>
                {d.slice(8)}
              </ThemedText>
            </View>
          );
        })}
      </View>
      <ThemedText type="small" themeColor="textSecondary">
        <ThemedText type="small" style={{ color: '#2E7D32' }}>■</ThemedText> banda
        H10 ·{' '}
        <ThemedText type="small" style={{ color: '#3B82F6' }}>■</ThemedText>{' '}
        reloj (óptico)
      </ThemedText>
      {watch?.source && (
        <ThemedText type="small" themeColor="textSecondary">
          Fuente: {watch.source} — valores ópticos aproximados, la tendencia es
          lo que importa.
        </ThemedText>
      )}
    </ThemedView>
  );
}

/** Night card when only the watch has data (no band session that night). */
function WatchNightCard({ point }: { point: GarminDayPoint }) {
  const ws = point.sleep;
  const night = new Date(`${point.day}T12:00:00`).toLocaleDateString(
    undefined,
    { weekday: 'short', day: 'numeric', month: 'short' },
  );
  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          {night}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          solo reloj
        </ThemedText>
      </ThemedView>
      {ws && (
        <ThemedText type="small">
          {formatClock(ws.startedAt)} → {formatClock(ws.endedAt)} (
          {formatDuration(ws.endedAt - ws.startedAt)})
          {ws.stagesMs.deep + ws.stagesMs.light + ws.stagesMs.rem > 0 &&
            ` · prof ${formatDuration(ws.stagesMs.deep)} REM ${formatDuration(ws.stagesMs.rem)} lig ${formatDuration(ws.stagesMs.light)}`}
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        {[
          point.hrvRmssdMs !== undefined && `VFC ${point.hrvRmssdMs} ms`,
          point.restingBpm !== undefined && `reposo ${point.restingBpm} bpm`,
          point.respirationPerMin !== undefined &&
            `resp ${point.respirationPerMin.toFixed(1)}/min`,
          point.spo2AvgPct !== undefined &&
            `SpO2 ${Math.round(point.spo2AvgPct)}%` +
              (point.spo2MinPct !== undefined
                ? ` (mín ${Math.round(point.spo2MinPct)}%)`
                : ''),
        ]
          .filter(Boolean)
          .join(' · ')}
      </ThemedText>
    </ThemedView>
  );
}

function RmssdTrend() {
  const theme = useTheme();
  const [range, setRange] = useState<TrendRange>('4s');
  const [data, setData] = useState<{ range: TrendRange; points: RmssdPoint[] }>({
    range: '4s',
    points: [],
  });
  const [loaded, setLoaded] = useState<TrendRange | null>(null);

  useEffect(() => {
    let alive = true;
    const days = TREND_RANGES.find((r) => r.key === range)!.days;
    const since = Date.now() - days * 86_400_000;
    loadRmssdSeries(since, (p) => {
      if (alive) setData({ range, points: p });
    })
      .then((p) => {
        if (alive) setData({ range, points: p });
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setLoaded(range);
      });
    return () => {
      alive = false;
    };
  }, [range]);

  const loading = loaded !== range;
  const points = data.range === range ? data.points : [];
  const aggregated = range !== '4s';
  const bars = aggregated
    ? bucketPoints(points, range === '1a' ? 'month' : 'week')
    : [...points]
        .reverse()
        .map((p) => ({ key: String(p.sessionId), value: p.rmssdMs }));
  const max = Math.max(...bars.map((b) => b.value), 1);

  return (
    <ThemedView type="backgroundElement" style={styles.card}>
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          VFC nocturna
        </ThemedText>
        <View style={styles.trendChips}>
          {TREND_RANGES.map((r) => (
            <Pressable
              key={r.key}
              onPress={() => setRange(r.key)}
              style={[
                styles.trendChip,
                range === r.key && {
                  backgroundColor: theme.backgroundSelected,
                },
              ]}>
              <ThemedText
                type="small"
                themeColor={range === r.key ? 'text' : 'textSecondary'}>
                {r.label}
              </ThemedText>
            </Pressable>
          ))}
        </View>
      </ThemedView>
      {bars.length === 0 ? (
        <ThemedText type="small" themeColor="textSecondary">
          {loading ? 'Calculando…' : 'Sin datos de VFC en este rango.'}
        </ThemedText>
      ) : (
        <>
          <View style={styles.trendRow}>
            {bars.map((b) => (
              <View
                key={b.key}
                style={[
                  styles.trendBar,
                  {
                    height: Math.max(4, (b.value / max) * 48),
                    backgroundColor: rmssdColor(b.value),
                  },
                ]}
              />
            ))}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {aggregated
              ? range === '1a'
                ? 'media mensual · '
                : 'media semanal · '
              : 'por noche · '}
            verde ≥40 ms · naranja ≥25 · rojo &lt;25
          </ThemedText>
        </>
      )}
    </ThemedView>
  );
}

function sleepLine(sleep: SleepMetrics): string {
  const parts: string[] = [];
  if (sleep.estimatedOnsetMs !== null && sleep.estimatedWakeMs !== null) {
    parts.push(
      `💤 dormirse ~${formatClock(sleep.estimatedOnsetMs)} → despertar ~${formatClock(sleep.estimatedWakeMs)}`,
    );
  }
  if (sleep.awakenings > 0) {
    parts.push(
      `${sleep.awakenings} despertar${sleep.awakenings === 1 ? '' : 'es'}`,
    );
  }
  return parts.join(' · ');
}

function SleepCard({
  item,
  watch,
  onDelete,
}: {
  item: SessionWithReport;
  /** Watch data for this same night (filed under its wake day). */
  watch?: GarminDayPoint;
  onDelete?: (item: SessionWithReport) => void;
}) {
  const { session, report, sleep } = item;
  const night = new Date(session.startedAt).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
  const hasSleep = sleep.estimatedOnsetMs !== null;
  const ws = watch?.sleep;
  return (
    <Pressable
      onLongPress={onDelete ? () => onDelete(item) : undefined}
      style={({ pressed }) => [
        styles.card,
        { opacity: pressed ? 0.7 : 1 },
      ]}>
    <ThemedView type="backgroundElement">
      <ThemedView style={styles.cardHeader}>
        <ThemedText type="smallBold" style={styles.cardTitle}>
          {night}
        </ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {session.sensorLabel}
        </ThemedText>
      </ThemedView>
      <ThemedText type="small" themeColor="textSecondary">
        Banda:
      </ThemedText>
      {hasSleep ? (
        <ThemedText type="small">  {sleepLine(sleep)}</ThemedText>
      ) : (
        <ThemedText type="small" themeColor="textSecondary">
          {'  '}Sin ventana de sueño clara en esta sesión.
        </ThemedText>
      )}
      <ThemedText type="small" themeColor="textSecondary">
        {'  '}
        {report.rmssdMs !== null
          ? `VFC ${report.rmssdMs} ms · ${vagalNote(sleep.vagalTone ?? 'medio', report.pauseCount)}`
          : 'Sin RR — VFC y vago no disponibles con este sensor'}
      </ThemedText>
      {watch && (
        <>
          <ThemedText type="small" themeColor="textSecondary">
            Reloj:
          </ThemedText>
          {ws && (
            <ThemedText type="small">
              {'  '}
              {formatClock(ws.startedAt)} → {formatClock(ws.endedAt)} (
              {formatDuration(ws.endedAt - ws.startedAt)})
              {(ws.stagesMs.deep + ws.stagesMs.light + ws.stagesMs.rem > 0) &&
                ` · prof ${formatDuration(ws.stagesMs.deep)} REM ${formatDuration(ws.stagesMs.rem)} lig ${formatDuration(ws.stagesMs.light)}`}
            </ThemedText>
          )}
          <ThemedText type="small" themeColor="textSecondary">
            {'  '}
            {[
              watch.hrvRmssdMs !== undefined && `VFC ${watch.hrvRmssdMs} ms`,
              watch.restingBpm !== undefined &&
                `reposo ${watch.restingBpm} bpm`,
              watch.respirationPerMin !== undefined &&
                `resp ${watch.respirationPerMin.toFixed(1)}/min`,
              watch.spo2AvgPct !== undefined &&
                `SpO2 ${Math.round(watch.spo2AvgPct)}%` +
                  (watch.spo2MinPct !== undefined
                    ? ` (mín ${Math.round(watch.spo2MinPct)}%)`
                    : ''),
            ]
              .filter(Boolean)
              .join(' · ')}
          </ThemedText>
        </>
      )}
    </ThemedView>
    </Pressable>
  );
}

type ReportsTab = 'resumen' | 'fc' | 'ecg' | 'sueno';
const REPORT_TABS: { key: ReportsTab; label: string }[] = [
  { key: 'resumen', label: 'Resumen' },
  { key: 'fc', label: 'FC' },
  { key: 'ecg', label: 'ECG' },
  { key: 'sueno', label: 'Sueño' },
];

/** Monday-starting week key for session grouping. */
function weekLabel(ts: number): string {
  const d = new Date(ts);
  const monday = new Date(d);
  monday.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `Semana del ${monday.toLocaleDateString(undefined, {
    day: 'numeric',
    month: 'short',
  })}`;
}

/** Local-day label for ECG strip grouping. */
function stripDayLabel(ts: number): string {
  return new Date(ts).toLocaleDateString(undefined, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });
}

type EcgFilter = 'all' | 'auto' | 'manual' | 'recordings';
const ECG_FILTERS: { key: EcgFilter; label: string }[] = [
  { key: 'all', label: 'Todo' },
  { key: 'auto', label: 'Auto 30 s' },
  { key: 'manual', label: 'Manuales' },
  { key: 'recordings', label: 'Grabaciones' },
];

/** Flattened row for the FC tab: week headers interleaved with cards. */
type FcRow =
  | { kind: 'week'; key: string; label: string; count: number }
  | { kind: 'session'; key: string; item: SessionWithReport };

type EcgRow =
  | { kind: 'day'; key: string; label: string }
  | { kind: 'strip'; key: string; strip: CapturedStrip }
  | { kind: 'recording'; key: string; session: EcgSessionInfo };

export default function ReportsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const thresholds = useMonitorStore((s) => s.thresholds);
  const lastMorningReport = useMonitorStore((s) => s.lastMorningReport);
  const [tab, setTab] = useState<ReportsTab>('resumen');
  const [items, setItems] = useState<SessionWithReport[]>([]);
  const [weekly, setWeekly] = useState<WeeklyReport | null>(null);
  const [onlyWithEvents, setOnlyWithEvents] = useState(false);
  const [strips, setStrips] = useState<CapturedStrip[]>([]);
  const [sessions, setSessions] = useState<EcgSessionInfo[]>([]);
  const [ecgFilter, setEcgFilter] = useState<EcgFilter>('all');
  const [collapsedWeeks, setCollapsedWeeks] = useState<Set<string>>(
    () => new Set(),
  );
  const [garmin, setGarmin] = useState<GarminSeries | null>(null);
  const garminByDay = new Map(
    (garmin?.points ?? []).map((p) => [p.day, p]),
  );
  /** Nights from band sessions merged with watch-only nights (wake-day key). */
  const suenoRows = ((): {
    key: string;
    sort: number;
    item?: SessionWithReport;
    point?: GarminDayPoint;
  }[] => {
    const rows: {
      key: string;
      sort: number;
      item?: SessionWithReport;
      point?: GarminDayPoint;
    }[] = [];
    const used = new Set<string>();
    for (const item of items) {
      const dk = dayKeyOf(item.session.endedAt ?? item.session.startedAt);
      used.add(dk);
      rows.push({
        key: `b${item.session.id}`,
        sort: item.session.endedAt ?? item.session.startedAt,
        item,
        point: garminByDay.get(dk),
      });
    }
    for (const p of garmin?.points ?? []) {
      if (!used.has(p.day) && (p.sleep || p.hrvRmssdMs !== undefined)) {
        rows.push({
          key: `w${p.day}`,
          sort: Date.parse(`${p.day}T12:00:00`),
          point: p,
        });
      }
    }
    return rows.sort((a, b) => b.sort - a.sort);
  })();
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
      readGarminSeries(30)
        .then(setGarmin)
        .catch(() => setGarmin(null));
    }, [thresholds]),
  );

  const connectGarmin = () => {
    requestGarminReadAccess()
      .then((granted) => (granted ? readGarminSeries(30) : null))
      .then(setGarmin)
      .catch(() => setGarmin(null));
  };

  const openStrip = (s: CapturedStrip) =>
    router.push({
      pathname: '/strip-detail',
      params: { ts: String(s.timestamp) },
    });

  const deleteStrip = (s: CapturedStrip) => {
    removeStrip(s.timestamp);
    setStrips((prev) => prev.filter((x) => x.timestamp !== s.timestamp));
  };
  const exportSession = (s: EcgSessionInfo) => {
    shareEcgSessionCsv(s).catch((e) =>
      Alert.alert(
        'No se pudo exportar',
        e instanceof Error ? e.message : 'Error desconocido',
      ),
    );
  };
  const deleteSessionRec = (s: EcgSessionInfo) => {
    removeEcgSession(s.startedAt);
    setSessions((prev) => prev.filter((x) => x.startedAt !== s.startedAt));
  };

  const confirmDeleteReport = (item: SessionWithReport) => {
    Alert.alert(
      'Borrar sesión',
      'Se eliminará esta sesión con todas sus lecturas y eventos. Esta acción no se puede deshacer.',
      [
        { text: 'Cancelar', style: 'cancel' },
        {
          text: 'Borrar',
          style: 'destructive',
          onPress: () => {
            void deleteSessionCascade(item.session.id)
              .then(() => {
                setItems((prev) => {
                  const next = prev.filter(
                    (x) => x.session.id !== item.session.id,
                  );
                  setWeekly(
                    buildWeeklyReport(
                      next.map((i) => i.report),
                      Date.now(),
                    ),
                  );
                  return next;
                });
              })
              .catch(() => {});
          },
        },
      ],
    );
  };

  // FC tab: session cards flattened under collapsible week headers.
  const fcRows = ((): FcRow[] => {
    const rows: FcRow[] = [];
    let week: string | null = null;
    const visible = onlyWithEvents
      ? items.filter((i) => i.report.eventCount > 0)
      : items;
    for (const item of visible) {
      const w = weekLabel(item.session.startedAt);
      if (w !== week) {
        week = w;
        const count = visible.filter(
          (i) => weekLabel(i.session.startedAt) === w,
        ).length;
        rows.push({ kind: 'week', key: `w-${w}`, label: w, count });
      }
      if (!collapsedWeeks.has(w)) {
        rows.push({
          kind: 'session',
          key: String(item.session.id),
          item,
        });
      }
    }
    return rows;
  })();

  // ECG tab: strips grouped by day, recordings at the end.
  const ecgRows = ((): EcgRow[] => {
    const rows: EcgRow[] = [];
    if (ecgFilter !== 'recordings') {
      const shown = strips.filter((s) =>
        ecgFilter === 'all'
          ? true
          : ecgFilter === 'auto'
            ? !!s.auto
            : !s.auto,
      );
      let day: string | null = null;
      for (const s of shown) {
        const d = stripDayLabel(s.timestamp);
        if (d !== day) {
          day = d;
          rows.push({ kind: 'day', key: `d-${d}`, label: d });
        }
        rows.push({ kind: 'strip', key: `s-${s.timestamp}`, strip: s });
      }
    }
    if (ecgFilter === 'all' || ecgFilter === 'recordings') {
      if (sessions.length > 0) {
        rows.push({
          kind: 'day',
          key: 'd-grabaciones',
          label: 'Grabaciones completas',
        });
        for (const s of sessions) {
          rows.push({ kind: 'recording', key: `r-${s.startedAt}`, session: s });
        }
      }
    }
    return rows;
  })();

  const toggleWeek = (label: string) =>
    setCollapsedWeeks((prev) => {
      const next = new Set(prev);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      return next;
    });

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Informes
        </ThemedText>

        {/* Section switcher */}
        <View style={styles.tabRow}>
          {REPORT_TABS.map((t) => (
            <Pressable
              key={t.key}
              onPress={() => setTab(t.key)}
              style={[
                styles.chip,
                { backgroundColor: theme.backgroundElement },
                tab === t.key && {
                  backgroundColor: theme.backgroundSelected,
                },
              ]}>
              <ThemedText type="small">{t.label}</ThemedText>
            </Pressable>
          ))}
        </View>

        {tab === 'resumen' && (
          <FlatList
            data={[]}
            renderItem={null}
            ListHeaderComponent={
              <>
                {/* Morning report — tap to read the night's verdict */}
                <ThemedView type="backgroundElement" style={styles.card}>
                  <ThemedView style={styles.cardHeader}>
                    <ThemedText type="smallBold" style={styles.cardTitle}>
                      🌅 Informe de la noche
                    </ThemedText>
                    <ThemedText type="small" themeColor="textSecondary">
                      {lastMorningReport
                        ? new Date(lastMorningReport.at).toLocaleString(
                            undefined,
                            { day: 'numeric', month: 'short' },
                          )
                        : 'aún no emitido'}
                    </ThemedText>
                  </ThemedView>
                  {lastMorningReport ? (
                    <ThemedText type="small">
                      {lastMorningReport.text}
                    </ThemedText>
                  ) : (
                    <ThemedText type="small" themeColor="textSecondary">
                      Se genera al despertar tras una noche monitorizada —
                      también llega como notificación.
                    </ThemedText>
                  )}
                </ThemedView>

                {weekly && weekly.sessionsCount > 0 && (
                  <WeeklyCard weekly={weekly} />
                )}
                {!weekly && (
                  <ThemedText type="small" themeColor="textSecondary">
                    Sin datos semanales todavía — monitoriza una noche para
                    generar el primer resumen.
                  </ThemedText>
                )}
              </>
            }
            contentContainerStyle={{ paddingBottom: BottomTabInset }}
          />
        )}

        {tab === 'fc' && (
          <>
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
              data={fcRows}
              keyExtractor={(r) => r.key}
              contentContainerStyle={{ paddingBottom: BottomTabInset }}
              ListEmptyComponent={
                <ThemedText type="small" themeColor="textSecondary">
                  {onlyWithEvents && items.length > 0
                    ? 'Ninguna sesión con eventos.'
                    : 'Aún no hay sesiones. El informe aparece al terminar de monitorizar.'}
                </ThemedText>
              }
              renderItem={({ item }) =>
                item.kind === 'week' ? (
                  <Pressable onPress={() => toggleWeek(item.label)}>
                    <ThemedText type="smallBold" style={styles.weekHeader}>
                      {collapsedWeeks.has(item.label) ? '▸' : '▾'}{' '}
                      {item.label} · {item.count} sesión
                      {item.count === 1 ? '' : 'es'}
                    </ThemedText>
                  </Pressable>
                ) : (
                  <ReportCard
                    item={item.item}
                    thresholds={thresholds}
                    strips={stripsOf(item.item)}
                    ecgSessions={ecgSessionsOf(item.item)}
                    onOpenStrip={openStrip}
                    onDeleteStrip={deleteStrip}
                    onExportSession={exportSession}
                    onDeleteSession={deleteSessionRec}
                    onDeleteReport={confirmDeleteReport}
                  />
                )
              }
            />
          </>
        )}

        {tab === 'ecg' && (
          <>
            <View style={styles.tabRow}>
              {ECG_FILTERS.map((f) => (
                <Pressable
                  key={f.key}
                  onPress={() => setEcgFilter(f.key)}
                  style={[
                    styles.chip,
                    { backgroundColor: theme.backgroundElement },
                    ecgFilter === f.key && {
                      backgroundColor: theme.backgroundSelected,
                    },
                  ]}>
                  <ThemedText type="small">{f.label}</ThemedText>
                </Pressable>
              ))}
            </View>
            <FlatList
              data={ecgRows}
              keyExtractor={(r) => r.key}
              contentContainerStyle={{ paddingBottom: BottomTabInset }}
              ListEmptyComponent={
                <ThemedText type="small" themeColor="textSecondary">
                  Sin tiras ni grabaciones en esta categoría.
                </ThemedText>
              }
              renderItem={({ item }) =>
                item.kind === 'day' ? (
                  <ThemedText
                    type="smallBold"
                    style={styles.weekHeader}>
                    {item.label}
                  </ThemedText>
                ) : item.kind === 'strip' ? (
                  <StripRow
                    s={item.strip}
                    onOpen={openStrip}
                    onDelete={deleteStrip}
                  />
                ) : (
                  <EcgSessionRow
                    s={item.session}
                    onExport={exportSession}
                    onDelete={deleteSessionRec}
                  />
                )
              }
              ListFooterComponent={
                <ThemedText type="small" themeColor="textSecondary">
                  Toca una tira para ver la onda y su análisis · mantén para
                  borrar · toca una grabación para exportar su CSV.
                </ThemedText>
              }
            />
          </>
        )}

        {tab === 'sueno' && (
          <FlatList
            data={suenoRows}
            keyExtractor={(r) => r.key}
            contentContainerStyle={{ paddingBottom: BottomTabInset }}
            ListHeaderComponent={
              <>
                <GarminCard series={garmin} onConnect={connectGarmin} />
                <WatchVsBandTrend items={items} watch={garmin} />
                <RmssdTrend />
              </>
            }
            ListEmptyComponent={
              <ThemedText type="small" themeColor="textSecondary">
                Aún no hay noches monitorizadas — la estimación de sueño
                sale de la propia curva de FC, sin acelerómetro.
              </ThemedText>
            }
            renderItem={({ item }) =>
              item.item ? (
                <SleepCard
                  item={item.item}
                  watch={item.point}
                  onDelete={confirmDeleteReport}
                />
              ) : item.point ? (
                <WatchNightCard point={item.point} />
              ) : null
            }
          />
        )}
      </SafeAreaView>
    </ThemedView>
  );
}
const styles = StyleSheet.create({
  container: { flex: 1 },
  safeArea: { flex: 1, paddingHorizontal: Spacing.four },
  title: { paddingVertical: Spacing.three, alignSelf: 'center' },
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
  tabRow: {
    flexDirection: 'row',
    gap: Spacing.two,
    marginBottom: Spacing.two,
  },
  chip: {
    borderRadius: Spacing.five,
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
  },
  weekHeader: {
    paddingVertical: Spacing.two,
    textTransform: 'capitalize',
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 3,
    height: 52,
    paddingTop: 4,
  },
  trendBar: {
    flex: 1,
    borderRadius: 2,
    minWidth: 4,
  },
  trendPair: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  trendPairBars: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    flex: 1,
    width: '100%',
  },
  trendPairLabel: {
    fontSize: 9,
  },
  trendChips: {
    flexDirection: 'row',
    gap: 6,
  },
  trendChip: {
    borderRadius: Spacing.five,
    paddingHorizontal: 10,
    paddingVertical: 2,
  },
});
