/**
 * The classic-desktop shells' (Linux, Windows) composition surface.
 *
 * A deep entry rather than the root index on purpose: the root graph is
 * every shell's graph (the macOS bundle resolves it), and this one pulls
 * the whole classic feature list plus the Windows CLI launcher family —
 * dead weight for the mac. The two classic shells and their packaging
 * scripts import everything here; the mac keeps its own explicit list.
 */
export { installClassicShellFeatures } from "../features/install-all";
export { ensureVisible } from "../main-window";
export { writeCliLocator } from "../cli-installer";
export { provisionCliForWrapper } from "../cli-path-installer";
export {
  provisionCliForCurrentUser,
  resolveCliPathFlowOptions,
} from "../win32-cli/cli-path-flow";
export {
  CLI_RUNTIME_ENTRIES,
  readRuntimeManifest,
} from "../win32-cli/cli-installer";
export {
  resolveCliLauncherPaths,
  uninstallCliLauncher,
} from "../win32-cli/cli-launcher";
