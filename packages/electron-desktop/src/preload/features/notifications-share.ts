import { ipcRenderer } from "electron";

import type { CadetBridge } from "@mycadet/ipc-contract";

// Renderer bridge for file sharing, mirroring the macOS preload surface
// channel-for-channel so the renderer's runtime wrappers work unchanged.
export const shareBridge: CadetBridge["share"] = {
  shareFile: (bytes: Uint8Array, filename: string): Promise<void> =>
    ipcRenderer.invoke("cadet:share:file", bytes, filename),
};
