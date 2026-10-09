import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';

import { EcgStrip } from '@/components/ecg-strip';
import { ThemedText } from '@/components/themed-text';
import { Spacing } from '@/constants/theme';
import {
  analyzeEcgStrip,
  type EcgRhythmReport,
} from '@/domain/ecgAnalysis';
import { saveStrip } from '@/features/ecg/stripStore';
import type { IEcgSource } from '@/sensors/ecg';
import {
  MOCK_ECG_SCENARIO_LABELS,
  MockEcgSensor,
  type MockEcgScenario,
} from '@/sensors/polar/MockEcgSensor';
import { useTheme } from '@/hooks/use-theme';

/** Rolling window length (~7 s at the H10's fixed 130 Hz). */
const WINDOW_SAMPLES = 910;
/** How often the morphology analysis re-runs over the window. */
const ANALYZE_MS = 2_000;

interface EcgPanelProps {
  /** Builds the source to stream from (Polar device or mock). */
  createSource: () => IEcgSource;
  /** Label shown in the header — e.g. 'Polar H10' or 'ECG simulado'. */
  title: string;
  /** The source is a MockEcgSensor — show the scenario chips. */
  isMock?: boolean;
}

/**
 * On-demand ECG view: scrolling strip + live morphology analysis.
 * Entered from Monitor; the sentinel HR session keeps running
 * underneath — this only borrows the strap's second BLE service.
 */
export function EcgPanel({ createSource, title, isMock }: EcgPanelProps) {
  const theme = useTheme();
  const [samples, setSamples] = useState<number[]>([]);
  const [report, setReport] = useState<EcgRhythmReport | null>(null);
  const [state, setState] = useState<string>('connecting');
  const [gain, setGain] = useState(1);
  const [scenario, setScenario] = useState<MockEcgScenario>('normal');
  const [savedStrips, setSavedStrips] = useState(0);
  const buf = useRef<number[]>([]);
  const sourceRef = useRef<IEcgSource | null>(null);

  useEffect(() => {
    const src = createSource();
    sourceRef.current = src;
    const unsubFrames = src.subscribe((frame) => {
      const b = buf.current;
      for (const s of frame.samples) b.push(s);
      if (b.length > WINDOW_SAMPLES * 2) {
        b.splice(0, b.length - WINDOW_SAMPLES);
      }
    });
    const unsubState = src.onStateChange(setState);
    src.start().catch(() => setState('error'));

    const paint = setInterval(() => {
      setSamples(buf.current.slice(-WINDOW_SAMPLES));
    }, 250);
    const analyze = setInterval(() => {
      const w = buf.current.slice(-WINDOW_SAMPLES);
      if (w.length >= 130) setReport(analyzeEcgStrip(w, 130));
    }, ANALYZE_MS);

    return () => {
      clearInterval(paint);
      clearInterval(analyze);
      unsubFrames();
      unsubState();
      void src.stop();
      sourceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const streaming = state === 'streaming';

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <ThemedText type="smallBold">{title}</ThemedText>
        <ThemedText type="small" themeColor="textSecondary">
          {streaming ? 'ECG en vivo' : state === 'error' ? 'error' : state}
        </ThemedText>
      </View>

      <EcgStrip samples={samples} gain={gain} height={170} />

      {report !== null && report.beats > 0 && (
        <View style={styles.statsRow}>
          <ThemedText type="small" themeColor="textSecondary">
            {report.meanBpm} bpm · QRS {Math.round(report.meanQrsWidthMs)} ms
            · P {Math.round((1 - report.pMissingFraction) * 100)}%
            {report.meanPrMs !== undefined ? ` · PR ${report.meanPrMs} ms` : ''}
            {report.droppedBeats > 0
              ? ` · ${report.droppedBeats} bloqueado${report.droppedBeats === 1 ? '' : 's'}`
              : ''}
          </ThemedText>
        </View>
      )}

      {report !== null &&
        report.flags.map((f) => (
          <ThemedText key={f} type="small" style={styles.flag}>
            ⚠️ {f}
          </ThemedText>
        ))}

      {isMock && (
        <View style={styles.chipRow}>
          {(Object.keys(MOCK_ECG_SCENARIO_LABELS) as MockEcgScenario[]).map(
            (s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setScenario(s);
                  const src = sourceRef.current;
                  if (src instanceof MockEcgSensor) src.setScenario(s);
                }}
                style={[
                  styles.chip,
                  scenario === s && {
                    backgroundColor: theme.backgroundElement,
                  },
                ]}>
                <ThemedText type="small">
                  {MOCK_ECG_SCENARIO_LABELS[s]}
                </ThemedText>
              </Pressable>
            ),
          )}
        </View>
      )}

      <View style={styles.controlsRow}>
        <Pressable
          style={styles.ctrl}
          onPress={() => setGain((g) => Math.max(0.25, g / 1.5))}>
          <ThemedText type="smallBold">−</ThemedText>
        </Pressable>
        <ThemedText type="small" themeColor="textSecondary">
          ganancia {gain.toFixed(2)}×
        </ThemedText>
        <Pressable
          style={styles.ctrl}
          onPress={() => setGain((g) => Math.min(8, g * 1.5))}>
          <ThemedText type="smallBold">+</ThemedText>
        </Pressable>
        <View style={{ flex: 1 }} />
        <Pressable
          style={styles.ctrl}
          onPress={() => {
            // 30 s strip snapshot → attached to the cardiologist PDF later
            const shot = buf.current.slice(-3900);
            if (shot.length === 0) return;
            saveStrip({
              timestamp: Date.now(),
              sampleRateHz: 130,
              samples: shot,
              report: analyzeEcgStrip(shot, 130),
            });
            setSavedStrips((n) => n + 1);
          }}>
          <ThemedText type="smallBold">Capturar 30 s</ThemedText>
        </Pressable>
      </View>
      {savedStrips > 0 && (
        <ThemedText type="small" themeColor="textSecondary">
          {savedStrips} tira{savedStrips === 1 ? '' : 's'} guardada
          {savedStrips === 1 ? '' : 's'} para el informe
        </ThemedText>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: { gap: Spacing.two },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  statsRow: { flexDirection: 'row', gap: Spacing.three },
  flag: { color: '#FFB020' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
  },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  ctrl: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
  },
});
