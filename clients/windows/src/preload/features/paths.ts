import { ipcRenderer, webUtils } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createFileOpenPreloadBridge } from "@mycadet/electron-desktop/file-open-preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

const module: CapabilityModule<BridgeCapabilityRegistry<CadetBridge>> = {
  id: "paths",
  install: (registry) => {
    const bridge = createFileOpenPreloadBridge({ ipcRenderer, webUtils });
    registry.contribute("fileOpen", bridge.fileOpen);
    registry.contribute("paths", bridge.paths);
  },
};

export default module;
