import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createUpdateBridge } from "@mycadet/electron-desktop/preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

const autoUpdateFeature: CapabilityModule<
  BridgeCapabilityRegistry<CadetBridge>
> = {
  id: "auto-update",
  install: (registry) => {
    registry.contribute("update", createUpdateBridge(ipcRenderer));
  },
};

export default autoUpdateFeature;
