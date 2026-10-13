import type { GarminDayPoint } from '@/features/healthconnect/garminSummary';

import {
    GarminAuthError,
    garminGet,
    loadGarminTokens,
} from './garminClient';

/**
 * Garmin Connect private-API readers for the vitals Garmin refuses to
 * write into Health Connect: overnight HRV (RMSSD), SpO2, respiration
 * and resting HR — plus rich sleep detail as a bonus.
 *
 * Response shapes come from the OSS ecosystem docs (garth /
 * python-garminconnect) and are NOT contract-stable — every extractor
 * scans several candidate keys and tolerates missing fields.
 */

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const daysAgo = (n: number): Date => new Date(Date.now() - n * 86_400_000);

/** First finite number found among the candidate keys (shallow). */
const pickNum = (o: unknown, keys: string[]): number | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v))) {
      return Number(v);
    }
  }
  return undefined;
};

/** Depth-first search for the first candidate key holding a number. */
const deepPickNum = (o: unknown, keys: string[], depth = 4): number | undefined => {
  if (depth < 0 || !o || typeof o !== 'object') return undefined;
  const direct = pickNum(o, keys);
  if (direct !== undefined) return direct;
  for (const v of Object.values(o as Record<string, unknown>)) {
    if (v && typeof v === 'object') {
      const found = deepPickNum(v, keys, depth - 1);
      if (found !== undefined) return found;
    }
  }
  return undefined;
};

const pickDay = (o: unknown): string | undefined => {
  if (!o || typeof o !== 'object') return undefined;
  const rec = o as Record<string, unknown>;
  for (const k of ['calendarDate', 'date', 'day']) {
    const d = rec[k];
    if (typeof d === 'string' && /^\d{4}-\d{2}-\d{2}/.test(d)) return d.slice(0, 10);
  }
  return undefined;
};

interface HrvSummary {
  day: string;
  avg: number;
}

/**
 * /hrv-service/hrv/daily/{start}/{end} — one call covers the range.
 * Garmin's calendarDate for lastNightAvg is the wake-day bucket, so it
 * already matches the app convention; do not subtract a day here.
 */
async function fetchHrvRange(start: string, end: string): Promise<HrvSummary[]> {
  const data = (await garminGet(`/hrv-service/hrv/daily/${start}/${end}`)) as
    | Record<string, unknown>
    | unknown[]
    | null;
  if (!data) return [];

  const out: HrvSummary[] = [];
  const candidates = Array.isArray(data)
    ? data
    : ((data.hrvSummaries ?? data.hrvSummaryList ?? data.summaries) as
        | unknown[]
        | undefined);
  const list =
    candidates ??
    (data && typeof data === 'object' && 'hrvSummary' in data
      ? [(data as Record<string, unknown>).hrvSummary]
      : []);

  for (const item of list ?? []) {
    const node =
      item && typeof item === 'object' && 'hrvSummary' in item
        ? ((item as Record<string, unknown>).hrvSummary ?? item)
        : item;
    const day = pickDay(node);
    const avg = deepPickNum(node, [
      'lastNightAvg',
      'lastNightAverage',
      'avgValue',
      'average',
      'weeklyAvg',
    ]);
    if (day && avg !== undefined) out.push({ day, avg: Math.round(avg) });
  }
  return out;
}

/** /userstats-service/wellness/daily/{user}?fromDate&untilDate */
async function fetchDailyStats(
  displayName: string,
  start: string,
  end: string,
): Promise<Map<string, Partial<GarminDayPoint>>> {
  const out = new Map<string, Partial<GarminDayPoint>>();
  const data = (await garminGet(
    `/userstats-service/wellness/daily/${encodeURIComponent(displayName)}?fromDate=${start}&untilDate=${end}`,
  )) as unknown[] | Record<string, unknown> | null;
  const list = Array.isArray(data)
    ? data
    : ((data as Record<string, unknown> | null)?.dailySummaries as
        | unknown[]
        | undefined) ?? [];
  for (const item of list) {
    const day = pickDay(item);
    if (!day) continue;
    const p: Partial<GarminDayPoint> = {};
    const rhr = deepPickNum(item, ['restingHeartRate', 'restingBpm', 'minHeartRate']);
    if (rhr !== undefined) p.restingBpm = Math.round(rhr);
    const steps = deepPickNum(item, ['totalSteps', 'steps']);
    if (steps !== undefined) p.steps = Math.round(steps);
    out.set(day, p);
  }
  return out;
}

/** /wellness-service/wellness/daily/spo2/{date} — one day. */
async function fetchSpo2(day: string): Promise<Partial<GarminDayPoint> | null> {
  const data = await garminGet(`/wellness-service/wellness/daily/spo2/${day}`);
  if (!data) return null;
  const avg = deepPickNum(data, [
    'averageSpO2',
    'avgSpO2',
    'avgSleepSpO2',
    'averageSpo2Value',
  ]);
  const low = deepPickNum(data, ['lowestSpO2', 'minSpO2', 'lowestSpo2Value']);
  const out: Partial<GarminDayPoint> = {};
  if (avg !== undefined) out.spo2AvgPct = avg;
  if (low !== undefined) out.spo2MinPct = low;
  return Object.keys(out).length ? out : null;
}

/**
 * /usersummary-service/usersummary/daily/{user}?calendarDate — the daily
 * summary card: resting HR, steps, HR min/max and stress. The
 * userstats-service range endpoint returns nothing on this account.
 */
async function fetchDailySummary(
  displayName: string,
  day: string,
): Promise<Partial<GarminDayPoint> | null> {
  const data = await garminGet(
    `/usersummary-service/usersummary/daily/${encodeURIComponent(displayName)}?calendarDate=${day}`,
  );
  if (!data) return null;
  const out: Partial<GarminDayPoint> = {};
  const rhr = deepPickNum(data, ['restingHeartRate', 'restingBpm']);
  if (rhr !== undefined) out.restingBpm = Math.round(rhr);
  const steps = deepPickNum(data, ['totalSteps', 'steps']);
  if (steps !== undefined) out.steps = Math.round(steps);
  const hrMax = deepPickNum(data, ['maxHeartRate']);
  if (hrMax !== undefined) out.hrMaxBpm = Math.round(hrMax);
  const hrMin = deepPickNum(data, ['minHeartRate']);
  if (hrMin !== undefined) out.hrMinBpm = Math.round(hrMin);
  return Object.keys(out).length ? out : null;
}

/** /wellness-service/wellness/daily/respiration/{date} — one day. */
async function fetchRespiration(
  day: string,
): Promise<Partial<GarminDayPoint> | null> {
  const data = await garminGet(
    `/wellness-service/wellness/daily/respiration/${day}`,
  );
  if (!data) return null;
  const sleepAvg = deepPickNum(data, [
    'avgSleepRespirationValue',
    'averageSleepRespirationValue',
    'avgSleepRespiration',
  ]);
  const avg = deepPickNum(data, [
    'avgWakingRespirationValue',
    'averageRespirationValue',
    'avgRespirationRate',
  ]);
  const v = sleepAvg ?? avg;
  return v !== undefined
    ? { respirationPerMin: Math.round(v * 10) / 10 }
    : null;
}

/**
 * /wellness-service/wellness/dailySleepData/{user}?date — the detailed
 * sleep record: stages + overnight vitals bundled in one payload.
 * Garmin files the night under the wake day, matching our convention.
 */
async function fetchSleepDetail(
  displayName: string,
  day: string,
): Promise<Partial<GarminDayPoint> | null> {
  const data = (await garminGet(
    `/wellness-service/wellness/dailySleepData/${encodeURIComponent(displayName)}?date=${day}&nonSleepBufferMinutes=60`,
  )) as Record<string, unknown> | null;
  if (!data) return null;

  const dto = (data.dailySleepDTO ?? data) as Record<string, unknown>;
  // GMT variant is a real epoch; the Local one is wall-clock-as-UTC and
  // would shift the shown times by the timezone offset.
  const startLocal = dto.sleepStartTimestampGMT ?? dto.sleepStartTimestampLocal;
  const endLocal = dto.sleepEndTimestampGMT ?? dto.sleepEndTimestampLocal;
  const deep = pickNum(dto, ['deepSleepSeconds']);
  const light = pickNum(dto, ['lightSleepSeconds']);
  const rem = pickNum(dto, ['remSleepSeconds']);
  const awake = pickNum(dto, ['awakeSleepSeconds', 'awakeDurationSeconds']);

  const out: Partial<GarminDayPoint> = {};
  if (
    typeof startLocal === 'number' &&
    typeof endLocal === 'number' &&
    endLocal > startLocal
  ) {
    out.sleep = {
      startedAt: startLocal,
      endedAt: endLocal,
      stagesMs: {
        deep: (deep ?? 0) * 1000,
        light: (light ?? 0) * 1000,
        rem: (rem ?? 0) * 1000,
        awake: (awake ?? 0) * 1000,
      },
    };
  }
  const hrv = deepPickNum(dto, ['avgOvernightHrv', 'averageHrv', 'avgHrv']);
  if (hrv !== undefined) out.hrvRmssdMs = Math.round(hrv);
  const rhr = deepPickNum(dto, ['restingHeartRate', 'sleepRestingHeartRate']);
  if (rhr !== undefined) out.restingBpm = Math.round(rhr);
  const spo2 = deepPickNum(dto, ['averageSpO2Value', 'avgSpO2', 'averageSpO2']);
  if (spo2 !== undefined) out.spo2AvgPct = spo2;
  const spo2Lo = deepPickNum(dto, ['lowestSpO2Value', 'lowestSpO2']);
  if (spo2Lo !== undefined) out.spo2MinPct = spo2Lo;
  const resp = deepPickNum(dto, [
    'averageRespirationValue',
    'avgSleepRespirationValue',
  ]);
  if (resp !== undefined) out.respirationPerMin = Math.round(resp * 10) / 10;
  return Object.keys(out).length ? out : null;
}

/**
 * One round of Garmin API reads covering `days` days back. The two
 * range endpoints carry most of the weight; per-day vitals calls are
 * capped at the last week to keep latency sane (the trend uses HRV
 * anyway). Returns null when no account is linked.
 */
export async function fetchGarminApiDays(
  days: number,
): Promise<Map<string, Partial<GarminDayPoint>> | null> {
  const t = await loadGarminTokens();
  if (!t) return null;

  const end = localDay(daysAgo(0));
  const start = localDay(daysAgo(days - 1));
  const merged = new Map<string, Partial<GarminDayPoint>>();
  const merge = (day: string | undefined, p: Partial<GarminDayPoint>) => {
    if (!day || Object.keys(p).length === 0) return;
    merged.set(day, { ...merged.get(day), ...p });
  };

  try {
    for (const s of await fetchHrvRange(start, end)) {
      merge(s.day, { hrvRmssdMs: s.avg });
    }
  } catch (e) {
    if (e instanceof GarminAuthError) throw e;
  }
  try {
    for (const [d, p] of await fetchDailyStats(t.displayName, start, end)) {
      merge(d, p);
    }
  } catch (e) {
    if (e instanceof GarminAuthError) throw e;
  }

  // Per-day vitals — enough history for the visible trend without issuing
  // hundreds of private-API calls.
  const perDay = Math.min(days, 14);
  for (let i = 0; i < perDay; i++) {
    const d = localDay(daysAgo(i));
    try {
      merge(d, (await fetchSpo2(d)) ?? {});
      merge(d, (await fetchRespiration(d)) ?? {});
      merge(d, (await fetchDailySummary(t.displayName, d)) ?? {});
    } catch (e) {
      if (e instanceof GarminAuthError) throw e;
    }
  }
  // Rich sleep detail — two weeks, matching the visible trend window.
  for (let i = 0; i < Math.min(days, 14); i++) {
    const d = localDay(daysAgo(i));
    try {
      merge(d, (await fetchSleepDetail(t.displayName, d)) ?? {});
    } catch (e) {
      if (e instanceof GarminAuthError) throw e;
    }
  }
  return merged;
}

export interface GarminApiDiagnostics {
  /** Days the HRV range endpoint returned. */
  hrvDays: number;
  hrvError?: string;
  /** Days the userstats range endpoint returned (resting HR / steps). */
  dailyStatsDays: number;
  dailyStatsError?: string;
  /** Per-day results, newest first. */
  days: {
    day: string;
    spo2: boolean;
    respiration: boolean;
    sleepDetail: boolean;
    dailySummary: boolean;
    errors: string[];
    point?: Partial<GarminDayPoint>;
  }[];
}

const errText = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

/**
 * Diagnostics variant of fetchGarminApiDays: reports which endpoint
 * produced data per day and which threw, so API gaps can be told apart
 * from parser gaps. Only used by the Diagnostics screen.
 */
export async function fetchGarminApiDiagnostics(
  days: number,
): Promise<GarminApiDiagnostics | null> {
  const t = await loadGarminTokens();
  if (!t) return null;

  const out: GarminApiDiagnostics = {
    hrvDays: 0,
    dailyStatsDays: 0,
    days: [],
  };
  const end = localDay(daysAgo(0));
  const start = localDay(daysAgo(days - 1));

  const byDay = new Map<string, Partial<GarminDayPoint>>();
  const merge = (day: string, p: Partial<GarminDayPoint>) => {
    byDay.set(day, { ...byDay.get(day), ...p });
  };

  try {
    const hrv = await fetchHrvRange(start, end);
    out.hrvDays = hrv.length;
    for (const s of hrv) merge(s.day, { hrvRmssdMs: s.avg });
  } catch (e) {
    out.hrvError = errText(e);
    if (e instanceof GarminAuthError) throw e;
  }
  try {
    const stats = await fetchDailyStats(t.displayName, start, end);
    out.dailyStatsDays = stats.size;
    for (const [d, p] of stats) merge(d, p);
  } catch (e) {
    out.dailyStatsError = errText(e);
    if (e instanceof GarminAuthError) throw e;
  }

  const perDay = Math.min(days, 14);
  for (let i = 0; i < perDay; i++) {
    const d = localDay(daysAgo(i));
    const row: GarminApiDiagnostics['days'][number] = {
      day: d,
      spo2: false,
      respiration: false,
      sleepDetail: false,
      dailySummary: false,
      errors: [],
    };
    try {
      const p = await fetchSpo2(d);
      row.spo2 = p !== null;
      if (p) merge(d, p);
    } catch (e) {
      row.errors.push(`spo2: ${errText(e)}`);
      if (e instanceof GarminAuthError) throw e;
    }
    try {
      const p = await fetchRespiration(d);
      row.respiration = p !== null;
      if (p) merge(d, p);
    } catch (e) {
      row.errors.push(`resp: ${errText(e)}`);
      if (e instanceof GarminAuthError) throw e;
    }
    try {
      const p = await fetchDailySummary(t.displayName, d);
      row.dailySummary = p !== null;
      if (p) merge(d, p);
    } catch (e) {
      row.errors.push(`summary: ${errText(e)}`);
      if (e instanceof GarminAuthError) throw e;
    }
    try {
      const p = await fetchSleepDetail(t.displayName, d);
      row.sleepDetail = p !== null;
      if (p) merge(d, p);
    } catch (e) {
      row.errors.push(`sleep: ${errText(e)}`);
      if (e instanceof GarminAuthError) throw e;
    }
    out.days.push(row);
  }

  for (const row of out.days) {
    row.point = byDay.get(row.day);
  }
  return out;
}
