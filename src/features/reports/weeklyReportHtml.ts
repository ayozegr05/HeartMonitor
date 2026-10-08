import { formatDuration } from '@/domain/morningReport';
import type { WeeklyReport } from '@/domain/weeklyReport';

const fmt = (ts: number) =>
  new Date(ts).toLocaleDateString('es-ES', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });

const fmtDay = (ts: number) =>
  new Date(ts).toLocaleDateString('es-ES', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  });

const fmtTime = (ts: number) =>
  new Date(ts).toLocaleTimeString('es-ES', {
    hour: '2-digit',
    minute: '2-digit',
  });

const row = (label: string, value: string): string =>
  `<tr><td class="label">${label}</td><td class="value">${value}</td></tr>`;

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * Renders the weekly report as a self-contained HTML document for
 * expo-print. Kept as a pure string builder so the PDF layout is
 * reviewable in the diff and testable without a device.
 */
export function weeklyReportHtml(weekly: WeeklyReport): string {
  const nights = weekly.perSession
    .map(
      (r) => `<tr>
        <td>${esc(fmtDay(r.windowStart))}</td>
        <td>${fmtTime(r.windowStart)} → ${fmtTime(r.windowEnd)}</td>
        <td>${formatDuration(r.durationMs)}</td>
        <td>${r.avgBpm ?? '—'}</td>
        <td>${r.minBpm ?? '—'}–${r.maxBpm ?? '—'}</td>
        <td>${
          r.timeBelowThresholdMs > 0
            ? formatDuration(r.timeBelowThresholdMs)
            : '—'
        }</td>
        <td>${r.eventCount}</td>
      </tr>`,
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="es"><head><meta charset="utf-8">
<style>
  body { font-family: -apple-system, Helvetica, Arial, sans-serif; margin: 32px; color: #1a1a1a; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .period { color: #666; font-size: 13px; margin-bottom: 20px; }
  h2 { font-size: 15px; margin: 24px 0 8px; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  td { border-bottom: 1px solid #e5e5e5; padding: 6px 8px; }
  .label { color: #666; }
  .value { text-align: right; font-weight: 600; }
  .disclaimer { margin-top: 28px; color: #999; font-size: 11px; }
</style></head><body>
<h1>Informe semanal · HeartMonitor</h1>
<div class="period">${fmt(weekly.periodStart)} — ${fmt(weekly.periodEnd)}</div>

<table>
  ${row('Sesiones de monitorización', String(weekly.sessionsCount))}
  ${row('Noches con cobertura', String(weekly.nightsCovered))}
  ${row('Tiempo total monitorizado', formatDuration(weekly.totalMonitoredMs))}
  ${row(
    'FC media semanal',
    weekly.avgBpm !== null
      ? `${weekly.avgBpm} bpm (${weekly.minBpm}–${weekly.maxBpm})`
      : '—',
  )}
  ${row(
    'Tiempo bajo umbral',
    weekly.timeBelowThresholdMs > 0
      ? formatDuration(weekly.timeBelowThresholdMs)
      : 'Sin registros',
  )}
  ${row(
    'Eventos',
    `${weekly.eventCount} (${weekly.bradycardiaCount} bradicardia · ${weekly.pauseCount} pausa)`,
  )}
  ${row(
    'Pausa más larga',
    weekly.longestPauseMs !== null ? `${weekly.longestPauseMs} ms` : '—',
  )}
</table>

<h2>Detalle por sesión</h2>
<table>
  <tr><th align="left">Día</th><th align="left">Horario</th><th align="left">Duración</th><th align="left">Media</th><th align="left">Min–Máx</th><th align="left">Bajo umbral</th><th align="left">Eventos</th></tr>
  ${nights || '<tr><td colspan="7" class="label">Sin sesiones en el período.</td></tr>'}
</table>

<div class="disclaimer">
  Generado por HeartMonitor el ${new Date().toLocaleString('es-ES')}.
  Esta app no es un dispositivo médico: es una herramienta personal de
  registro. Comparte este informe con tu cardiólogo para interpretarlo.
</div>
</body></html>`;
}
