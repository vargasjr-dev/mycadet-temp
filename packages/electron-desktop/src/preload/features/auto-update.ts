import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createUpdateBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("update", createUpdateBridge(ipcRenderer));
};
