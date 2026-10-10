import type { AlertEvent } from '@/domain/models';
import {
  analyzeEcgStrip,
  classifyPauseEvent,
} from '@/domain/ecgAnalysis';
import { removeBaselineWander } from '@/domain/ecgFilter';
import { isNightTime } from '@/domain/thresholds';
import { EcgSessionRecorder } from '@/features/ecg/ecgSessionRecorder';
import { saveStrip } from '@/features/ecg/stripStore';
import { getBleManager } from '@/sensors/bleManager';
import type { IEcgSource } from '@/sensors/ecg';
import { PolarEcgSource } from '@/sensors/polar/PolarEcgSource';
import { fireAlert } from '@/shared/notifications';

/**
 * Background ECG controller — the piece that makes the app "grab the
 * event by itself".
 *
 * When the user picks an auto mode (night / 24 h) and a Polar strap is
 * streaming, this service keeps a quiet ECG source running behind the
 * monitor: a rolling ~45 s buffer in RAM plus a full-session recorder
 * on disk. Every pause/bradycardia event snaps ~30 s around it,
 * classifies the morphology and files the strip under Informes —
 * labelled ("pausa compensatoria", "pausa sinusal", "extrasístole").
 *
 * Battery trade-off is intentional: streaming ECG at 130 Hz costs the
 * strap's coin cell (~200-300 h of ECG vs ~400 h of HR-only), so it is
 * opt-in, never on by default.
 */

export type EcgAutoMode = 'off' | 'night' | 'always';

export const ECG_AUTO_MODE_LABELS: Record<EcgAutoMode, string> = {
  off: 'apagado',
  night: 'nocturno',
  always: '24 h',
};

const SAMPLE_RATE = 130;
/** Rolling buffer kept in RAM (~45 s) — enough for the 30 s snapshot. */
const BUFFER_SAMPLES = 45 * SAMPLE_RATE;
/** Snapshot length saved on an event (~30 s). */
const CAPTURE_SAMPLES = 30 * SAMPLE_RATE;
/** Wait after an event so the strip catches the recovery beats too. */
const CAPTURE_DELAY_MS = 6_000;
/**
 * One event shows up in several consecutive HR readings — dedupe so a
 * single pause cannot file five strips in the same minute.
 */
const CAPTURE_DEDUPE_MS = 90_000;
/**
 * Strips are still saved every time, but the notification only fires
 * once per window — a busy night batches into 'N tiras guardadas'.
 */
const NOTIFY_GAP_MS = 5 * 60_000;
/**
 * Median |sample-to-sample| above this = muscle-noise window: a pause
 * 'detected' there is a missed-beat artefact, so the strip is filed
 * unclassified instead of stamped with a wrong morphology.
 */
const NOISE_FLOOR_UV = 80;
/** How often the sleep-window check re-evaluates 'night' mode. */
const EVAL_MS = 60_000;

class EcgAutoService {
  private mode: EcgAutoMode = 'off';
  private deviceId: string | null = null;
  private label = '';
  private source: IEcgSource | null = null;
  private unsubFrames: (() => void) | null = null;
  private buf: number[] = [];
  private recorder = new EcgSessionRecorder();
  private evalTimer: ReturnType<typeof setInterval> | null = null;
  private starting = false;
  /** Manual stop while an auto mode runs: pause auto-start this long. */
  private suppressUntil = 0;
  /** Last strip filed — blocks duplicate captures of the same event. */
  private lastCaptureAt = 0;
  /** Last notification actually fired — strips in between get batched. */
  private lastNotifyAt = 0;
  /** Strips saved since the last notification went out. */
  private pendingNotify = 0;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;

  /** Called when the BLE monitor session attaches to a strap. */
  attach(deviceId: string, label: string, mode: EcgAutoMode): void {
    this.deviceId = deviceId;
    this.label = label;
    this.mode = mode;
    if (!this.evalTimer) {
      this.evalTimer = setInterval(() => this.evaluate(), EVAL_MS);
    }
    this.evaluate();
  }

  /** Called when the monitor session ends. */
  detach(): void {
    this.deviceId = null;
    if (this.evalTimer) {
      clearInterval(this.evalTimer);
      this.evalTimer = null;
    }
    void this.stopStream();
  }

  setMode(mode: EcgAutoMode): void {
    this.mode = mode;
    this.evaluate();
  }

  getMode(): EcgAutoMode {
    return this.mode;
  }

  /**
   * The panel borrows the live source when the service already streams
   * — one PMD stream shared between background capture and the screen.
   */
  borrowedSource(): IEcgSource | null {
    return this.source;
  }

  /**
   * Event hook — the monitor calls this with freshly detected events.
   * A pause needs the following ~6 s of recovery beats in the strip.
   */
  onEvents(events: AlertEvent[]): void {
    if (!this.source || this.buf.length === 0) return;
    for (const event of events) {
      if (event.type !== 'pause' && event.type !== 'bradycardia') continue;
      const ts = event.timestamp;
      setTimeout(() => this.capture(ts, event), CAPTURE_DELAY_MS);
    }
  }

  /** Snapshot + classify + file the strip, then batch-notify. */
  private capture(ts: number, event: AlertEvent): void {
    if (Date.now() - this.lastCaptureAt < CAPTURE_DEDUPE_MS) return;
    const shot = this.buf.slice(-CAPTURE_SAMPLES);
    if (shot.length < SAMPLE_RATE) return;
    this.lastCaptureAt = Date.now();

    // Classify on the wander-filtered copy — a slow drift inside the
    // gap can fake a lone-P bump on the raw signal. The strip itself
    // keeps the raw samples for the cardiologist.
    const clean = removeBaselineWander(shot, SAMPLE_RATE);
    const diffs = [] as number[];
    for (let i = 1; i < clean.length; i++) {
      diffs.push(Math.abs(clean[i] - clean[i - 1]));
    }
    diffs.sort((a, b) => a - b);
    const noise = diffs.length > 0 ? diffs[Math.floor(diffs.length / 2)] : 0;
    const noisy = noise > NOISE_FLOOR_UV;
    const cls = noisy
      ? {
          kind: 'none' as const,
          label: 'tira automática — ventana con ruido muscular (revisar)',
          gapMs: 0,
        }
      : classifyPauseEvent(clean, SAMPLE_RATE);

    saveStrip({
      timestamp: ts,
      sampleRateHz: SAMPLE_RATE,
      samples: shot,
      report: analyzeEcgStrip(clean, SAMPLE_RATE),
      label:
        event.type === 'bradycardia'
          ? 'bradicardia — tira automática en el evento'
          : cls.label,
      auto: true,
    });
    this.notify(
      event.type === 'bradycardia'
        ? `Bradicardia ${event.bpm ?? '?'} bpm — tira de 30 s en Informes`
        : `${cls.label}${cls.gapMs > 0 ? ` · hueco ${cls.gapMs} ms` : ''}`,
    );
  }

  /**
   * At most one notification per NOTIFY_GAP_MS: the first capture
   * notifies right away, later ones pile up and flush as a count.
   */
  private notify(body: string): void {
    const now = Date.now();
    if (now - this.lastNotifyAt >= NOTIFY_GAP_MS) {
      const extra =
        this.pendingNotify > 0
          ? ` (+${this.pendingNotify} tira${this.pendingNotify > 1 ? 's' : ''} antes)`
          : '';
      this.pendingNotify = 0;
      this.lastNotifyAt = now;
      void fireAlert('📼 Tira ECG guardada', body + extra).catch(
        () => undefined,
      );
      return;
    }
    this.pendingNotify += 1;
    if (!this.notifyTimer) {
      this.notifyTimer = setTimeout(() => {
        this.notifyTimer = null;
        if (this.pendingNotify === 0) return;
        const n = this.pendingNotify;
        this.pendingNotify = 0;
        this.lastNotifyAt = Date.now();
        void fireAlert(
          '📼 Tiras ECG guardadas',
          `${n} tira${n > 1 ? 's' : ''} automática${n > 1 ? 's' : ''} en Informes`,
        ).catch(() => undefined);
      }, NOTIFY_GAP_MS - (now - this.lastNotifyAt));
    }
  }

  /**
   * Manual stop from the panel while an auto mode is active — honour it
   * for a while instead of resurrecting the stream a minute later.
   */
  pauseAutoFor(ms: number): void {
    this.suppressUntil = Date.now() + ms;
    void this.stopStream();
  }

  /** True when the mode says the stream should be running right now. */
  private wanted(): boolean {
    if (!this.deviceId || this.mode === 'off') return false;
    if (Date.now() < this.suppressUntil) return false;
    if (this.mode === 'always') return true;
    return isNightTime(new Date());
  }

  private evaluate(): void {
    if (this.wanted() && !this.source && !this.starting) {
      void this.startStream();
    } else if (!this.wanted() && this.source) {
      void this.stopStream();
    }
  }

  private async startStream(): Promise<void> {
    const deviceId = this.deviceId;
    if (!deviceId) return;
    this.starting = true;
    const src = new PolarEcgSource(
      () => getBleManager().connectToDevice(deviceId),
      `ECG ${this.label}`,
    );
    this.source = src;
    this.buf = [];
    this.unsubFrames = src.subscribe((frame) => {
      for (const s of frame.samples) this.buf.push(s);
      if (this.buf.length > BUFFER_SAMPLES * 2) {
        this.buf.splice(0, this.buf.length - BUFFER_SAMPLES);
      }
      this.recorder.push(frame.samples);
    });
    try {
      await this.recorder.start(SAMPLE_RATE);
      await src.start();
    } catch {
      // Strap rejected or link dropped — the next evaluate() retries.
      await this.stopStream();
    } finally {
      this.starting = false;
    }
  }

  private async stopStream(): Promise<void> {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
    this.unsubFrames?.();
    this.unsubFrames = null;
    const src = this.source;
    this.source = null;
    this.buf = [];
    if (src) await src.stop().catch(() => undefined);
    await this.recorder.stop().catch(() => undefined);
  }
}

export const ecgAutoService = new EcgAutoService();
