import { PermissionsAndroid, Platform } from 'react-native';
import {
  BleManager,
  Device,
  type Subscription,
} from 'react-native-ble-plx';

import { parseHeartRateMeasurement } from '@/domain/heartRateParser';
import type { HRReading } from '@/domain/models';

import type {
  IHeartRateSensor,
  ScannedSensor,
  SensorConnectionState,
} from './types';

/** Bluetooth SIG Heart Rate Service. */
export const HR_SERVICE_UUID = '0000180d-0000-1000-8000-00805f9b34fb';
/** Heart Rate Measurement characteristic (notify). */
export const HR_MEASUREMENT_UUID = '00002a37-0000-1000-8000-00805f9b34fb';

/**
 * Runtime BLE permissions. Android 12+ (API 31) split Bluetooth into
 * SCAN/CONNECT runtime permissions; older versions need location.
 */
export async function requestBlePermissions(): Promise<boolean> {
  if (Platform.OS !== 'android') return true;

  const apiLevel =
    typeof Platform.Version === 'number'
      ? Platform.Version
      : parseInt(String(Platform.Version), 10);

  if (apiLevel >= 31) {
    const result = await PermissionsAndroid.requestMultiple([
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
      PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
    ]);
    return Object.values(result).every(
      (v) => v === PermissionsAndroid.RESULTS.GRANTED,
    );
  }

  const result = await PermissionsAndroid.request(
    PermissionsAndroid.PERMISSIONS.ACCESS_FINE_LOCATION,
  );
  return result === PermissionsAndroid.RESULTS.GRANTED;
}

/**
 * Scans for devices advertising the Heart Rate Service — this covers Garmin
 * broadcast mode and every standard BLE chest strap.
 * Returns a stop function; the scan auto-stops after `timeoutMs`.
 */
export function scanForHeartRateSensors(
  manager: BleManager,
  onDevice: (sensor: ScannedSensor) => void,
  timeoutMs = 10_000,
): () => void {
  const seen = new Set<string>();
  const subscription = manager.onStateChange((state) => {
    if (state === 'PoweredOn') {
      manager.startDeviceScan([HR_SERVICE_UUID], null, (error, device) => {
        if (error || !device || seen.has(device.id)) return;
        seen.add(device.id);
        onDevice({
          id: device.id,
          name: device.name ?? device.localName ?? 'Sensor sin nombre',
        });
      });
      subscription?.remove();
    }
  }, true);

  const timer = setTimeout(() => manager.stopDeviceScan(), timeoutMs);
  return () => {
    clearTimeout(timer);
    subscription.remove();
    manager.stopDeviceScan();
  };
}

/**
 * Standard BLE Heart Rate sensor: connects to the GATT service 0x180D and
 * subscribes to notifications on 0x2A37. Works with Garmin wrist broadcast
 * and chest straps alike — the protocol is identical.
 */
export class BleHeartRateSensor implements IHeartRateSensor {
  readonly label: string;
  private listeners = new Set<(r: HRReading) => void>();
  private stateListeners = new Set<(s: SensorConnectionState) => void>();
  private monitorSub: Subscription | null = null;
  private disconnectSub: Subscription | null = null;

  constructor(
    private readonly manager: BleManager,
    private readonly device: Device,
  ) {
    this.label = device.name ?? device.localName ?? device.id;
  }

  async start(): Promise<void> {
    this.setState('connecting');

    const connected = await this.device.connect();
    await connected.discoverAllServicesAndCharacteristics();

    this.disconnectSub = connected.onDisconnected(() => {
      this.monitorSub?.remove();
      this.monitorSub = null;
      this.setState('disconnected');
    });

    this.monitorSub = connected.monitorCharacteristicForService(
      HR_SERVICE_UUID,
      HR_MEASUREMENT_UUID,
      (error, characteristic) => {
        if (error || !characteristic?.value) return;
        try {
          const reading = parseHeartRateMeasurement(characteristic.value);
          this.emit(reading);
        } catch {
          // Malformed packet — drop it, keep streaming.
        }
      },
    );

    this.setState('streaming');
  }

  async stop(): Promise<void> {
    this.monitorSub?.remove();
    this.disconnectSub?.remove();
    this.monitorSub = null;
    this.disconnectSub = null;
    await this.device.cancelConnection().catch(() => {});
    this.setState('idle');
  }

  subscribe(listener: (reading: HRReading) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onStateChange(
    listener: (state: SensorConnectionState) => void,
  ): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  private emit(reading: HRReading): void {
    for (const l of this.listeners) l(reading);
  }

  private setState(state: SensorConnectionState): void {
    for (const l of this.stateListeners) l(state);
  }
}
