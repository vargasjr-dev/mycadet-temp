import { ipcRenderer } from "electron";

import type {
  BridgeCapabilityRegistry,
  CapabilityModule,
} from "@mycadet/electron-desktop/capability-registry";
import { createBundleConfirmBridge } from "@mycadet/electron-desktop/preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

const bundlesFeature: CapabilityModule<BridgeCapabilityRegistry<CadetBridge>> =
  {
    id: "bundles",
    install: (registry) => {
      registry.contribute(
        "bundleConfirm",
        createBundleConfirmBridge(ipcRenderer),
      );
    },
  };

export default bundlesFeature;
