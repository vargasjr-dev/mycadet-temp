import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createLocalModeBridge } from "@mycadet/electron-desktop/local-mode-bridge";
import type { VellumBridge } from "@mycadet/ipc-contract";

const localModeFeature: CapabilityModule<
  BridgeCapabilityRegistry<VellumBridge>
> = {
  id: "local-mode",
  install: (registry) => {
    registry.contribute("localMode", createLocalModeBridge(ipcRenderer));
  },
};

export default localModeFeature;
