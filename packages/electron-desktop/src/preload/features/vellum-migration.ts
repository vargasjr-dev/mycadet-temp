import type { IpcRenderer } from "electron";

import type { BridgeCapabilityRegistry } from "../../capability-registry";
import { createVellumMigrationBridge } from "../../preload";
import type { CadetBridge } from "@mycadet/ipc-contract";

export const install = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
): void => {
  registry.contribute("vellumMigration", createVellumMigrationBridge(ipc));
};
