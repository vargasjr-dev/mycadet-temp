import type { IpcRenderer, IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
} from "@mycadet/ipc-contract";

export const LINUX_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
] as const satisfies readonly (keyof CadetBridge)[];

export type LinuxCoreBridge = Pick<
  CadetBridge,
  (typeof LINUX_CORE_CAPABILITIES)[number]
>;

/**
 * macOS-only companion surfaces with no Linux counterpart. The renderer
 * feature-detects them and falls back to web behavior.
 */
export const LINUX_NOT_APPLICABLE_CAPABILITIES = [
  "companion",
  "voiceActivity",
] as const satisfies readonly (keyof CadetBridge)[];

/** The always-present core every `./features/` module builds on. */
export const createLinuxCoreBridge = (
  ipcRenderer: Pick<IpcRenderer, "invoke" | "on" | "off">,
): LinuxCoreBridge => ({
  platform: "electron",
  hostOS: "linux",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("cadet:app:versionInfo") as Promise<AppVersionInfo>,
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("cadet:app:openWebsite") as Promise<void>,
  },
  commands: {
    on: (callback) => {
      const handler = (_event: IpcRendererEvent, command: CadetCommand) => {
        callback(command);
      };
      ipcRenderer.on("cadet:command", handler);
      return () => {
        ipcRenderer.off("cadet:command", handler);
      };
    },
  },
  mainWindow: {
    ensureVisible: (): Promise<void> =>
      ipcRenderer.invoke("cadet:mainWindow:ensureVisible") as Promise<void>,
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke(
        "cadet:mainWindow:setOnboarding",
        active,
      ) as Promise<void>,
  },
});
