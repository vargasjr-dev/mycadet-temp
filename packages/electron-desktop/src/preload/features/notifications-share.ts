import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import { createNotificationsBridge } from "../factories";

// Renderer bridge for native notifications and file sharing, mirroring the
// macOS preload surface channel-for-channel so the renderer's runtime
// wrappers work unchanged.
export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.notifications = createNotificationsBridge();
  bridge.share = {
    shareFile: (bytes: Uint8Array, filename: string): Promise<void> =>
      Promise.resolve(ipcRenderer.invoke("cadet:share:file", bytes, filename)),
  };
};
