import { ipcRenderer, webUtils } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import { createFileOpenPreloadBridge } from "@mycadet/electron-desktop/file-open-preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  const bridge = createFileOpenPreloadBridge({ ipcRenderer, webUtils });
  registry.contribute("fileOpen", bridge.fileOpen);
  registry.contribute("paths", bridge.paths);
};
