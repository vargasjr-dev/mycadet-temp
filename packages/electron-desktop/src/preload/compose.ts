import type { CadetBridge } from "@mycadet/ipc-contract";

import { BridgeCapabilityRegistry } from "../capability-registry";
import { install as installAuth } from "./features/auth";
import { install as installAutoUpdate } from "./features/auto-update";
import { install as installVellumMigration } from "./features/vellum-migration";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installBundles } from "./features/bundles";
import { install as installHotkeys } from "./features/hotkeys";
import { install as installHelper } from "./features/helper";
import { install as installDeepLinks } from "./features/deep-links";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installDownloads } from "./features/downloads";
import { install as installNotificationsShare } from "./features/notifications-share";
import { install as installPaths } from "./features/paths";
import { install as installPermissions } from "./features/permissions";
import { install as installPresence } from "./features/presence";

/** A preload feature's contribution to the composed bridge. Features pull
 * the renderer's `ipcRenderer` from the electron module themselves — the
 * composer injects nothing. */
export type PreloadFeatureInstall = (
  registry: BridgeCapabilityRegistry<CadetBridge>,
) => void;

/** The OS-independent features every desktop client's preload carries, in
 * the registry's sorted order — the list the old auto-discovery hid. */
const SHARED_PRELOAD_FEATURES: PreloadFeatureInstall[] = [
  installAuth,
  installAutoUpdate,
  installVellumMigration,
  installAuxiliaryWindows,
  installBundles,
  installHelper,
  installHotkeys,
  installDeepLinks,
  installDiagnostics,
  installDownloads,
  installNotificationsShare,
  installPaths,
  installPermissions,
  installPresence,
];

/**
 * The shared desktop preload: the client's OS core bridge plus every shared
 * feature, with a slot for the client's OS-specific additions. A platform
 * feature may extend a surface the shared set opened (macOS adds its hotkey
 * flavor and the permission-setup guide to surfaces the shared features
 * contribute) — the registry merges those one level deep.
 */
export const composeDesktopPreload = (
  core: Partial<CadetBridge>,
  extraFeatures: PreloadFeatureInstall[] = [],
): Partial<CadetBridge> => {
  const registry = new BridgeCapabilityRegistry<CadetBridge>(core);
  for (const install of SHARED_PRELOAD_FEATURES) install(registry);
  for (const install of extraFeatures) install(registry);
  return registry.build();
};
