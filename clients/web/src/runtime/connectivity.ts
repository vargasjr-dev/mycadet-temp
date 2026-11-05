import { isElectron } from "@/runtime/is-electron";
import { type ConnectivityState } from "@mycadet/ipc-contract";

/**
 * Subscribe to connectivity state changes from the Electron host.
 * No-op off Electron — returns an unsubscribe-noop.
 */
export function subscribeToConnectivity(
  callback: (state: ConnectivityState) => void,
): () => void {
  if (!isElectron()) {
    return () => undefined;
  }
  return window.cadet?.connectivity?.onState(callback) ?? (() => undefined);
}

/**
 * Report browser online/offline to the Electron host so main can fuse it
 * with backend health probes. No-op off Electron.
 */
export function reportDeviceOnline(online: boolean): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.connectivity?.setDevice(online);
}
