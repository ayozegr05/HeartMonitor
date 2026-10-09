/**
 * Caregiver alert copy — pure domain, no network or RN dependencies.
 * One canonical wording shared by the Telegram auto-send and the
 * WhatsApp one-tap flow, so a caregiver always reads the same alert.
 *
 * Tone: observational, never diagnostic — same stance as the app.
 */

import type { AlertEvent } from '@/domain/models';

const hhmm = (ts: number): string => {
  const d = new Date(ts);
  const h = String(d.getHours()).padStart(2, '0');
  const m = String(d.getMinutes()).padStart(2, '0');
  return `${h}:${m}`;
};

/** "⚠️ Bradicardia: FC 38 bpm durante 45 s (03:12) — HeartMonitor" */
export function buildEventMessage(event: AlertEvent): string {
  const time = hhmm(event.timestamp);
  if (event.type === 'bradycardia') {
    const secs = Math.round((event.durationMs ?? 0) / 1000);
    return `⚠️ Bradicardia detectada: FC ${event.bpm} bpm durante ${secs} s (${time}) — HeartMonitor`;
  }
  return `⚠️ Pausa detectada: intervalo RR de ${event.rrIntervalMs} ms (${time}) — HeartMonitor`;
}

/** BLE outage alerts — link lost or connected-but-silent. */
export function buildOutageMessage(kind: 'disconnect' | 'noData'): string {
  return kind === 'disconnect'
    ? '⌚ Reloj sin conexión: sin datos de FC desde hace más de 2 min — HeartMonitor'
    : '⌚ Reloj conectado pero sin datos — puede que «Emitir FC» esté apagado — HeartMonitor';
}

/** Wraps the morning report summary for the caregiver channel. */
export function buildMorningMessage(summary: string): string {
  return `🌅 Informe nocturno\n${summary}\n— HeartMonitor`;
}
