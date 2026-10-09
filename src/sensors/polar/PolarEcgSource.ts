import type { Device } from 'react-native-ble-plx';

import { acquireBleLink, releaseBleLink } from '../bleLink';
import type { EcgFrame, IEcgSource } from '../ecg';
import type { SensorConnectionState } from '../types';
import {
  buildStartEcgCommand,
  buildStopCommand,
  CONTROL_OP,
  CONTROL_STATUS,
  ECG_SAMPLE_RATE_HZ,
  MEASUREMENT_TYPE,
  parseControlResponse,
  parsePmdData,
  PMD_CONTROL_POINT_UUID,
  PMD_DATA_UUID,
  PMD_SERVICE_UUID,
} from './pmd';

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const a = bytes[i];
    const b = bytes[i + 1];
    const c = bytes[i + 2];
    out += B64[a >> 2];
    out += B64[((a & 3) << 4) | (b === undefined ? 0 : b >> 4)];
    out += b === undefined ? '=' : B64[((b & 15) << 2) | (c === undefined ? 0 : c >> 6)];
    out += c === undefined ? '=' : B64[c & 63];
  }
  return out;
}

/**
 * Polar H10 raw-ECG stream via the PMD service — second BLE service on
 * the strap itself. No Polar SDK, no account, no cloud: the control
 * point takes a START command and the data characteristic streams
 * raw ECG frames (3-byte signed µV samples) until STOP or disconnect.
 *
 * The strap keeps serving the standard HR service at the same time, so
 * the monitoring session is untouched — ECG is a parallel on-demand
 * channel.
 */
export class PolarEcgSource implements IEcgSource {
  readonly label: string;
  private listeners = new Set<(f: EcgFrame) => void>();
  private stateListeners = new Set<(s: SensorConnectionState) => void>();
  private subs: { remove(): void }[] = [];
  private device: Device | null = null;
  private sawData = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  private mtu = 0;
  private ackStatus: string = '—';
  private framesRx = 0;
  private samplesRx = 0;
  private lastError = '';
  private lastFrameAt = 0;

  getDebugInfo(): Record<string, string | number> {
    const silence =
      this.lastFrameAt > 0
        ? Math.round((Date.now() - this.lastFrameAt) / 1000)
        : -1;
    const info: Record<string, string | number> = {
      mtu: this.mtu,
      ack: this.ackStatus,
      frames: this.framesRx,
      muestras: this.samplesRx,
      silencio: silence >= 0 ? `${silence}s` : '—',
    };
    if (this.lastError) info.err = this.lastError;
    return info;
  }

  /**
   * @param device the connected strap, or a resolver returning one
   *        (e.g. `() => manager.connectToDevice(id)` — resolves fast on
   *        an already-connected device).
   */
  constructor(
    deviceOrResolver: Device | (() => Promise<Device>),
    label?: string,
  ) {
    this.label = label ?? 'Polar H10';
    if (typeof deviceOrResolver === 'function') {
      this.resolveDevice = deviceOrResolver;
    } else {
      this.device = deviceOrResolver;
      this.label =
        deviceOrResolver.name ??
        deviceOrResolver.localName ??
        deviceOrResolver.id;
    }
  }

  private resolveDevice: (() => Promise<Device>) | null = null;

  async start(): Promise<void> {
    this.setState('connecting');
    this.sawData = false;
    this.framesRx = 0;
    this.samplesRx = 0;
    this.ackStatus = '—';
    const dev =
      this.device ?? (await this.resolveDevice?.());
    if (!dev) throw new Error('No Polar device');
    this.device = dev;
    await dev.connect();
    acquireBleLink();
    // The H10 rejects START with ERROR_INVALID_MTU when the negotiated
    // MTU is too small — Android defaults to 23 bytes, so ask for the
    // maximum. iOS negotiates this itself; requestMTU throws there.
    try {
      const d = await dev.requestMTU(512);
      this.mtu = d.mtu;
    } catch {
      // platform handles MTU — fine
    }
    // A 130 Hz waveform needs the lowest connection interval Android
    // gives — low-priority connections are where notification streams
    // silently stall on real devices.
    try {
      await dev.requestConnectionPriority(1); // HIGH
    } catch {
      // not supported everywhere — non-fatal
    }
    await dev.discoverAllServicesAndCharacteristics();

    // Ack waiter: the control point echoes the op with a status byte.
    let ackResolve: ((status: number) => void) | null = null;
    const ack = new Promise<number>((r) => (ackResolve = r));
    this.subs.push(
      dev.monitorCharacteristicForService(
        PMD_SERVICE_UUID,
        PMD_CONTROL_POINT_UUID,
        (error, c) => {
          if (error) {
            this.lastError = `cp ${error.errorCode ?? error.message}`;
            return;
          }
          if (!c?.value) return;
          try {
            const r = parseControlResponse(base64ToBytes(c.value));
            if (
              r.opCode === CONTROL_OP.START_MEASUREMENT &&
              r.measurementType === MEASUREMENT_TYPE.ECG &&
              ackResolve
            ) {
              this.ackStatus =
                r.status === CONTROL_STATUS.SUCCESS
                  ? 'ok'
                  : `err ${r.status}`;
              ackResolve(r.status);
              ackResolve = null;
            }
          } catch {
            // stray notification — ignore
          }
        },
      ),
    );

    this.subs.push(
      dev.monitorCharacteristicForService(
        PMD_SERVICE_UUID,
        PMD_DATA_UUID,
        (error, c) => {
          if (error) {
            this.lastError = `data ${error.errorCode ?? error.message}`;
            return;
          }
          if (!c?.value) return;
          try {
            const f = parsePmdData(base64ToBytes(c.value));
            if (f.measurementType !== MEASUREMENT_TYPE.ECG) return;
            this.sawData = true;
            this.lastFrameAt = Date.now();
            this.framesRx += 1;
            this.samplesRx += f.samples.length;
            const frame: EcgFrame = {
              samples: f.samples,
              sampleRateHz: ECG_SAMPLE_RATE_HZ,
              timestamp: Date.now(),
            };
            for (const l of this.listeners) l(frame);
          } catch {
            // malformed frame — drop, keep streaming
          }
        },
      ),
    );

    await dev.writeCharacteristicWithResponseForService(
      PMD_SERVICE_UUID,
      PMD_CONTROL_POINT_UUID,
      bytesToBase64(buildStartEcgCommand()),
    );

    // The strap may ack after we already get frames; a timeout simply
    // means "no ack packet", which is non-fatal.
    const status = await Promise.race([
      ack,
      new Promise<number>((r) =>
        setTimeout(() => {
          if (this.ackStatus === '—') this.ackStatus = 'timeout';
          r(CONTROL_STATUS.SUCCESS);
        }, 3_000),
      ),
    ]);
    if (status !== CONTROL_STATUS.SUCCESS) {
      await this.stop();
      throw new Error(`Polar PMD start rejected (status ${status})`);
    }
    this.setState('streaming');

    // Watchdog: if the stream produced no samples after a few seconds,
    // surface it instead of sitting on a flatline forever.
    this.watchdog = setTimeout(() => {
      if (!this.sawData) {
        void this.stop();
        this.setState('error');
      }
    }, 5_000);
  }

  async stop(): Promise<void> {
    try {
      await this.device?.writeCharacteristicWithResponseForService(
        PMD_SERVICE_UUID,
        PMD_CONTROL_POINT_UUID,
        bytesToBase64(buildStopCommand(MEASUREMENT_TYPE.ECG)),
      );
    } catch {
      // already gone — fine
    }
    if (this.watchdog) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.sawData = false;
    for (const s of this.subs) s.remove();
    this.subs = [];
    await releaseBleLink(this.device);
    this.setState('idle');
  }

  subscribe(listener: (frame: EcgFrame) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(
    listener: (state: SensorConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private setState(state: SensorConnectionState): void {
    for (const l of this.stateListeners) l(state);
  }
}
