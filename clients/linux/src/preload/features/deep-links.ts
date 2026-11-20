import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import {
  createDeepLinksBridge,
  createLaunchAtLoginBridge,
} from "@mycadet/electron-desktop/preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("deepLinks", createDeepLinksBridge(ipcRenderer));
  registry.contribute("launchAtLogin", createLaunchAtLoginBridge(ipcRenderer));
};
