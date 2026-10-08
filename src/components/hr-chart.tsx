import { StyleSheet, View } from 'react-native';

import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import type { ChartBucket } from '@/domain/hrChart';

const OK_COLOR = '#4C8DFF';
const LOW_COLOR = '#E5484D';
const EVENT_COLOR = '#FFB020';
const MARKER_PAD = 8;

interface HrChartProps {
  buckets: ChartBucket[];
  /** Bucket indices containing an event — drawn as a marker above the bar. */
  eventMarks?: Set<number>;
  /** Alert floor for the window — drawn as a horizontal reference line. */
  thresholdBpm?: number | null;
  height?: number;
  /** Sparkline mode: no axis labels, tighter padding. */
  compact?: boolean;
}

/**
 * Dependency-free HR chart rendered with plain Views: one column per time
 * bucket (gaps stay empty — no fake interpolated signal), a dashed-less
 * reference line at the alert floor, and event markers on top.
 */
export function HrChart({
  buckets,
  eventMarks,
  thresholdBpm = null,
  height = 96,
  compact = false,
}: HrChartProps) {
  const values = buckets.filter((b) => b.hasData).map((b) => b.avgBpm);
  const ref = thresholdBpm !== null ? [...values, thresholdBpm] : values;
  if (ref.length === 0) return null;
  const lo = Math.min(...ref);
  const hi = Math.max(...ref);
  const span = Math.max(1, hi - lo);
  const y = (v: number) => ((v - lo) / span) * (height - MARKER_PAD);

  const startLabel = new Date(buckets[0].startTs).toLocaleTimeString(
    undefined,
    { hour: '2-digit', minute: '2-digit' },
  );
  const endTs = buckets[buckets.length - 1].startTs;
  const endLabel = new Date(endTs).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  });

  return (
    <View>
      <View style={[styles.plot, { height }]}>
        {thresholdBpm !== null && (
          <View
            style={[
              styles.thresholdLine,
              { bottom: y(thresholdBpm) },
            ]}
          />
        )}
        {buckets.map((b, i) => (
          <View key={i} style={styles.column}>
            {b.hasData && (
              <View
                style={[
                  styles.bar,
                  {
                    height: Math.max(2, y(b.avgBpm)),
                    backgroundColor: b.belowThreshold ? LOW_COLOR : OK_COLOR,
                  },
                ]}>
                {eventMarks?.has(i) && (
                  <View
                    style={[styles.eventDot, { backgroundColor: EVENT_COLOR }]}
                  />
                )}
              </View>
            )}
          </View>
        ))}
      </View>
      {!compact && (
        <View style={styles.axisRow}>
          <ThemedText type="small" themeColor="textSecondary">
            {startLabel}
          </ThemedText>
          <View style={styles.axisCenter}>
            {thresholdBpm !== null && (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={{ color: LOW_COLOR }}>
                — umbral {thresholdBpm}
              </ThemedText>
            )}
            {eventMarks && eventMarks.size > 0 && (
              <ThemedText
                type="small"
                themeColor="textSecondary"
                style={{ color: EVENT_COLOR }}>
                ● evento
              </ThemedText>
            )}
          </View>
          <ThemedText type="small" themeColor="textSecondary">
            {endLabel}
          </ThemedText>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    overflow: 'visible',
  },
  column: {
    flex: 1,
    justifyContent: 'flex-end',
  },
  bar: {
    borderTopLeftRadius: 1,
    borderTopRightRadius: 1,
  },
  eventDot: {
    position: 'absolute',
    top: -MARKER_PAD + 1,
    alignSelf: 'center',
    width: 5,
    height: 5,
    borderRadius: 3,
  },
  thresholdLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: LOW_COLOR,
    opacity: 0.6,
    zIndex: 1,
  },
  axisRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginTop: Spacing.one,
  },
  axisCenter: { flexDirection: 'row', gap: Spacing.three },
});
