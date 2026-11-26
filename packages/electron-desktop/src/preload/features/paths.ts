import { ipcRenderer, webUtils } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createFileOpenPreloadBridge } from "../../file-open-preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  const bridge = createFileOpenPreloadBridge({
    ipcRenderer: ipcRenderer,
    webUtils,
  });
  registry.contribute("fileOpen", bridge.fileOpen);
  registry.contribute("paths", bridge.paths);
};
