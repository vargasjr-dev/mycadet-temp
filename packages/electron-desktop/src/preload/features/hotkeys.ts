import { createHotkeysBridge } from "../factories";
import type { CadetBridge } from "@mycadet/ipc-contract";

// Global hotkeys, shared with the menu surface across all three desktops.
export const install = (bridge: Partial<CadetBridge>): void => {
  bridge.hotkeys = createHotkeysBridge();
};
