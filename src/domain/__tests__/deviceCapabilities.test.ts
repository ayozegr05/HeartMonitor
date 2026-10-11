import {
  describeCapabilities,
  deviceCapabilities,
  inferDeviceKind,
  resolveDeviceKind,
} from '../deviceCapabilities';

describe('inferDeviceKind', () => {
  it('recognises the Polar H10 as an ECG strap', () => {
    expect(inferDeviceKind('Polar H10 2B3A4F')).toBe('ecg-strap');
    expect(inferDeviceKind('H10 Heart Rate')).toBe('ecg-strap');
  });

  it('recognises other straps/optical sensors as RR-only', () => {
    expect(inferDeviceKind('Polar OH1')).toBe('strap');
    expect(inferDeviceKind('Polar Verity Sense')).toBe('strap');
    expect(inferDeviceKind('Wahoo TICKR')).toBe('strap');
    expect(inferDeviceKind('Garmin HRM-Dual')).toBe('strap');
    expect(inferDeviceKind('Coospo H6')).toBe('strap');
  });

  it('treats watches and unknown devices as FC-only', () => {
    expect(inferDeviceKind('Instinct 3')).toBe('watch');
    expect(inferDeviceKind('Garmin Fenix 7')).toBe('watch');
    expect(inferDeviceKind('Mi Smart Band 7')).toBe('watch');
    expect(inferDeviceKind('Unknown BLE Device')).toBe('watch');
    expect(inferDeviceKind('')).toBe('watch');
    expect(inferDeviceKind(null)).toBe('watch');
  });
});

describe('resolveDeviceKind', () => {
  it('returns null when no device is chosen', () => {
    expect(resolveDeviceKind('auto', null)).toBeNull();
    expect(resolveDeviceKind('strap', undefined)).toBeNull();
    expect(resolveDeviceKind('watch', '')).toBeNull();
  });

  it('honours auto detection', () => {
    expect(resolveDeviceKind('auto', 'Polar H10 X')).toBe('ecg-strap');
    expect(resolveDeviceKind('auto', 'Polar OH1')).toBe('strap');
    expect(resolveDeviceKind('auto', 'Instinct 3')).toBe('watch');
  });

  it('lets the user force FC-only (watch)', () => {
    expect(resolveDeviceKind('watch', 'Polar H10 X')).toBe('watch');
    expect(resolveDeviceKind('watch', 'Instinct 3')).toBe('watch');
  });

  it('lets the user force strap for unrecognised names', () => {
    // A strap our regex misses can be upgraded manually.
    expect(resolveDeviceKind('strap', 'FooBand 3000')).toBe('strap');
    // But ECG stays tied to real H10-class hardware.
    expect(resolveDeviceKind('strap', 'Polar H10 X')).toBe('ecg-strap');
  });
});

describe('deviceCapabilities', () => {
  it('ECG strap delivers everything', () => {
    expect(deviceCapabilities('ecg-strap')).toEqual({
      heartRate: true,
      rrIntervals: true,
      ecg: true,
    });
  });

  it('plain strap delivers RR but no ECG', () => {
    expect(deviceCapabilities('strap')).toEqual({
      heartRate: true,
      rrIntervals: true,
      ecg: false,
    });
  });

  it('watch delivers heart rate only', () => {
    expect(deviceCapabilities('watch')).toEqual({
      heartRate: true,
      rrIntervals: false,
      ecg: false,
    });
  });

  it('no device delivers nothing', () => {
    expect(deviceCapabilities(null).heartRate).toBe(false);
  });
});

describe('describeCapabilities', () => {
  it('summarises each kind for the UI', () => {
    expect(describeCapabilities('ecg-strap')).toContain('ECG');
    expect(describeCapabilities('watch')).toContain('Solo FC');
    expect(describeCapabilities(null)).toBe('');
  });
});
