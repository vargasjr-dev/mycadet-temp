import { contextBridge, ipcRenderer } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

import { composeDesktopPreload } from "@mycadet/electron-desktop/preload/compose";
import { createLinuxCoreBridge } from "./core-capabilities";
import { install as installDictation } from "./features/dictation";

export type { AppVersionInfo, CadetBridge, CadetCommand };

// The shared feature set (electron-desktop/preload/compose) plus this
// client's core and its OS-specific dictation feature;
// `bridge-parity.test.ts` holds the composed bridge to the full contract.
const bridge = composeDesktopPreload(ipcRenderer, createLinuxCoreBridge(ipcRenderer), [
  installDictation,
]);
contextBridge.exposeInMainWorld("cadet", bridge);
