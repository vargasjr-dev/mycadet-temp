import type { CadetBridge } from "@mycadet/ipc-contract";

import { install as installAuth } from "./preload/features/auth";
import { install as installAutoUpdate } from "./preload/features/auto-update";
import { install as installVellumMigration } from "./preload/features/vellum-migration";
import { install as installAuxiliaryWindows } from "./preload/features/auxiliary-windows";
import { install as installBundles } from "./preload/features/bundles";
import { install as installCompanion } from "./preload/features/companion";
import { install as installHelper } from "./preload/features/helper";
import { install as installHotkeys } from "./preload/features/hotkeys";
import { install as installMenu } from "./preload/features/menu";
import { install as installDeepLinks } from "./preload/features/deep-links";
import { install as installDiagnostics } from "./preload/features/diagnostics";
import { install as installDownloads } from "./preload/features/downloads";
import { install as installNotificationsShare } from "./preload/features/notifications-share";
import { install as installPaths } from "./preload/features/paths";
import { install as installPermissions } from "./preload/features/permissions";
import { install as installPresence } from "./preload/features/presence";

/** A preload feature's contribution to the composed bridge. Features pull
 * the renderer's `ipcRenderer` from the electron module themselves — the
 * composer injects nothing. */
export type PreloadFeatureInstall = (bridge: Partial<CadetBridge>) => void;

/** The features every desktop client's preload carries. Each one owns its
 * bridge key outright and assigns it — two features claiming one key would
 * silently overwrite, which the parity tests hold against the contract. */
const SHARED_PRELOAD_FEATURES: PreloadFeatureInstall[] = [
  installAuth,
  installAutoUpdate,
  installVellumMigration,
  installAuxiliaryWindows,
  installBundles,
  installCompanion,
  installHelper,
  installHotkeys,
  installMenu,
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
 * feature may finish a surface the shared set opened (macOS adds its hotkey
 * flavor and the permission-setup guide to the helper and permissions
 * surfaces the shared features contribute).
 */
export const composeDesktopPreload = (
  core: Partial<CadetBridge>,
  extraFeatures: PreloadFeatureInstall[] = [],
): Partial<CadetBridge> => {
  const bridge: Partial<CadetBridge> = { ...core };
  for (const install of SHARED_PRELOAD_FEATURES) install(bridge);
  for (const install of extraFeatures) install(bridge);
  return bridge;
};

declare global {
  // The bridge every desktop preload exposes — declared once here, where
  // the composition lives, instead of per client.
  interface Window {
    cadet: CadetBridge;
  }
}
