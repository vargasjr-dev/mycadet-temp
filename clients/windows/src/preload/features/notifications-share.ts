import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createNotificationsBridge } from "@mycadet/electron-desktop/preload";

// Renderer bridge for native notifications and file sharing, mirroring the
// macOS preload surface channel-for-channel so the renderer's runtime
// wrappers work unchanged.
const notificationsShare: CapabilityModule<
  BridgeCapabilityRegistry<CadetBridge>
> = {
  id: "notifications-share",
  install: (bridge) => {
    bridge.contribute("notifications", createNotificationsBridge(ipcRenderer));
    bridge.contribute("share", {
      shareFile: (bytes: Uint8Array, filename: string) =>
        ipcRenderer.invoke(
          "cadet:share:file",
          bytes,
          filename,
        ) as Promise<void>,
    });
  },
};

export default notificationsShare;
