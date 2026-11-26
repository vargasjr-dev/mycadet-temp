import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createDeepLinksBridge, createLaunchAtLoginBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("deepLinks", createDeepLinksBridge(ipcRenderer));
  registry.contribute("launchAtLogin", createLaunchAtLoginBridge(ipcRenderer));
};
