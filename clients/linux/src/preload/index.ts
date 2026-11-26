import { contextBridge } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { composeDesktopPreload } from "@mycadet/electron-desktop/preload";
import { createLinuxCoreBridge } from "./core-capabilities";
import { install as installHotkeyChords } from "./features/hotkey-chords";
import { install as installMenu } from "./features/menu";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The client's core bridge, the shared feature set, and this platform's
// hotkey chord and menu surfaces; `bridge-parity.test.ts` holds the
// composed bridge to the full contract.
const bridge = composeDesktopPreload(createLinuxCoreBridge(), [
  installHotkeyChords,
  installMenu,
]);
contextBridge.exposeInMainWorld("cadet", bridge);
