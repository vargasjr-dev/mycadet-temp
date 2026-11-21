import { BrowserWindow, screen } from "electron";
import { z } from "zod";

import {
  QUICK_INPUT_DISMISS,
  QUICK_INPUT_SUBMIT,
  type CadetCommand,
} from "@mycadet/ipc-contract";

import { handle } from "./ipc";
import { createModuleConfiguration } from "./module-configuration";
import type { CreateWindowOptions } from "./windows";

/**
 * System-wide quick input window
 */

const QUICK_INPUT_PATH = "/quick-input";

const PANEL_WIDTH = 720;
const PANEL_HEIGHT = 72;

export interface QuickInputWindowDependencies {
  createWindow: (options: CreateWindowOptions) => BrowserWindow;
  dispatchToMain: (command: CadetCommand) => void;
  ensureMainWindowVisible: () => void | Promise<void>;
  resolveRoute: (route: string) => string;
}

const configuration = createModuleConfiguration<QuickInputWindowDependencies>(
  "Quick Input window module",
);
export const configureQuickInputWindow = configuration.configure;

let quickInputWindow: BrowserWindow | null = null;

const quickInputPosition = (): { x: number; y: number } => {
  const cursor = screen.getCursorScreenPoint();
  const { workArea } = screen.getDisplayNearestPoint(cursor);
  return {
    x: Math.round(workArea.x + (workArea.width - PANEL_WIDTH) / 2),
    y: Math.round(
      workArea.y + (workArea.height - PANEL_HEIGHT) / 2 - workArea.height * 0.1,
    ),
  };
};

export const repositionQuickInputWindow = (): void => {
  if (quickInputWindow && !quickInputWindow.isDestroyed()) {
    const { x, y } = quickInputPosition();
    quickInputWindow.setPosition(x, y);
  }
};

const openQuickInput = (): void => {
  if (quickInputWindow && !quickInputWindow.isDestroyed()) {
    quickInputWindow.close();
    return;
  }

  const { createWindow, resolveRoute } = configuration.get();
  const { x, y } = quickInputPosition();

  quickInputWindow = createWindow({
    browserWindow: {
      type: "panel",
      vibrancy: "popover",
      width: PANEL_WIDTH,
      height: PANEL_HEIGHT,
      x,
      y,
      frame: false,
      transparent: true,
      resizable: false,
      minimizable: false,
      maximizable: false,
      focusable: true,
      fullscreenable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      hasShadow: true,
    },
    navigation: "deny-all",
  });

  quickInputWindow.once("ready-to-show", () => {
    quickInputWindow?.show();
  });

  quickInputWindow.on("blur", () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.close();
    }
  });

  quickInputWindow.on("closed", () => {
    quickInputWindow = null;
  });

  void quickInputWindow.loadURL(resolveRoute(QUICK_INPUT_PATH));
};

/**
 * Toggle the quick input panel: if open, close it; if closed, open it.
 * Called from the global shortcut handler.
 */
export const toggleQuickInput = (): void => {
  openQuickInput();
};

let installed = false;

export const installQuickInput = (): void => {
  if (installed) {
    return;
  }
  installed = true;
  const { dispatchToMain, ensureMainWindowVisible } = configuration.get();

  handle(QUICK_INPUT_SUBMIT, z.tuple([z.string()]), async ([message]) => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.close();
    }

    await ensureMainWindowVisible();

    const command: CadetCommand = { kind: "quickInputSubmit", message };
    dispatchToMain(command);
  });

  handle(QUICK_INPUT_DISMISS, z.tuple([]), () => {
    if (quickInputWindow && !quickInputWindow.isDestroyed()) {
      quickInputWindow.close();
    }
  });
};
