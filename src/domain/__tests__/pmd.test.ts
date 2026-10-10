import {
  buildGetSettingsCommand,
  buildStartEcgCommand,
  buildStopCommand,
  CONTROL_OP,
  CONTROL_STATUS,
  DELTA_FRAME_BIT,
  ECG_RESOLUTION_BITS,
  ECG_SAMPLE_BYTES,
  ECG_SAMPLE_RATE_HZ,
  FRAME_TYPE,
  MEASUREMENT_TYPE,
  parseControlResponse,
  parsePmdData,
  SETTING_TYPE,
} from '@/sensors/polar/pmd';

/** Build a 10-byte PMD data header. */
function header(measurementType: number, frameTypeByte: number, tsNs = 0): number[] {
  const h = new Array(10).fill(0);
  h[0] = measurementType;
  for (let i = 0; i < 8; i++) h[1 + i] = (tsNs >> (8 * i)) & 0xff;
  h[9] = frameTypeByte;
  return h;
}

/** Serialize a signed value to `n` LE bytes. */
function le(value: number, n: number): number[] {
  if (value < 0) value += 1 << (n * 8);
  const out: number[] = [];
  for (let i = 0; i < n; i++) out.push((value >> (8 * i)) & 0xff);
  return out;
}

/** Pack signed deltas of `bitSize` bits LSB-first. */
function packDeltas(deltas: number[], bitSize: number): number[] {
  const mask = (1 << bitSize) - 1;
  const bytes: number[] = [];
  let bitPos = 0;
  for (let d of deltas) {
    if (d < 0) d += 1 << bitSize;
    let remaining = bitSize;
    let v = d & mask;
    while (remaining > 0) {
      const byteIdx = bitPos >> 3;
      const shift = bitPos & 7;
      const room = 8 - shift;
      const take = Math.min(room, remaining);
      const piece = (v & ((1 << take) - 1)) << shift;
      while (bytes.length <= byteIdx) bytes.push(0);
      bytes[byteIdx] |= piece;
      v >>= take;
      bitPos += take;
      remaining -= take;
    }
  }
  return bytes;
}

/**
 * Build one compressed delta frame — real layout per the PMD spec:
 * ref_sample | delta_size (1B) | sample_count (1B) | packed deltas.
 */
function deltaFrame(
  ref: number,
  deltas: number[],
  bitSize: number,
  refBytes: number,
): number[] {
  return [
    ...le(ref, refBytes),
    bitSize,
    deltas.length,
    ...packDeltas(deltas, bitSize),
  ];
}

describe('PMD control commands', () => {
  it('builds the ECG start command byte-identical to the official example', () => {
    // Polar spec example: 02 00 00 01 82 00 01 01 0e 00
    const cmd = Array.from(buildStartEcgCommand());
    expect(cmd).toEqual([
      CONTROL_OP.START_MEASUREMENT,
      MEASUREMENT_TYPE.ECG,
      SETTING_TYPE.SAMPLE_RATE, 1, ECG_SAMPLE_RATE_HZ, 0,
      SETTING_TYPE.RESOLUTION, 1, ECG_RESOLUTION_BITS, 0,
    ]);
  });

  it('builds stop and get-settings commands', () => {
    expect(Array.from(buildStopCommand(MEASUREMENT_TYPE.ECG))).toEqual([
      CONTROL_OP.STOP_MEASUREMENT,
      MEASUREMENT_TYPE.ECG,
    ]);
    expect(
      Array.from(buildGetSettingsCommand(MEASUREMENT_TYPE.ECG)),
    ).toEqual([CONTROL_OP.GET_MEASUREMENT_SETTINGS, MEASUREMENT_TYPE.ECG]);
  });

  it('parses control responses ([0xF0][op][type][status][params])', () => {
    const r = parseControlResponse(
      Uint8Array.from([
        0xf0,
        CONTROL_OP.START_MEASUREMENT,
        MEASUREMENT_TYPE.ECG,
        CONTROL_STATUS.SUCCESS,
        0, // 'more' flag
        9,
        9,
      ]),
    );
    expect(r.opCode).toBe(CONTROL_OP.START_MEASUREMENT);
    expect(r.measurementType).toBe(MEASUREMENT_TYPE.ECG);
    expect(r.status).toBe(CONTROL_STATUS.SUCCESS);
    expect(Array.from(r.params)).toEqual([9, 9]);
  });

  it('reads a real error status — not fooled by measurement type 0', () => {
    // A rejection for ECG carries measurement_type=0x00 at byte 2;
    // the status lives at byte 3.
    const r = parseControlResponse(
      Uint8Array.from([
        0xf0,
        CONTROL_OP.START_MEASUREMENT,
        MEASUREMENT_TYPE.ECG,
        CONTROL_STATUS.INVALID_MTU,
      ]),
    );
    expect(r.status).toBe(CONTROL_STATUS.INVALID_MTU);
  });

  it('rejects non-control bytes', () => {
    expect(() => parseControlResponse(Uint8Array.from([1, 2, 3]))).toThrow();
  });
});

describe('PMD data parsing', () => {
  it('reads the header fields of a raw ECG frame (3-byte samples)', () => {
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ECG, FRAME_TYPE.RAW),
      ...le(100, ECG_SAMPLE_BYTES),
      ...le(-50, ECG_SAMPLE_BYTES),
    ]);
    const f = parsePmdData(bytes);
    expect(f.measurementType).toBe(MEASUREMENT_TYPE.ECG);
    expect(f.frameType).toBe(FRAME_TYPE.RAW);
    expect(f.samples).toEqual([100, -50]);
  });

  it('decodes one delta frame: ref + cumulative deltas', () => {
    // ref=1000, deltas=[10,-5,20] → samples [1000,1010,1005,1025]
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ACC, DELTA_FRAME_BIT | 0),
      ...deltaFrame(1000, [10, -5, 20], 8, 2),
    ]);
    const f = parsePmdData(bytes, 2);
    expect(f.samples).toEqual([1000, 1010, 1005, 1025]);
  });

  it('decodes chained delta frames', () => {
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ACC, DELTA_FRAME_BIT | 0),
      ...deltaFrame(0, [5, 5], 4, 2),
      ...deltaFrame(50, [-10], 8, 2),
    ]);
    const f = parsePmdData(bytes, 2);
    expect(f.samples).toEqual([0, 5, 10, 50, 40]);
  });

  it('handles negative reference samples', () => {
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ACC, DELTA_FRAME_BIT | 0),
      ...deltaFrame(-300, [7], 4, 2),
    ]);
    const f = parsePmdData(bytes, 2);
    expect(f.samples).toEqual([-300, -293]);
  });

  it('handles deltas wider than a byte and bit-straddling', () => {
    // 10-bit deltas crossing byte boundaries.
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ACC, DELTA_FRAME_BIT | 0),
      ...deltaFrame(0, [400, -512, 1], 10, 2),
    ]);
    const f = parsePmdData(bytes, 2);
    expect(f.samples).toEqual([0, 400, -112, -111]);
  });

  it('throws on truncated headers', () => {
    expect(() => parsePmdData(Uint8Array.from([1, 2]))).toThrow();
  });

  it('ignores a trailing partial delta frame', () => {
    const bytes = Uint8Array.from([
      ...header(MEASUREMENT_TYPE.ACC, DELTA_FRAME_BIT | 0),
      ...deltaFrame(0, [5], 4, 2),
      1, 2, // garbage tail
    ]);
    const f = parsePmdData(bytes, 2);
    expect(f.samples).toEqual([0, 5]);
  });
});
