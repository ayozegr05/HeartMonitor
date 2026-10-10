import { useEffect, useRef, useState } from 'react';
import { StyleSheet, View, type LayoutChangeEvent } from 'react-native';

const TRACE_COLOR = '#2ECC71';
const GRID_COLOR = 'rgba(128,128,128,0.18)';
const LINE_PX = 2;

interface EcgStripProps {
  /** Rolling window of µV samples, oldest → newest. */
  samples: number[];
  /** Vertical zoom factor applied to the auto-scale. */
  gain?: number;
  height?: number;
}

/**
 * Hospital-style ECG strip drawn as a continuous polyline: one rotated
 * segment between consecutive output points. Each point is the sample
 * farthest from the baseline in its bucket, so the R peaks survive the
 * downsampling. Scales to the window's own amplitude; `gain` zooms on top.
 */
export function EcgStrip({ samples, gain = 1, height = 260 }: EcgStripProps) {
  const [width, setWidth] = useState(0);
  const onLayout = (e: LayoutChangeEvent) =>
    setWidth(Math.round(e.nativeEvent.layout.width));

  // Smoothed scale/centre: when a tall R exits the window the raw span
  // would shrink instantly and the whole trace would jump up — lerp
  // towards the target in an effect (refs can't be touched in render).
  const filter = useRef<{ mid: number; span: number } | null>(null);
  const [view, setView] = useState({ mid: 0, span: 1 });

  const n = samples.length;
  useEffect(() => {
    if (n === 0) return;
    const sorted = [...samples].sort((a, b) => a - b);
    const midTarget = sorted[n >> 1];
    // Robust scale: 99th-percentile span — a single artefact spike
    // can't stretch the strip out of shape.
    const p99 =
      sorted[Math.min(n - 1, Math.floor(n * 0.99))] -
      sorted[Math.floor(n * 0.01)];
    const spanTarget = Math.max(50, (p99 / 2) * 1.15);
    if (filter.current === null) {
      filter.current = { mid: midTarget, span: spanTarget };
    } else {
      filter.current.mid += (midTarget - filter.current.mid) * 0.12;
      filter.current.span += (spanTarget - filter.current.span) * 0.12;
    }
    setView({ mid: filter.current.mid, span: filter.current.span });
  }, [samples, n]);

  const points: { x: number; y: number }[] = [];

  if (n > 0 && width > 0) {
    const mid = view.mid;
    const halfSpan = view.span;
    const scaled = halfSpan / Math.max(0.05, gain);
    const y = (v: number) =>
      Math.max(
        -LINE_PX,
        Math.min(height + LINE_PX, ((mid + scaled - v) / (2 * scaled)) * height),
      );

    const cols = Math.max(80, Math.floor(width / 1.4));
    const perCol = n / cols;
    for (let c = 0; c < cols; c++) {
      const a = Math.floor(c * perCol);
      if (a >= n) break;
      const b = Math.min(n, Math.floor(a + perCol) || a + 1);
      // Representative sample: the one farthest from the baseline, so
      // narrow spikes (QRS) are not lost when a bucket has several.
      let best = a;
      let bestDev = -1;
      for (let i = a; i < b; i++) {
        const dev = Math.abs(samples[i] - mid);
        if (dev > bestDev) {
          bestDev = dev;
          best = i;
        }
      }
      points.push({ x: (c * width) / cols, y: y(samples[best]) });
    }
  }

  return (
    <View style={[styles.plot, { height }]} onLayout={onLayout}>
      {/* 1 mV centre grid + mid line, hospital-strip style */}
      <View style={[styles.gridLine, { top: height * 0.25 }]} />
      <View style={[styles.gridLine, { top: height * 0.5, opacity: 0.35 }]} />
      <View style={[styles.gridLine, { top: height * 0.75 }]} />
      {points.slice(1).map((p, i) => {
        const prev = points[i];
        const dx = p.x - prev.x;
        const dy = p.y - prev.y;
        const len = Math.max(1, Math.hypot(dx, dy));
        const angle = Math.atan2(dy, dx);
        return (
          <View
            key={i}
            style={[
              styles.segment,
              {
                left: (p.x + prev.x) / 2 - len / 2,
                top: (p.y + prev.y) / 2 - LINE_PX / 2,
                width: len,
                height: LINE_PX,
                transform: [{ rotate: `${angle}rad` }],
              },
            ]}
          />
        );
      })}
      {/* write head marker */}
      <View style={styles.writeHead} />
    </View>
  );
}

const styles = StyleSheet.create({
  plot: {
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
  segment: {
    position: 'absolute',
    backgroundColor: TRACE_COLOR,
    borderRadius: 1,
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
