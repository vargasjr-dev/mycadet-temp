import type { IpcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";

import { BridgeCapabilityRegistry } from "../capability-registry";
import { install as installAuth } from "./features/auth";
import { install as installAutoUpdate } from "./features/auto-update";
import { install as installVellumMigration } from "./features/vellum-migration";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installBundles } from "./features/bundles";
import { install as installCommands } from "./features/commands";
import { install as installDeepLinks } from "./features/deep-links";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installDownloads } from "./features/downloads";
import { install as installNotificationsShare } from "./features/notifications-share";
import { install as installPaths } from "./features/paths";
import { install as installPermissions } from "./features/permissions";
import { install as installPresence } from "./features/presence";

/** A preload feature's contribution to the composed bridge. */
export type PreloadFeatureInstall = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
  ipc: IpcRenderer,
) => void;

/** The OS-independent features every desktop client's preload carries, in
 * the registry's sorted order — the list the old auto-discovery hid. */
const SHARED_PRELOAD_FEATURES: Array<
  (registry: BridgeCapabilityRegistry<CadetBridge>, ipc: IpcRenderer) => void
> = [
  installAuth,
  installAutoUpdate,
  installVellumMigration,
  installAuxiliaryWindows,
  installBundles,
  installCommands,
  installDeepLinks,
  installDiagnostics,
  installDownloads,
  installNotificationsShare,
  installPaths,
  installPermissions,
  installPresence,
];

/**
 * The shared desktop preload: the OS core bridge plus every shared feature,
 * with a slot for the client's OS-specific additions (dictation differs per
 * platform today). macOS still composes its monolith — this is the
 * consolidation seam it moves onto next.
 */
export const composeDesktopPreload = (
  ipc: IpcRenderer,
  core: Partial<CadetBridge>,
  extraFeatures: PreloadFeatureInstall[] = [],
): Partial<CadetBridge> => {
  const registry = new BridgeCapabilityRegistry<CadetBridge>(core);
  for (const install of SHARED_PRELOAD_FEATURES) install(registry, ipc);
  for (const install of extraFeatures) install(registry, ipc);
  return registry.build();
};
