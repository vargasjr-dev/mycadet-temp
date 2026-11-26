import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createNotificationsBridge } from "../factories";

// Renderer bridge for native notifications and file sharing, mirroring the
// macOS preload surface channel-for-channel so the renderer's runtime
// wrappers work unchanged.
export const install = (
  bridge: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  bridge.contribute("notifications", createNotificationsBridge(ipcRenderer));
  bridge.contribute("share", {
    shareFile: (bytes: Uint8Array, filename: string): Promise<void> =>
      Promise.resolve(ipcRenderer.invoke("cadet:share:file", bytes, filename)),
  });
};
