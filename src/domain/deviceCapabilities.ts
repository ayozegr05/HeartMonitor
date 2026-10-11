/**
 * What each paired BLE device can actually deliver.
 *
 * BLE HR devices are NOT interchangeable:
 *  - Polar H10 (and PMD-capable straps): bpm + RR intervals + raw ECG.
 *  - Other chest straps / optical arm sensors (OH1, Wahoo, Coospo,
 *    Garmin HRM-*): bpm + RR intervals, no ECG.
 *  - Watches / wristbands (Garmin Instinct, Apple Watch, mi band…):
 *    bpm only — RR is kept for ANT+ or not broadcast over BLE at all.
 *
 * The profile is usually 'auto' (kind inferred from the advertised
 * name); a manual override exists for straps whose name we don't
 * recognise and would otherwise be mistaken for a watch.
 */

export type DeviceProfile = 'auto' | 'strap' | 'watch';

export type DeviceKind = 'ecg-strap' | 'strap' | 'watch' | null;

export interface DeviceCapabilities {
  heartRate: boolean;
  /** RR intervals — powers pause detection and HRV. */
  rrIntervals: boolean;
  /** Raw ECG stream — Polar PMD straps only. */
  ecg: boolean;
}

export const DEVICE_PROFILE_LABELS: Record<DeviceProfile, string> = {
  auto: 'Auto',
  strap: 'Banda',
  watch: 'Reloj',
};

export const DEVICE_KIND_LABELS: Record<
  Exclude<DeviceKind, null>,
  string
> = {
  'ecg-strap': 'Banda con ECG',
  strap: 'Banda / sensor RR',
  watch: 'Reloj / pulsera',
};

/** Infers the device class from its advertised BLE name. */
export function inferDeviceKind(
  label: string | null | undefined,
): Exclude<DeviceKind, null> {
  const name = label ?? '';
  // Only PMD-capable Polar straps stream raw ECG (H10 family).
  if (/h10/i.test(name)) return 'ecg-strap';
  // Other straps and optical HR sensors send RR but not ECG.
  if (/polar|wahoo|coospo|magene|hrm|geonaute|chest|strap/i.test(name)) {
    return 'strap';
  }
  return 'watch';
}

/**
 * Effective kind for a chosen device.
 *  - 'auto'   → use the advertised name.
 *  - 'watch'  → force FC-only.
 *  - 'strap'  → force RR on; ECG stays gated on H10-class hardware
 *               (declaring a watch "strap" can't conjure a PMD stream).
 */
export function resolveDeviceKind(
  profile: DeviceProfile,
  deviceLabel: string | null | undefined,
): DeviceKind {
  if (!deviceLabel) return null;
  const inferred = inferDeviceKind(deviceLabel);
  if (profile === 'auto') return inferred;
  if (profile === 'watch') return 'watch';
  return inferred === 'ecg-strap' ? 'ecg-strap' : 'strap';
}

export function deviceCapabilities(kind: DeviceKind): DeviceCapabilities {
  const strap = kind === 'strap' || kind === 'ecg-strap';
  return {
    heartRate: kind !== null,
    rrIntervals: strap,
    ecg: kind === 'ecg-strap',
  };
}

/** One-line capabilities summary for the connectivity card. */
export function describeCapabilities(kind: DeviceKind): string {
  switch (kind) {
    case 'ecg-strap':
      return 'FC · pausas/VFC · ECG';
    case 'strap':
      return 'FC · pausas/VFC — sin ECG';
    case 'watch':
      return 'Solo FC — pausas, VFC y ECG no llegan por BLE';
    default:
      return '';
  }
}
