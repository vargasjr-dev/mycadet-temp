import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createUpdateBridge } from "@mycadet/electron-desktop/preload";
import type { VellumBridge } from "@mycadet/ipc-contract";

const autoUpdateFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "auto-update",
  install: (registry) => {
    registry.contribute("update", createUpdateBridge(ipcRenderer));
  },
};

export default autoUpdateFeature;
