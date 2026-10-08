import {
  reconnectDelayMs,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
} from '../reconnect';

describe('reconnectDelayMs', () => {
  it('doubles the delay on each attempt', () => {
    expect(reconnectDelayMs(0)).toBe(5_000);
    expect(reconnectDelayMs(1)).toBe(10_000);
    expect(reconnectDelayMs(2)).toBe(20_000);
    expect(reconnectDelayMs(3)).toBe(40_000);
    expect(reconnectDelayMs(4)).toBe(80_000);
  });

  it('caps the delay at the maximum', () => {
    expect(reconnectDelayMs(5)).toBe(RECONNECT_MAX_DELAY_MS);
    expect(reconnectDelayMs(20)).toBe(RECONNECT_MAX_DELAY_MS);
  });

  it('never goes below the base delay', () => {
    expect(reconnectDelayMs(-3)).toBe(RECONNECT_BASE_DELAY_MS);
  });
});
