import { BleManager } from 'react-native-ble-plx';

let manager: BleManager | null = null;

/** Lazily-created shared BleManager — creating one per scan leaks native resources. */
export function getBleManager(): BleManager {
  manager ??= new BleManager();
  return manager;
}
