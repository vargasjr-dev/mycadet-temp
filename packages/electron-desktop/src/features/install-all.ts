import { install as installAuth } from "./auth";
import { install as installAuxiliaryWindows } from "./auxiliary-windows";
import { install as installBundles } from "./bundles";
import { install as installCommands } from "./commands";
import { install as installDeepLinks } from "./deep-links";
import { install as installDiagnostics } from "./diagnostics";
import { install as installDictation } from "./dictation";
import { install as installFileOpen } from "./file-open";
import { install as installHostProxy } from "./host-proxy";
import { installMainWindow } from "../main-window";
import { install as installNotifications } from "./notifications";
import { install as installPermissions } from "./permissions";
import { install as installPresence } from "./presence";
import { install as installShare } from "./share";
import { install as installVoiceModeChord } from "./voice-mode-chord";
import { install as installWindowAttention } from "./window-attention";

/**
 * The feature installs the classic-desktop shells (Linux, Windows) ran
 * identically — one ordered list here instead of two copies in the shells'
 * indexes. The order is the glob-sorted order the old auto-discovery hid,
 * kept exact: features read each other's registrations at install time
 * (the host-proxy bridge defers one microtask so the presence module's
 * initial read lands first).
 */
export const installClassicShellFeatures = (): void => {
  installAuth();
  installAuxiliaryWindows();
  installBundles();
  installCommands();
  installDeepLinks();
  installDiagnostics();
  installDictation();
  installFileOpen();
  installHostProxy();
  installMainWindow();
  installNotifications();
  installPermissions();
  installPresence();
  installShare();
  installVoiceModeChord();
  installWindowAttention();
};
