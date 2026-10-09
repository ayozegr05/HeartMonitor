/**
 * Polar Measurement Data (PMD) protocol — pure TypeScript.
 *
 * The H10 exposes a second BLE service beyond the standard Heart Rate
 * Service: the PMD service, which streams raw sensor data (ECG, ACC,
 * gyro, PPI) with no Polar account, cloud or SDK involved.
 *
 *   Service:       FB005C80-02E7-F387-1CAD-8ACD2D8DF0C8
 *   Control point: FB005C81-… (write commands, get notifications back)
 *   Data:          FB005C82-… (measurement notifications)
 *
 * This module encodes control-point commands and decodes data frames.
 * Transport lives in `PolarEcgSource`; this file stays pure and unit-
 * tested so protocol drift shows up as a failing test, not a crash.
 *
 * Spec reference: Polar "Polar BLE SDK" documentation —
 * https://github.com/polarofficial/polar-ble-sdk (PMD spec).
 */

const PREFIX = 'fb005c8';
const SUFFIX = '-02e7-f387-1cad-8acd2d8df0c8';

export const PMD_SERVICE_UUID = `${PREFIX}0${SUFFIX}`;
export const PMD_CONTROL_POINT_UUID = `${PREFIX}1${SUFFIX}`;
export const PMD_DATA_UUID = `${PREFIX}2${SUFFIX}`;

/** PMD measurement types (first byte of commands and data frames). */
export const MEASUREMENT_TYPE = {
  ECG: 0x00,
  PPG: 0x01,
  ACC: 0x02,
  PPI: 0x03,
  GYRO: 0x05,
  MAGNETOMETER: 0x06,
} as const;
export type MeasurementType =
  (typeof MEASUREMENT_TYPE)[keyof typeof MEASUREMENT_TYPE];

/** PMD setting types used inside start/get-settings commands. */
export const SETTING_TYPE = {
  SAMPLE_RATE: 0x00,
  RESOLUTION: 0x01,
  RANGE: 0x02,
  RANGE_MILLISEC: 0x03,
  CHANNELS: 0x04,
} as const;

/** Control point opcodes. */
export const CONTROL_OP = {
  GET_MEASUREMENT_SETTINGS: 0x01,
  START_MEASUREMENT: 0x02,
  STOP_MEASUREMENT: 0x03,
  GET_SDK_MODE: 0x09,
} as const;

/** Response marker byte on control-point notifications. */
export const CONTROL_RESPONSE = 0xf0;

/**
 * Control-point response layout (verified against the official
 * polar-ble-sdk `PmdControlPointResponse`):
 *   [0] 0xF0 marker
 *   [1] op code echoed
 *   [2] measurement type
 *   [3] status code
 *   [4] 'more' flag (only when status == SUCCESS)
 *   [5..] parameters (only when more)
 */

export const CONTROL_STATUS = {
  SUCCESS: 0x00,
  INVALID_OP_CODE: 0x01,
  INVALID_MEASUREMENT_TYPE: 0x02,
  NOT_SUPPORTED: 0x03,
  INVALID_LENGTH: 0x04,
  INVALID_PARAMETER: 0x05,
  ALREADY_IN_STATE: 0x06,
  INVALID_RESOLUTION: 0x07,
  INVALID_SAMPLE_RATE: 0x08,
  INVALID_RANGE: 0x09,
  INVALID_MTU: 0x0a,
  INVALID_NUMBER_OF_CHANNELS: 0x0b,
  INVALID_STATE: 0x0c,
  DEVICE_IN_CHARGER: 0x0d,
  DISK_FULL: 0x0e,
} as const;

/** The H10 ECG only streams at 130 Hz / 14-bit resolution. */
export const ECG_SAMPLE_RATE_HZ = 130;
export const ECG_RESOLUTION_BITS = 14;

/** Raw ECG samples are 3 bytes signed little-endian (µV). */
export const ECG_SAMPLE_BYTES = 3;

/**
 * PMD data frame type field (byte 9 of the data header):
 * bit 7 set → delta-compressed frame (ACC/PPG/…; never ECG — the
 * official SDK rejects compressed ECG frames outright), the low 7
 * bits hold the frame type.
 */
export const DELTA_FRAME_BIT = 0x80;
export const FRAME_TYPE_MASK = 0x7f;
export const FRAME_TYPE = {
  /** Raw frame, type 0 — what the H10 sends for ECG. */
  RAW: 0x00,
  /** Delta-compressed frame marker (frame byte = type | 0x80). */
  COMPRESSED: 0x80,
} as const;

/** Header layout of a PMD data notification. */
const HEADER_SIZE = 10;

export interface PmdDataFrame {
  measurementType: number;
  /** Device timestamp, nanoseconds (uint64 truncated to Number). */
  timestampNs: number;
  frameType: number;
  /** Decoded samples in the sensor's native unit (µV for ECG). */
  samples: number[];
}

export interface PmdControlResponse {
  opCode: number;
  measurementType: number;
  status: number;
  /** Raw bytes after the 'more' flag byte (e.g. echoed settings). */
  params: Uint8Array;
}

/** uint64 LE → Number; safe up to 2^53, plenty for ns timestamps. */
function readUint64Le(bytes: Uint8Array, offset: number): number {
  let hi = 0;
  let lo = 0;
  for (let i = 0; i < 4; i++) lo |= bytes[offset + i] << (8 * i);
  for (let i = 0; i < 4; i++) hi |= bytes[offset + 4 + i] << (8 * i);
  return hi * 0x1_0000_0000 + (lo >>> 0);
}

/**
 * Signed little-endian value of `length` bytes at `offset`
 * (length ≤ 4).
 */
function readSignedLe(
  bytes: Uint8Array,
  offset: number,
  length: number,
): number {
  let value = 0;
  for (let i = 0; i < length; i++) {
    value |= bytes[offset + i] << (8 * i);
  }
  const signBit = 1 << (length * 8 - 1);
  if (value & signBit) value -= 1 << (length * 8);
  return value;
}

/**
 * Field size per setting type (from the SDK's `typeToFieldSize`):
 * SAMPLE_RATE 2, RESOLUTION 2, RANGE 2, CHANNELS 1 — sending a
 * CHANNELS uint16 leaves a stray byte the firmware reads as another
 * setting → ERROR_INVALID_LENGTH.
 */
const SETTING_FIELD_SIZE: Record<number, number> = {
  [SETTING_TYPE.SAMPLE_RATE]: 2,
  [SETTING_TYPE.RESOLUTION]: 2,
  [SETTING_TYPE.RANGE]: 2,
  [SETTING_TYPE.CHANNELS]: 1,
};

function pushSetting(out: number[], type: number, value: number): void {
  const fieldSize = SETTING_FIELD_SIZE[type] ?? 2;
  // [setting_type][count=1][value LE, fieldSize bytes]
  out.push(type, 1);
  for (let i = 0; i < fieldSize; i++) out.push((value >> (8 * i)) & 0xff);
}

/**
 * Command to start the ECG stream (130 Hz, 14-bit). Matches the
 * official example `02 00 00 01 82 00 01 01 0e 00` — ECG takes no
 * CHANNELS setting (single lead, fixed).
 */
export function buildStartEcgCommand(): Uint8Array {
  const out: number[] = [
    CONTROL_OP.START_MEASUREMENT,
    MEASUREMENT_TYPE.ECG,
  ];
  pushSetting(out, SETTING_TYPE.SAMPLE_RATE, ECG_SAMPLE_RATE_HZ);
  pushSetting(out, SETTING_TYPE.RESOLUTION, ECG_RESOLUTION_BITS);
  return Uint8Array.from(out);
}

export function buildStopCommand(type: MeasurementType): Uint8Array {
  return Uint8Array.from([CONTROL_OP.STOP_MEASUREMENT, type]);
}

export function buildGetSettingsCommand(
  type: MeasurementType,
): Uint8Array {
  return Uint8Array.from([CONTROL_OP.GET_MEASUREMENT_SETTINGS, type]);
}

/**
 * Parse a control-point notification into a typed response.
 * Layout: [0xF0][op][measurement_type][status][more?][params...]
 */
export function parseControlResponse(bytes: Uint8Array): PmdControlResponse {
  if (bytes.length < 4 || bytes[0] !== CONTROL_RESPONSE) {
    throw new Error('Not a PMD control response');
  }
  return {
    opCode: bytes[1],
    measurementType: bytes[2],
    status: bytes[3],
    params: bytes.length > 5 ? bytes.slice(5) : new Uint8Array(0),
  };
}

/**
 * Unpack `count` signed little-endian bit-fields of `bitSize` bits from
 * `bytes` starting at `offset`. Delta samples are packed LSB-first.
 */
function unpackDeltas(
  bytes: Uint8Array,
  offset: number,
  bitSize: number,
  count: number,
): number[] {
  const out: number[] = [];
  let bitPos = offset * 8;
  const signBit = 1 << (bitSize - 1);
  const mask = (1 << bitSize) - 1;
  for (let i = 0; i < count; i++) {
    const bytePos = bitPos >> 3;
    const shift = bitPos & 7;
    // Read up to 4 bytes and shift — bitSize ≤ 32 and fields
    // never straddle more than 5 bytes.
    let raw = 0;
    for (let b = 0; b < 5 && bytePos + b < bytes.length; b++) {
      raw |= bytes[bytePos + b] << (8 * b);
    }
    raw = (raw >>> shift) & mask;
    if (raw & signBit) raw -= 1 << bitSize;
    out.push(raw);
    bitPos += bitSize;
  }
  return out;
}

/**
 * Decode a PMD data notification.
 *
 * Layout: 10-byte header
 *   [0]   measurement type
 *   [1-8] timestamp ns (uint64 LE)
 *   [9]   frame type (0 = delta-compressed, 1 = raw)
 *
 * Compressed payload (delta frames, used by ACC/PPG/… — never ECG):
 *   ref_sample:   `refBytes` signed LE
 *   delta_size:   1 byte  (bits per delta)
 *   sample_count: 1 byte  (number of deltas that follow)
 *   deltas:       ceil(delta_size * count / 8) bytes, packed
 *
 * Each decoded sample = ref_sample + cumulative sum of deltas.
 * (No per-frame timestamp — the header timestamp covers it.)
 */
export function parsePmdData(
  bytes: Uint8Array,
  refBytes: number = ECG_SAMPLE_BYTES,
): PmdDataFrame {
  if (bytes.length < HEADER_SIZE) {
    throw new Error('PMD data frame too short');
  }
  const measurementType = bytes[0];
  const timestampNs = readUint64Le(bytes, 1);
  const frameTypeByte = bytes[9];
  const compressed = (frameTypeByte & DELTA_FRAME_BIT) !== 0;
  const frameType = frameTypeByte & FRAME_TYPE_MASK;
  const payload = bytes.subarray(HEADER_SIZE);

  if (!compressed) {
    // Raw frame: N signed LE samples of `refBytes` each.
    const samples: number[] = [];
    for (let i = 0; i + refBytes <= payload.length; i += refBytes) {
      samples.push(readSignedLe(payload, i, refBytes));
    }
    return { measurementType, timestampNs, frameType, samples };
  }

  const samples: number[] = [];
  let pos = 0;
  while (pos < payload.length) {
    const minFrame = refBytes + 1 + 1;
    if (pos + minFrame > payload.length) break;
    const ref = readSignedLe(payload, pos, refBytes);
    pos += refBytes;
    const deltaSize = payload[pos];
    const count = payload[pos + 1];
    pos += 2;
    const deltas = unpackDeltas(payload, pos, deltaSize, count);
    pos += Math.ceil((deltaSize * count) / 8);

    let acc = ref;
    samples.push(acc);
    for (const d of deltas) {
      acc += d;
      samples.push(acc);
    }
  }
  return { measurementType, timestampNs, frameType, samples };
}
