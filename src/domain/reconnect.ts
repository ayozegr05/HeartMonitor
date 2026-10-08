/**
 * Reconnection backoff for dropped BLE links.
 *
 * A watch/strap disconnecting overnight is expected (out of range, watch
 * reboot, radio hiccup). The first retry is fast — most drops recover in
 * seconds — and the backoff stretches so an absent sensor doesn't drain
 * the battery with constant scan/connect churn.
 */

export const RECONNECT_BASE_DELAY_MS = 5_000;
export const RECONNECT_MAX_DELAY_MS = 120_000;

/**
 * Delay before attempt `attempt` (0-indexed) of a reconnection loop:
 * 5s → 10s → 20s → 40s → 80s → 120s → 120s → …
 */
export function reconnectDelayMs(attempt: number): number {
  const delay = RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, Math.floor(attempt));
  return Math.min(delay, RECONNECT_MAX_DELAY_MS);
}
