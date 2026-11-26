import { ipcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";
import { createPermissionSetupBridge } from "@mycadet/electron-desktop/preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

/**
 * The macOS permission-setup guide (screen recording, accessibility, the
 * drag window). Its handlers exist only in the macOS main process, so the
 * `permissions.setup` seam extends the shared permissions feature here
 * alone.
 */
export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
): void => {
  registry.extend("permissions", {
    setup: createPermissionSetupBridge(ipcRenderer),
  });
};
