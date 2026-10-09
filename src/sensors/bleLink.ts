import type { Device } from 'react-native-ble-plx';

/**
 * Shared BLE-link lease. The heart-rate session and the on-demand ECG
 * stream are two consumers of the same physical connection to the
 * strap/watch — each acquires the link when it starts and releases it
 * when it stops. The link is only cancelled when the last consumer
 * releases, so stopping one side never kills the other.
 */
let consumers = 0;

export function acquireBleLink(): void {
  consumers += 1;
}

export function isBleLinkLeased(): boolean {
  return consumers > 0;
}

/** Release one consumer; the last release drops the physical link. */
export async function releaseBleLink(device: Device | null): Promise<void> {
  consumers = Math.max(0, consumers - 1);
  if (consumers === 0 && device) {
    await device.cancelConnection().catch(() => {});
  }
}
