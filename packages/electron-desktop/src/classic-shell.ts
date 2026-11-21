import { install as installAuth } from "./features/auth";
import { install as installAuxiliaryWindows } from "./features/auxiliary-windows";
import { install as installBundles } from "./features/bundles";
import { install as installCommands } from "./features/commands";
import { install as installDiagnostics } from "./features/diagnostics";
import { install as installDictation } from "./features/dictation";
import { install as installHostProxy } from "./features/host-proxy";
import { installMainWindow } from "./main-window";
import { installNotifications } from "./notifications";
import { install as installLoginItem } from "./features/login-item";
import { install as installPermissions } from "./features/permissions";
import { install as installTray } from "./features/tray";
import { install as installShare } from "./features/share";
import { install as installVoiceModeChord } from "./features/voice-mode-chord";
import { install as installWindowAttention } from "./features/window-attention";

/**
 * The classic-desktop shells' (Linux, Windows) composition surface: the
 * feature installs they ran identically, as one ordered list here instead
 * of two copies in the shells' indexes. The order is the glob-sorted order
 * the old auto-discovery hid, kept exact: features read each other's
 * registrations at install time (the host-proxy bridge defers one
 * microtask so the presence module's initial read lands first).
 *
 * The wiring that is identical across all three desktops — the protocol
 * stack, the presence/identity slice, launch capture, the notification
 * runtime — never appears here: `startApp` owns it. What remains is what
 * is genuinely classic-desktop-only.
 */
export const installClassicShellFeatures = (): void => {
  installAuth();
  installAuxiliaryWindows();
  installBundles();
  installCommands();
  installLoginItem();
  installDiagnostics();
  installDictation();
  installHostProxy();
  installMainWindow();
  installNotifications();
  installPermissions();
  installTray();
  installShare();
  installVoiceModeChord();
  installWindowAttention();
};
