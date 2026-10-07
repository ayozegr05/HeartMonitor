import type { ThresholdProfile } from './models';

/** Default sleep window: 23:00 → 07:00 (wraps midnight). */
export const SLEEP_START_HOUR = 23;
export const SLEEP_END_HOUR = 7;

/**
 * Returns true when `date` falls inside the sleep window.
 * The window wraps midnight: [23:00, 07:00) means 23:59 → true, 12:00 → false.
 */
export function isNightTime(
  date: Date,
  sleepStartHour = SLEEP_START_HOUR,
  sleepEndHour = SLEEP_END_HOUR,
): boolean {
  const hour = date.getHours();
  if (sleepStartHour === sleepEndHour) return false;
  if (sleepStartHour < sleepEndHour) {
    return hour >= sleepStartHour && hour < sleepEndHour;
  }
  return hour >= sleepStartHour || hour < sleepEndHour;
}

/** Picks the bradycardia floor that applies at `date`. */
export function activeLowThreshold(profile: ThresholdProfile, date: Date): number {
  return isNightTime(date) ? profile.nightLowBpm : profile.dayLowBpm;
}
