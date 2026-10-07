import { isElectron } from "@/runtime/is-electron";

/**
 * Sync the diagnostics consent state to the Electron main process.
 * No-op on web and native mobile. The main-process mirror only exists in the
 * Electron shell.
 */
export function syncDiagnosticsToMain(enabled: boolean): void {
  if (!isElectron()) {
    return;
  }
  window.cadet?.diagnostics?.setShareDiagnostics(enabled);
}
