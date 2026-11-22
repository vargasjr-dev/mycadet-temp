/**
 * @mycadet/electron-desktop - the desktop clients' shared package.
 *
 * The root index is the package's public surface: exactly the bindings
 * the desktop clients (and the CLI) consume, each exported from its
 * defining module. Modules not listed here are implementation detail —
 * reachable only within the package — which keeps the surface auditable
 * and the preload bundles lean.
 */

export { default as log } from "./app-logger";
export { startApp } from "./app-lifecycle";
export {
  current as currentMainWindow,
  onMainWindowVisibilityChange,
} from "./main-window";
export {
  CLI_RUNTIME_ENTRIES,
  readRuntimeManifest,
} from "./win32-cli/cli-installer";
export {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "./win32-cli/cli-launcher";
export { hasPendingDeepLinks } from "./deep-links";
export { hasPendingFiles } from "./file-open";
export { onAvatarChange } from "./avatar";
export {
  applyAlphaMask,
  compositeCentered,
  roundedRectCoverage,
} from "./image-mask";
