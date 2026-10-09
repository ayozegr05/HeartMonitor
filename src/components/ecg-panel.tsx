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
/** Rolling window the analyser sees (~7 s at the H10's fixed 130 Hz). */
const WINDOW_SAMPLES = 910;
/** Strip length at gain 1 (~4 s — 3-4 beats at ~65 bpm). */
const STRIP_SAMPLES = 520;
/** How often the morphology analysis re-runs over the window. */
const ANALYZE_MS = 2_000;
/** Shortest strip a zoom shows (~2 s at 130 Hz) — a couple of beats. */
const MIN_STRIP_SAMPLES = 260;

interface EcgPanelProps {
  /** Builds the source to stream from (Polar device or mock). */
  createSource: () => IEcgSource;
  /** Label shown in the header — e.g. 'Polar H10' or 'ECG simulado'. */
  title: string;
  /** The source is a MockEcgSensor — show the scenario chips. */
  isMock?: boolean;
  /** Live HR status line — e.g. '62 bpm · monitorizando' — shown under
      the title so the user sees the session keeps running underneath. */
  liveStatus?: string;
}

/**
 * On-demand ECG view: scrolling strip + live morphology analysis.
 * Entered from Monitor; the sentinel HR session keeps running
 * underneath — this only borrows the strap's second BLE service.
 */
export function EcgPanel({ createSource, title, isMock, liveStatus }: EcgPanelProps) {
  const [samples, setSamples] = useState<number[]>([]);
  const [report, setReport] = useState<EcgRhythmReport | null>(null);
  const [flags, setFlags] = useState<string[]>([]);
  const [state, setState] = useState<string>('idle');
  const [gain, setGain] = useState(1);
  const [scenario, setScenario] = useState<MockEcgScenario>('normal');
  const [savedStrips, setSavedStrips] = useState(0);
  const buf = useRef<number[]>([]);
  const sourceRef = useRef<IEcgSource | null>(null);
  // Flags latch: a pattern seen once stays visible while the window
  // slides past it (e.g. a dropped beat only sits in-frame briefly).
  const flagsSeen = useRef<Set<string>>(new Set());

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
    // No auto-start: the user launches the stream with the Iniciar button,
    // like a hospital monitor — the strip appears on demand, and the BLE
    // link is shared with the HR session via the link lease.

    const paint = setInterval(() => {
      setSamples(buf.current.slice(-WINDOW_SAMPLES));
    }, 250);
    const analyze = setInterval(() => {
      const w = buf.current.slice(-WINDOW_SAMPLES);
      if (w.length >= 130) {
        const r = analyzeEcgStrip(w, 130);
        setReport(r);
        const seen = flagsSeen.current;
        let changed = false;
        for (const f of r.flags) {
          if (!seen.has(f)) {
            seen.add(f);
            changed = true;
          }
        }
        if (changed) setFlags([...seen]);
      }
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
  const busy = state === 'connecting';

  return (
    <View style={styles.panel}>
      <View style={styles.headerRow}>
        <View>
          <ThemedText type="smallBold">{title}</ThemedText>
          {liveStatus !== undefined && (
            <ThemedText type="small" themeColor="textSecondary">
              {liveStatus}
            </ThemedText>
          )}
        </View>
        <View style={styles.headerRight}>
          <ThemedText type="small" themeColor="textSecondary">
            {streaming
              ? 'ECG en vivo'
              : state === 'error'
                ? 'error — sin señal'
                : busy
                  ? 'conectando…'
                  : 'en pausa'}
          </ThemedText>
        </View>
      </View>

      <EcgStrip
        samples={samples.slice(
          -Math.max(MIN_STRIP_SAMPLES, Math.round(STRIP_SAMPLES / gain)),
        )}
        gain={gain}
        height={260}
      />

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

      {flags.map((f) => (
        <ThemedText key={f} type="small" style={styles.flag}>
          ⚠️ {f}
        </ThemedText>
      ))}

      {/* On-device diagnostics — invaluable when debugging a real strap
          where no debugger is attached. */}
      <DebugLine sourceRef={sourceRef} />

      {isMock && (
        <View style={styles.chipRow}>
          {(Object.keys(MOCK_ECG_SCENARIO_LABELS) as MockEcgScenario[]).map(
            (s) => (
              <Pressable
                key={s}
                onPress={() => {
                  setScenario(s);
                  flagsSeen.current.clear();
                  setFlags([]);
                  const src = sourceRef.current;
                  if (src instanceof MockEcgSensor) src.setScenario(s);
                }}
                style={[
                  styles.chip,
                  scenario === s && styles.chipSelected,
                ]}>
                <ThemedText
                  type="small"
                  style={scenario === s ? styles.chipSelectedText : undefined}>
                  {MOCK_ECG_SCENARIO_LABELS[s]}
                </ThemedText>
              </Pressable>
            ),
          )}
        </View>
      )}

      {/* Big start/stop — same weight as the monitor's main button */}
      <Pressable
        style={[
          styles.bigButton,
          streaming ? styles.bigButtonStop : styles.bigButtonStart,
          busy && { opacity: 0.5 },
        ]}
        disabled={busy}
        onPress={() => {
          const src = sourceRef.current;
          if (!src) return;
          if (streaming) {
            void src.stop();
            setSamples([]);
            buf.current = [];
          } else {
            src.start().catch(() => setState('error'));
          }
        }}>
        <ThemedText type="smallBold" style={styles.bigButtonText}>
          {streaming ? 'Detener ECG' : 'Iniciar ECG'}
        </ThemedText>
      </Pressable>

      <View style={styles.controlsRow}>
        <Pressable
          style={styles.ctrl}
          onPress={() => setGain((g) => Math.max(0.25, g / 2))}>
          <ThemedText type="smallBold">−</ThemedText>
        </Pressable>
        <ThemedText type="small" themeColor="textSecondary">
          ganancia {gain.toFixed(2)}×
        </ThemedText>
        <Pressable
          style={styles.ctrl}
          onPress={() => setGain((g) => Math.min(16, g * 2))}>
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

function DebugLine({
  sourceRef,
}: {
  sourceRef: { current: IEcgSource | null };
}) {
  const [info, setInfo] = useState<Record<string, string | number>>({});
  useEffect(() => {
    const t = setInterval(() => {
      const d = sourceRef.current?.getDebugInfo?.();
      if (d) setInfo(d);
    }, 500);
    return () => clearInterval(t);
  }, [sourceRef]);
  const entries = Object.entries(info);
  if (entries.length === 0) return null;
  return (
    <ThemedText type="small" themeColor="textSecondary" style={styles.debug}>
      {entries.map(([k, v]) => `${k} ${v}`).join(' · ')}
    </ThemedText>
  );
}

const styles = StyleSheet.create({
  panel: { gap: Spacing.two },
  headerRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerRight: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.two,
  },
  statsRow: { flexDirection: 'row', gap: Spacing.three },
  debug: { opacity: 0.6, fontSize: 10 },
  flag: { color: '#FFB020' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: Spacing.one },
  chip: {
    paddingHorizontal: Spacing.two,
    paddingVertical: Spacing.one,
    borderRadius: 12,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
  },
  chipSelected: {
    backgroundColor: '#2E7D32',
    borderColor: '#2E7D32',
  },
  chipSelectedText: { color: '#ffffff' },
  controlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: Spacing.three,
  },
  bigButton: {
    borderRadius: 10,
    paddingVertical: Spacing.three,
    alignItems: 'center',
  },
  bigButtonStart: { backgroundColor: '#2E7D32' },
  bigButtonStop: { backgroundColor: '#B3261E' },
  bigButtonText: { color: '#ffffff' },
  ctrl: {
    paddingHorizontal: Spacing.three,
    paddingVertical: Spacing.two,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(128,128,128,0.4)',
  },
});
