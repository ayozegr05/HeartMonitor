import type { HRReading } from './models';

/**
 * Parser for the BLE Heart Rate Measurement characteristic (UUID 0x2A37),
 * as defined by the Bluetooth SIG Heart Rate Service (0x180D).
 *
 * Byte layout:
 *   [0]    flags — bit0: HR format (0 = UINT8, 1 = UINT16)
 *                  bit3: energy-expended field present (UINT16)
 *                  bit4: RR-interval values present
 *   [1..]  heart rate (UINT8 or UINT16 LE)
 *   ...    optional energy expended (UINT16 LE)
 *   ...    RR intervals, each UINT16 LE in units of 1/1024 s
 *
 * Sensors emit this as a base64 string via react-native-ble-plx.
 */
export function parseHeartRateMeasurement(base64: string): HRReading {
  const bytes = base64ToBytes(base64);
  if (bytes.length < 2) {
    throw new Error('Heart Rate Measurement too short');
  }

  const flags = bytes[0];
  const isUint16 = (flags & 0b1) !== 0;
  const hasEnergyExpended = (flags & 0b1000) !== 0;
  const hasRrIntervals = (flags & 0b10000) !== 0;

  let offset = 1;
  let bpm: number;
  if (isUint16) {
    bpm = bytes[offset] | (bytes[offset + 1] << 8);
    offset += 2;
  } else {
    bpm = bytes[offset];
    offset += 1;
  }

  if (hasEnergyExpended) offset += 2;

  const rrIntervalsMs: number[] = [];
  if (hasRrIntervals) {
    while (offset + 1 < bytes.length) {
      const raw = bytes[offset] | (bytes[offset + 1] << 8);
      rrIntervalsMs.push((raw * 1000) / 1024);
      offset += 2;
    }
  }

  return { bpm, rrIntervalsMs, timestamp: Date.now() };
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
