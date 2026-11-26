import type { IpcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";
import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createDownloadsBridge } from "../../preload";

// Renderer bridge for download outcome reports and the file-manager reveal,
// the same shared factory the macOS preload uses.
export const install = (
  bridge: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  bridge.contribute("downloads", createDownloadsBridge(ipc));
};
