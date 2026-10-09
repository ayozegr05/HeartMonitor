import * as FileSystem from 'expo-file-system/legacy';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import type { CapturedStrip } from './stripStore';

const CSV_POINTS_HEADER = 'ms,uv';

/**
 * Downsamples to `count` points keeping, per bucket, the sample farthest
 * from the window median — same rule as the on-screen strip, so the PDF
 * preserves the R peaks like the user saw them.
 */
function peakPick(samples: number[], count: number): number[] {
  if (samples.length <= count) return samples;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = sorted[sorted.length >> 1];
  const per = samples.length / count;
  const out: number[] = [];
  for (let c = 0; c < count; c++) {
    const a = Math.floor(c * per);
    const b = Math.min(samples.length, Math.floor(a + per));
    let best = a;
    let bestDev = -1;
    for (let i = a; i < b; i++) {
      const dev = Math.abs(samples[i] - mid);
      if (dev > bestDev) {
        bestDev = dev;
        best = i;
      }
    }
    out.push(samples[best]);
  }
  return out;
}

function svgTrace(samples: number[], width: number, height: number): string {
  const pts = peakPick(samples, 1200);
  let lo = Infinity;
  let hi = -Infinity;
  for (const v of pts) {
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  const mid = (lo + hi) / 2;
  const half = Math.max(50, (hi - lo) / 2 + 1);
  const step = width / (pts.length - 1);
  const d = pts
    .map((v, i) => {
      const x = (i * step).toFixed(1);
      const y = (height - ((mid + half - v) / (2 * half)) * height).toFixed(1);
      return `${i === 0 ? 'M' : 'L'}${x},${y}`;
    })
    .join(' ');
  const gridY = [0.25, 0.5, 0.75]
    .map(
      (f) =>
        `<line x1="0" y1="${height * f}" x2="${width}" y2="${height * f}" stroke="#ddd" stroke-width="0.5"/>`,
    )
    .join('');
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">${gridY}<path d="${d}" fill="none" stroke="#1a7a3a" stroke-width="0.8"/></svg>`;
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function stripHtml(strip: CapturedStrip): string {
  const r = strip.report;
  const when = new Date(strip.timestamp).toLocaleString('es-ES', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const stats = [
    `${r.meanBpm} bpm`,
    `QRS ${Math.round(r.meanQrsWidthMs)} ms`,
    r.meanPrMs !== undefined ? `PR ${r.meanPrMs} ms` : null,
    r.droppedBeats > 0 ? `${r.droppedBeats} latidos bloqueados` : null,
    `${Math.round((1 - r.pMissingFraction) * 100)}% con onda P`,
  ]
    .filter(Boolean)
    .join(' · ');
  const flags = r.flags
    .map((f) => `<li style="color:#b8860b">${esc(f)}</li>`)
    .join('');
  return `<!doctype html><html><body style="font-family:sans-serif;padding:24px">
<h2 style="margin:0 0 4px">Tira ECG · HeartMonitor</h2>
<p style="margin:0 0 12px;color:#666">${esc(when)} · 30 s · ${strip.sampleRateHz} Hz</p>
${svgTrace(strip.samples, 980, 240)}
<p style="margin:12px 0 4px">${esc(stats)}</p>
${flags ? `<ul style="margin:4px 0 0;padding-left:18px">${flags}</ul>` : ''}
<p style="margin-top:16px;color:#999;font-size:12px">Registro orientativo de un monitor de pecho — no sustituye un ECG clínico.</p>
</body></html>`;
}

async function shareFile(
  uri: string,
  mimeType: string,
  dialogTitle: string,
  uti?: string,
): Promise<void> {
  if (!(await Sharing.isAvailableAsync())) {
    throw new Error('Compartir no está disponible en este dispositivo');
  }
  await Sharing.shareAsync(uri, { mimeType, dialogTitle, UTI: uti });
}

/** Renders the strip to a one-page PDF and opens the share sheet. */
export async function shareStripPdf(strip: CapturedStrip): Promise<void> {
  const { uri } = await Print.printToFileAsync({
    html: stripHtml(strip),
    base64: false,
  });
  await shareFile(
    uri,
    'application/pdf',
    'Tira ECG · HeartMonitor',
    'com.adobe.pdf',
  );
}

/** Writes the raw samples as CSV (ms, µV) and opens the share sheet. */
export async function shareStripCsv(strip: CapturedStrip): Promise<void> {
  const dt = 1000 / strip.sampleRateHz;
  const lines = [CSV_POINTS_HEADER];
  for (let i = 0; i < strip.samples.length; i++) {
    lines.push(`${(i * dt).toFixed(1)},${strip.samples[i]}`);
  }
  const uri = `${FileSystem.cacheDirectory}ecg-strip-${strip.timestamp}.csv`;
  await FileSystem.writeAsStringAsync(uri, lines.join('\n'));
  await shareFile(uri, 'text/csv', 'Datos ECG (CSV) · HeartMonitor');
}
