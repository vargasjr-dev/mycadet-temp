import { useEffect } from "react";

import type { AssistantRequestState } from "../assistant/use-assistant-request";
import {
  deriveAssistantStatus,
  setAssistantStatus,
} from "../runtime/assistant-status";

// Relative imports (not `@app/*`) so this module tree stays free of app path
// aliases for any out-of-tree consumer; the hook itself is app-internal.

/**
 * Publish the assistant's connection status to the Electron host so the main
 * process can drive the menu-bar (Tray) status dot. Main de-dupes republished
 * values, so publishing on every resolution change is cheap.
 *
 * The app shell resolves the assistant itself, so the dot reads that
 * resolution — no status is gathered from the web assistant iframe, which
 * only mounts once the assistant is fully loaded and carries no status
 * notion at all. Mounted in `AssistantShell`, where the resolution state is
 * in scope. `setAssistantStatus` no-ops off Electron, so mounting is safe
 * unconditionally.
 *
 * The cleanup publishes `disconnected` on unmount: the shell leaves the tree
 * when the router swaps to a chooser route or the active assistant changes,
 * and the tray must not stick at the previous assistant's `idle`.
 *
 * This module family is the intermediate home for the renderer-side electron
 * glue; per the desktop-layer direction it eventually folds into the electron
 * main process, which will derive the dot from its own vantage.
 */
export function useElectronStatusSync(state: AssistantRequestState): void {
  useEffect(() => {
    setAssistantStatus(deriveAssistantStatus(state));
  }, [state]);

  useEffect(() => () => setAssistantStatus("disconnected"), []);
}
