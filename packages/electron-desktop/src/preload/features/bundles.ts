import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createBundleConfirmBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("bundleConfirm", createBundleConfirmBridge(ipcRenderer));
};
