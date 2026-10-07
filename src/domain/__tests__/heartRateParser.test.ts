import { parseHeartRateMeasurement } from '../heartRateParser';

const toBase64 = (bytes: number[]) => btoa(String.fromCharCode(...bytes));

describe('parseHeartRateMeasurement (BLE 0x2A37)', () => {
  it('parses a UINT8 heart rate without RR intervals', () => {
    // flags=0x00 → uint8 bpm, no extras
    const reading = parseHeartRateMeasurement(toBase64([0x00, 64]));
    expect(reading.bpm).toBe(64);
    expect(reading.rrIntervalsMs).toEqual([]);
  });

  it('parses a UINT16 heart rate', () => {
    // flags bit0=1 → uint16 LE bpm (300 = 0x012C)
    const reading = parseHeartRateMeasurement(toBase64([0x01, 0x2c, 0x01]));
    expect(reading.bpm).toBe(300);
  });

  it('parses RR intervals in 1/1024 s units', () => {
    // flags bit4=1 → RR present; RR=1024 units → 1000 ms, RR=2048 → 2000 ms
    const reading = parseHeartRateMeasurement(
      toBase64([0x10, 60, 0x00, 0x04, 0x00, 0x08]),
    );
    expect(reading.bpm).toBe(60);
    expect(reading.rrIntervalsMs[0]).toBeCloseTo(1000);
    expect(reading.rrIntervalsMs[1]).toBeCloseTo(2000);
  });

  it('skips the energy-expended field when present', () => {
    // flags: uint8 bpm + energy expended + RR
    const reading = parseHeartRateMeasurement(
      toBase64([0x18, 55, 0x10, 0x00, 0x00, 0x04]),
    );
    expect(reading.bpm).toBe(55);
    expect(reading.rrIntervalsMs[0]).toBeCloseTo(1000);
  });

  it('throws on malformed payloads', () => {
    expect(() => parseHeartRateMeasurement(toBase64([0x00]))).toThrow();
  });
});
