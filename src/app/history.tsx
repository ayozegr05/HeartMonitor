import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';

import { ThemedText } from '@/components/themed-text';
import { ThemedView } from '@/components/themed-view';
import { BottomTabInset, Spacing } from '@/constants/theme';
import { getEventsSince } from '@/data/readingsRepository';
import { events } from '@/data/schema';
import { useTheme } from '@/hooks/use-theme';
import type { AlertEvent } from '@/domain/models';

type EventRow = typeof events.$inferSelect;

/** Colors per event type — same accents used across the app. */
const TYPE_COLOR: Record<string, string> = {
  pause: '#FFB020',
  bradycardia: '#E5484D',
};

const WEEKDAY_LABELS = ['L', 'M', 'X', 'J', 'V', 'S', 'D'];
const TREND_DAYS = 28;

/** Local day key — groups events under the calendar's day cells. */
function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}

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
  const [rows, setRows] = useState<EventRow[]>([]);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });
  const [selectedDay, setSelectedDay] = useState<string>(() =>
    dayKey(Date.now()),
  );

  // A 3-month window covers the displayed month plus the 28-day trend.
  useFocusEffect(
    useCallback(() => {
      const since = new Date();
      since.setMonth(since.getMonth() - 3);
      getEventsSince(since.getTime())
        .then(setRows)
        .catch(() => setRows([]));
    }, []),
  );

  /** day key → rows, for the calendar dots and the day's expanded list. */
  const byDay = useMemo(() => {
    const map = new Map<string, EventRow[]>();
    for (const r of rows) {
      const k = dayKey(r.timestamp);
      const arr = map.get(k);
      if (arr) arr.push(r);
      else map.set(k, [r]);
    }
    return map;
  }, [rows]);

  /** Events/day for the last TREND_DAYS — the evolution mini-chart. */
  const trend = useMemo(() => {
    const days: { key: string; label: string; count: number }[] = [];
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    for (let i = TREND_DAYS - 1; i >= 0; i--) {
      const d = new Date(today);
      d.setDate(d.getDate() - i);
      const key = dayKey(d.getTime());
      days.push({
        key,
        label: `${d.getDate()}`,
        count: byDay.get(key)?.length ?? 0,
      });
    }
    return days;
  }, [byDay]);
  const trendMax = Math.max(1, ...trend.map((d) => d.count));

  /** Calendar cells: leading blanks (week starts Monday) + month days. */
  const cells = useMemo(() => {
    const first = new Date(month.year, month.month, 1);
    const leading = (first.getDay() + 6) % 7; // Mon=0 … Sun=6
    const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
    const list: ({ key: string; day: number } | null)[] = [];
    for (let i = 0; i < leading; i++) list.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const date = new Date(month.year, month.month, d);
      list.push({ key: dayKey(date.getTime()), day: d });
    }
    return list;
  }, [month]);

  const monthLabel = new Date(month.year, month.month, 1).toLocaleString(
    undefined,
    { month: 'long', year: 'numeric' },
  );
  const shiftMonth = (delta: number) =>
    setMonth((m) => {
      const d = new Date(m.year, m.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });

  const selectedRows = byDay.get(selectedDay) ?? [];
  const [selY, selM, selD] = selectedDay.split('-').map(Number);
  const selectedLabel = new Date(
    selY,
    selM,
    selD,
  ).toLocaleDateString(undefined, {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  });

  return (
    <ThemedView style={styles.container}>
      <SafeAreaView style={styles.safeArea}>
        <ThemedText type="subtitle" style={styles.title}>
          Eventos
        </ThemedText>
        <FlatList
          data={selectedRows}
          keyExtractor={(r) => String(r.id)}
          contentContainerStyle={{ paddingBottom: BottomTabInset }}
          ListHeaderComponent={
            <>
              {/* Trend: events/day, last 4 weeks */}
              <ThemedView type="backgroundElement" style={styles.card}>
                <ThemedText type="smallBold">
                  Tendencia · eventos por día
                </ThemedText>
                <View style={styles.trendRow}>
                  {trend.map((d) => (
                    <View key={d.key} style={styles.trendBarWrap}>
                      <View
                        style={[
                          styles.trendBar,
                          {
                            height: Math.max(
                              2,
                              (d.count / trendMax) * 64,
                            ),
                            backgroundColor:
                              d.count === 0
                                ? theme.backgroundSelected
                                : '#E5484D',
                          },
                        ]}
                      />
                    </View>
                  ))}
                </View>
                <ThemedText type="small" themeColor="textSecondary">
                  últimas 4 semanas
                </ThemedText>
              </ThemedView>

              {/* Month calendar */}
              <ThemedView type="backgroundElement" style={styles.card}>
                <View style={styles.monthHeader}>
                  <Pressable onPress={() => shiftMonth(-1)} hitSlop={12}>
                    <ThemedText type="smallBold">‹</ThemedText>
                  </Pressable>
                  <ThemedText type="smallBold" style={styles.monthLabel}>
                    {monthLabel}
                  </ThemedText>
                  <Pressable onPress={() => shiftMonth(1)} hitSlop={12}>
                    <ThemedText type="smallBold">›</ThemedText>
                  </Pressable>
                </View>
                <View style={styles.weekRow}>
                  {WEEKDAY_LABELS.map((w) => (
                    <ThemedText
                      key={w}
                      type="small"
                      themeColor="textSecondary"
                      style={styles.weekday}>
                      {w}
                    </ThemedText>
                  ))}
                </View>
                <View style={styles.grid}>
                  {cells.map((cell, i) =>
                    cell === null ? (
                      <View key={`b${i}`} style={styles.cell} />
                    ) : (
                      <Pressable
                        key={cell.key}
                        onPress={() => setSelectedDay(cell.key)}
                        style={[
                          styles.cell,
                          selectedDay === cell.key && {
                            backgroundColor: theme.backgroundSelected,
                            borderRadius: Spacing.two,
                          },
                        ]}>
                        <ThemedText type="small">{cell.day}</ThemedText>
                        <View style={styles.dots}>
                          {[...new Set(
                            (byDay.get(cell.key) ?? []).map((r) => r.type),
                          )].map((t) => (
                            <View
                              key={t}
                              style={[
                                styles.dot,
                                {
                                  backgroundColor:
                                    TYPE_COLOR[t] ?? theme.textSecondary,
                                },
                              ]}
                            />
                          ))}
                        </View>
                      </Pressable>
                    ),
                  )}
                </View>
                <View style={styles.legend}>
                  <View style={styles.legendItem}>
                    <View
                      style={[styles.dot, { backgroundColor: '#FFB020' }]}
                    />
                    <ThemedText type="small" themeColor="textSecondary">
                      pausa
                    </ThemedText>
                  </View>
                  <View style={styles.legendItem}>
                    <View
                      style={[styles.dot, { backgroundColor: '#E5484D' }]}
                    />
                    <ThemedText type="small" themeColor="textSecondary">
                      bradicardia
                    </ThemedText>
                  </View>
                </View>
              </ThemedView>

              <ThemedText type="smallBold" style={styles.dayTitle}>
                {selectedLabel}
              </ThemedText>
            </>
          }
          ListEmptyComponent={
            <ThemedText type="small" themeColor="textSecondary">
              Sin eventos este día.
            </ThemedText>
          }
          renderItem={({ item }) => (
            <ThemedView type="backgroundElement" style={styles.row}>
              <View style={styles.rowHeader}>
                <View
                  style={[
                    styles.dot,
                    {
                      backgroundColor:
                        TYPE_COLOR[item.type] ?? theme.textSecondary,
                    },
                  ]}
                />
                <ThemedText type="smallBold">{describe(item)}</ThemedText>
              </View>
              <ThemedText type="small" themeColor="textSecondary">
                {new Date(item.timestamp).toLocaleTimeString()}
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
  card: {
    borderRadius: Spacing.three,
    padding: Spacing.three,
    marginBottom: Spacing.three,
    gap: Spacing.two,
  },
  trendRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: 2,
    height: 64,
  },
  trendBarWrap: { flex: 1, justifyContent: 'flex-end' },
  trendBar: { borderRadius: 2, width: '100%' },
  monthHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  monthLabel: { textTransform: 'capitalize' },
  weekRow: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  cell: {
    width: `${100 / 7}%`,
    alignItems: 'center',
    paddingVertical: Spacing.two,
    gap: 2,
  },
  dots: { flexDirection: 'row', gap: 3, minHeight: 6 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  legend: { flexDirection: 'row', gap: Spacing.three },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dayTitle: { marginBottom: Spacing.two, textTransform: 'capitalize' },
  row: {
    borderRadius: Spacing.two,
    padding: Spacing.three,
    marginBottom: Spacing.two,
    gap: Spacing.half,
  },
  rowHeader: { flexDirection: 'row', alignItems: 'center', gap: Spacing.two },
});
