import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import { createDownloadsBridge } from "@mycadet/electron-desktop/preload";

// Renderer bridge for download outcome reports and the file-manager reveal,
// the same shared factory the macOS preload uses.
export const install = (
  bridge: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  bridge.contribute("downloads", createDownloadsBridge(ipcRenderer));
};
