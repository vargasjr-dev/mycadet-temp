import { type IpcRenderer, webUtils } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createFileOpenPreloadBridge } from "../../file-open-preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  const bridge = createFileOpenPreloadBridge({ ipcRenderer: ipc, webUtils });
  registry.contribute("fileOpen", bridge.fileOpen);
  registry.contribute("paths", bridge.paths);
};
