import type { AlertEvent } from '@/domain/models';
import {
  analyzeEcgStrip,
  classifyPauseEvent,
} from '@/domain/ecgAnalysis';
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
      setTimeout(() => {
        const shot = this.buf.slice(-CAPTURE_SAMPLES);
        if (shot.length < SAMPLE_RATE) return;
        const cls = classifyPauseEvent(shot, SAMPLE_RATE);
        saveStrip({
          timestamp: ts,
          sampleRateHz: SAMPLE_RATE,
          samples: shot,
          report: analyzeEcgStrip(shot, SAMPLE_RATE),
          label:
            event.type === 'bradycardia'
              ? 'bradicardia — tira automática en el evento'
              : cls.label,
          auto: true,
        });
        void fireAlert(
          '📼 Tira ECG guardada',
          event.type === 'bradycardia'
            ? `Bradicardia ${event.bpm ?? '?'} bpm — tira de 30 s en Informes`
            : `${cls.label} · hueco ${cls.gapMs} ms`,
        ).catch(() => undefined);
      }, CAPTURE_DELAY_MS);
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
