import { BrowserWindow } from "electron";

import { DEFAULT_ACCELERATORS, type CadetCommand } from "@mycadet/ipc-contract";

import {
  closeCommandPaletteWindow,
  dispatchToMainWindow,
  isCommandPaletteWindowFocused,
  openCommandPaletteWindow,
} from "./command-palette-window";
import { onSettingChange, readSetting, writeSetting } from "./settings";

export type { CadetCommand };

export type CadetCommandKind = CadetCommand["kind"];

export { DEFAULT_ACCELERATORS };

export interface HotkeySettingsProvider {
  read: () => Record<string, string>;
  write: (hotkeys: Record<string, string>) => void;
  subscribe: (listener: () => void) => () => void;
}

/**
 * The settings-store-backed hotkey settings — the one provider shape all
 * three desktop shells shipped identically, so it lives here next to the
 * store instead of once per client.
 */
export const settingsHotkeySettings: HotkeySettingsProvider = {
  read: () => ({ ...(readSetting("hotkeys") ?? {}) }),
  write: (hotkeys) => {
    writeSetting("hotkeys", hotkeys);
  },
  subscribe: (listener) => onSettingChange("hotkeys", listener),
};

const unavailableHotkeySettings: HotkeySettingsProvider = {
  read: () => ({}),
  write: () => {
    throw new Error("Hotkey settings are unavailable");
  },
  subscribe: () => () => undefined,
};

let hotkeySettings: HotkeySettingsProvider = unavailableHotkeySettings;

export const configureHotkeySettings = (
  provider?: HotkeySettingsProvider,
): void => {
  hotkeySettings = provider ?? unavailableHotkeySettings;
};

export const readHotkeyOverride = (key: string): string | null => {
  const value = hotkeySettings.read()[key];
  return typeof value === "string" ? value : null;
};

export const readHotkeyOverrides = (): Record<string, string> => ({
  ...hotkeySettings.read(),
});

export const writeHotkeyOverrides = (hotkeys: Record<string, string>): void => {
  hotkeySettings.write(hotkeys);
};

export const onHotkeyOverridesChange = (listener: () => void): (() => void) =>
  hotkeySettings.subscribe(listener);

/**
 * Commands whose accelerators are registered as Electron `globalShortcut`s
 * (system-wide, active even when the app is not focused). Every other
 * command uses menu accelerators which only fire when the app has focus.
 */
export const GLOBAL_SHORTCUT_DEFAULTS: Record<string, string> = {
  globalHotkey: "CmdOrCtrl+Shift+G",
  quickInput: "CmdOrCtrl+Shift+/",
  /**
   * Talk. Ships **unbound**, and is the only global here that does.
   *
   * A global registration outranks every app's own shortcuts for as long as
   * Cadet runs, and `globalShortcut.register` cannot see those: it reports a
   * conflict only against other *global* registrants, so it returns true for
   * chords that are load-bearing inside other apps. Cmd+Shift+T registered
   * cleanly and took reopen-closed-tab away from every browser on the machine.
   *
   * There is no chord we can pick that is not load-bearing somewhere, and no
   * way to find out which one we broke. So the user picks it, in Keyboard
   * Shortcuts, spending a chord they know they can spare. The macOS shell
   * excludes it altogether: a double tap of the voice key is the way in there.
   */
  toggleVoice: "",
};

/**
 * Resolve the accelerator for a command, preferring the user override from
 * `settings.hotkeys.<kind>` and falling back to the compiled default when no
 * override is set. An explicit empty-string override is honored as "disabled"
 * (the user removed the binding via the Keyboard Shortcuts settings) — callers
 * that build menu items must treat an empty result as "no accelerator".
 */
export const resolveAccelerator = (kind: CadetCommandKind): string => {
  return readHotkeyOverride(kind) ?? DEFAULT_ACCELERATORS[kind];
};

/**
 * Menu/tray template fragment carrying a command's accelerator, or no
 * `accelerator` key at all when the binding is disabled (an empty-string
 * override, or a command with no compiled default). Electron treats a missing
 * `accelerator` as "no shortcut", whereas `accelerator: ""` is not a valid
 * accelerator — passing it to `Menu.buildFromTemplate` throws. Every menu and
 * tray item builds its accelerator through this helper so the empty-string
 * case is handled in exactly one place.
 */
export const acceleratorOption = (
  kind: CadetCommandKind,
): { accelerator?: string } => {
  const accelerator = resolveAccelerator(kind);
  return accelerator ? { accelerator } : {};
};

/**
 * Send a command to whichever BrowserWindow currently has focus, falling
 * back to the first window if none is focused (which happens when a menu
 * item is clicked from the menu bar while the app is in the background but
 * its window isn't the OS focus owner). Capturing a window reference at
 * menu-construction time would break future thread pop-outs, where the
 * user expects Cmd+N to operate on the popped-out window they're in.
 */
export const dispatchToFocused = (command: CadetCommand): void => {
  // The palette window is not a command target: a palette command toggles
  // it (open when unfocused, dismiss while focused), and any other command
  // fired while it holds focus belongs to the main window, whose renderer
  // alone speaks the app command protocol.
  if (command.kind === "commandPalette") {
    if (isCommandPaletteWindowFocused()) {
      closeCommandPaletteWindow();
      return;
    }
    openCommandPaletteWindow();
    return;
  }
  if (isCommandPaletteWindowFocused()) {
    dispatchToMainWindow(command);
    return;
  }
  const target =
    BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  target?.webContents.send("cadet:command", command);
};
