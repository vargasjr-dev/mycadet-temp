import { contextBridge } from "electron";

import { composeDesktopPreload } from "@mycadet/electron-desktop/preload";

// The preload is one shared composition in the electron-desktop package;
// this shell just exposes it. `bridge-parity.test.ts` holds the composed
// bridge to the full contract.
contextBridge.exposeInMainWorld("cadet", composeDesktopPreload());
