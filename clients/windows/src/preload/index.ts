import { contextBridge } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { composeDesktopPreload } from "@mycadet/electron-desktop/preload";
import { createWindowsCoreBridge } from "./core-capabilities";
import { install as installHotkeyChords } from "./features/hotkey-chords";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The client's core bridge, the shared feature set, and this platform's
// hotkey chord surface; `bridge-parity.test.ts` holds the composed bridge
// to the full contract.
const bridge = composeDesktopPreload(createWindowsCoreBridge(), [
  installHotkeyChords,
]);
contextBridge.exposeInMainWorld("cadet", bridge);
