import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  CadetBridge,
  CadetCommand,
  TextInsertionResult,
  TitleBarOverlayTheme,
} from "@mycadet/ipc-contract";

export const WINDOWS_CORE_CAPABILITIES = [
  "platform",
  "hostOS",
  "app",
  "commands",
  "mainWindow",
  "text",
] as const satisfies readonly (keyof CadetBridge)[];

export type WindowsCoreBridge = Pick<
  CadetBridge,
  (typeof WINDOWS_CORE_CAPABILITIES)[number]
>;

/**
 * macOS-only bridge surfaces with no Windows counterpart: voice activity
 * belongs to the companion voice session, a floating always-present window
 * the Windows shell does not open; the renderer feature-detects it and
 * falls back to web behavior. See `docs/parity-matrix.md`.
 */
export const WINDOWS_NOT_APPLICABLE_CAPABILITIES = [
  "voiceActivity",
] as const satisfies readonly (keyof CadetBridge)[];

/** The always-present core every `./features/` module builds on. */
export const createWindowsCoreBridge = (): WindowsCoreBridge => ({
  platform: "electron",
  hostOS: "windows",
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
    navigateTo: (url: string): Promise<void> =>
      ipcRenderer.invoke("cadet:mainWindow:navigateTo", url) as Promise<void>,
    setTitleBarOverlay: (theme: TitleBarOverlayTheme): Promise<void> =>
      ipcRenderer.invoke(
        "cadet:mainWindow:setTitleBarOverlay",
        theme,
      ) as Promise<void>,
  },
  text: {
    insertIntoFrontApp: (text): Promise<TextInsertionResult> =>
      ipcRenderer.invoke("cadet:text:insertIntoFrontApp", text),
    openAutomationSettings: (): Promise<void> =>
      ipcRenderer.invoke("cadet:text:openAutomationSettings"),
  },
});
