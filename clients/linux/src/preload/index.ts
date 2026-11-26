import { contextBridge, ipcRenderer } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { createLinuxCoreBridge } from "./core-capabilities";
import { install as installAuth } from "./features/auth";
import { install as installAutoUpdate } from "./features/auto-update";
import { install as installVellumMigration } from "./features/vellum-migration";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installBundles } from "./features/bundles";
import { install as installCommands } from "./features/commands";
import { install as installDeepLinks } from "./features/deep-links";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installDictation } from "./features/dictation";
import { install as installDownloads } from "./features/downloads";
import { install as installNotificationsShare } from "./features/notifications-share";
import { install as installPaths } from "./features/paths";
import { install as installPermissions } from "./features/permissions";
import { install as installPresence } from "./features/presence";
import { BridgeCapabilityRegistry } from "@mycadet/electron-desktop/capability-registry";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The always-present core plus every `./features/` module;
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
const bridge = (() => {
  // Every preload feature contributes explicitly, in the glob's
  // sorted order — the list the old auto-discovery hid.
  const registry = new BridgeCapabilityRegistry<CadetBridge>(
    createLinuxCoreBridge(ipcRenderer),
  );
  installAuth(registry);
  installAutoUpdate(registry);
  installVellumMigration(registry);
  installAuxiliaryWindows(registry);
  installBundles(registry);
  installCommands(registry);
  installDeepLinks(registry);
  installDiagnostics(registry);
  installDictation(registry);
  installDownloads(registry);
  installNotificationsShare(registry);
  installPaths(registry);
  installPermissions(registry);
  installPresence(registry);
  return registry.build();
})();
contextBridge.exposeInMainWorld("cadet", bridge);
