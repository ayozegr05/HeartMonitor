import {
  buildEventMessage,
  buildMorningMessage,
  buildOutageMessage,
} from '@/domain/caregiverMessage';
import type { AlertEvent } from '@/domain/models';

describe('buildEventMessage', () => {
  it('describes a bradycardia with bpm, duration and time', () => {
    const e: AlertEvent = {
      type: 'bradycardia',
      timestamp: new Date(2026, 9, 8, 3, 12, 0).getTime(),
      bpm: 38,
      durationMs: 45_000,
    };
    const m = buildEventMessage(e);
    expect(m).toContain('38');
    expect(m).toContain('45 s');
    expect(m).toContain('03:12');
    expect(m).toContain('HeartMonitor');
  });

  it('describes a pause with its RR interval', () => {
    const e: AlertEvent = {
      type: 'pause',
      timestamp: new Date(2026, 9, 8, 4, 5, 0).getTime(),
      rrIntervalMs: 2_100,
    };
    const m = buildEventMessage(e);
    expect(m).toContain('2100 ms');
    expect(m).toContain('04:05');
  });
});

describe('buildOutageMessage', () => {
  it('covers both outage kinds', () => {
    expect(buildOutageMessage('disconnect')).toContain('sin conexión');
    expect(buildOutageMessage('noData')).toContain('sin datos');
  });
});

describe('buildMorningMessage', () => {
  it('wraps the report summary', () => {
    const m = buildMorningMessage('Mínima 41 · 3 eventos');
    expect(m).toContain('Mínima 41');
    expect(m).toContain('HeartMonitor');
  });
});
