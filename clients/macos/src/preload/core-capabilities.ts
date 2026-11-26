import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
  TextInsertionResult,
} from "@mycadet/ipc-contract";

export const MACOS_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
  "text",
] as const satisfies readonly (keyof CadetBridge)[];

export type MacosCoreBridge = Pick<
  CadetBridge,
  (typeof MACOS_CORE_CAPABILITIES)[number]
>;

/** The always-present core every `./features/` module builds on. */
export const createMacosCoreBridge = (): MacosCoreBridge => ({
  platform: "electron",
  hostOS: "macos",
  app: {
    versionInfo: (): Promise<AppVersionInfo> =>
      ipcRenderer.invoke("cadet:app:versionInfo"),
    openWebsite: (): Promise<void> =>
      ipcRenderer.invoke("cadet:app:openWebsite"),
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
      ipcRenderer.invoke("cadet:mainWindow:ensureVisible"),
    setOnboarding: (active: boolean): Promise<void> =>
      ipcRenderer.invoke("cadet:mainWindow:setOnboarding", active),
    navigateTo: (url: string): Promise<void> =>
      ipcRenderer.invoke("cadet:mainWindow:navigateTo", url),
  },
  // The macOS text surface includes the undo seam: the helper's raw
  // keyboard monitor lets the main process undo its own insertion.
  text: {
    insertIntoFrontApp: (text): Promise<TextInsertionResult> =>
      ipcRenderer.invoke("cadet:text:insertIntoFrontApp", text),
    openAutomationSettings: (): Promise<void> =>
      ipcRenderer.invoke("cadet:text:openAutomationSettings"),
    undoInFrontApp: (): Promise<TextInsertionResult> =>
      ipcRenderer.invoke("cadet:text:undoInFrontApp"),
  },
});
