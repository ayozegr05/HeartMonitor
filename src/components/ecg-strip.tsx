import { StyleSheet, View } from 'react-native';

const TRACE_COLOR = '#2ECC71';
const GRID_COLOR = 'rgba(128,128,128,0.18)';

interface EcgStripProps {
  /** Rolling window of µV samples, oldest → newest. */
  samples: number[];
  /** Vertical zoom factor applied to the auto-scale. */
  gain?: number;
  height?: number;
  /** Columns rendered; each aggregates a few samples (min→max bar). */
  columns?: number;
}

/**
 * Hospital-style ECG strip drawn with plain Views — one column per
 * output pixel, spanning that pixel's min→max sample range, so the
 * trace reads like an oscilloscope (and costs one View per column).
 * Scales to the window's own amplitude; `gain` zooms on top.
 */
export function EcgStrip({
  samples,
  gain = 1,
  height = 160,
  columns = 300,
}: EcgStripProps) {
  const n = samples.length;
  if (n === 0) {
    return <View style={[styles.plot, { height }]} />;
  }
  let lo = Infinity;
  let hi = -Infinity;
  const sorted = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const v = samples[i];
    sorted[i] = v;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  sorted.sort((a, b) => a - b);
  // Anchor to the baseline (median), not the min→max midpoint: the R
  // spike lifts that midpoint, so zooming on it pushed the trace up.
  const mid = sorted[n >> 1];
  const halfSpan = Math.max(50, ((hi - lo) / 2) * 1.15);
  const scaled = halfSpan / Math.max(0.05, gain);
  const y = (v: number) =>
    Math.max(0, Math.min(height, ((mid + scaled - v) / (2 * scaled)) * height));

  const perCol = Math.max(1, Math.floor(n / columns));
  const cols: { top: number; bottom: number }[] = [];
  for (let c = 0; c < columns; c++) {
    const a = c * perCol;
    if (a >= n) break;
    const b = Math.min(n, a + perCol);
    let cLo = Infinity;
    let cHi = -Infinity;
    for (let i = a; i < b; i++) {
      const v = samples[i];
      if (v < cLo) cLo = v;
      if (v > cHi) cHi = v;
    }
    cols.push({ top: y(cHi), bottom: y(cLo) });
  }

  return (
    <View style={[styles.plot, { height }]}>
      {/* 1 mV centre grid + mid line, hospital-strip style */}
      <View style={[styles.gridLine, { top: height * 0.25 }]} />
      <View style={[styles.gridLine, { top: height * 0.5, opacity: 0.35 }]} />
      <View style={[styles.gridLine, { top: height * 0.75 }]} />
      {cols.map((c, i) => (
        <View
          key={i}
          style={[
            styles.column,
            {
              top: c.top,
              height: Math.max(2, c.bottom - c.top),
            },
          ]}
        />
      ))}
      {/* write head marker */}
      <View style={styles.writeHead} />
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
    flexDirection: 'row',
    overflow: 'hidden',
    backgroundColor: 'rgba(0,0,0,0.35)',
    borderRadius: 6,
  },
  gridLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: 1,
    backgroundColor: GRID_COLOR,
  },
  column: {
    position: 'relative',
    flex: 1,
    backgroundColor: TRACE_COLOR,
  },
  writeHead: {
    position: 'absolute',
    right: 0,
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: TRACE_COLOR,
    opacity: 0.5,
  },
});
