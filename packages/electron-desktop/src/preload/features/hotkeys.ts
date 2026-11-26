import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createHotkeysBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

// Global hotkeys. The `menu` surface lives with the clients whose main
// process serves it (Linux and Windows) — macOS registers no menu IPC.
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.contribute("hotkeys", createHotkeysBridge(ipcRenderer));
};
