import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import {
  createDeepLinksBridge,
  createLaunchAtLoginBridge,
} from "@mycadet/electron-desktop/preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

const deepLinksFeature: CapabilityModule<
  BridgeCapabilityRegistry<CadetBridge>
> = {
  id: "deep-links",
  install: (registry) => {
    registry.contribute("deepLinks", createDeepLinksBridge(ipcRenderer));
    registry.contribute(
      "launchAtLogin",
      createLaunchAtLoginBridge(ipcRenderer),
    );
  },
};

export default deepLinksFeature;
