import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { electronMock } from "../test-setup";

/**
 * The dispatcher's window stubs: a constructible window (the palette's
 * createWindow dep builds these) and a controllable focused-window static —
 * the two levers every dispatch route reads.
 */
type Listener = (...args: unknown[]) => void;

class StubWindow {
  static focused: StubWindow | null = null;

  static getFocusedWindow() {
    return StubWindow.focused;
  }

  static getAllWindows() {
    return StubWindow.focused ? [StubWindow.focused] : [];
  }

  private windowListeners = new Map<string, Listener[]>();
  private windowDestroyed = false;

  close = mock(() => {
    this.windowDestroyed = true;
    for (const listener of this.windowListeners.get("closed") ?? []) {
      listener();
    }
  });
  show = mock(() => undefined);
  focus = mock(() => undefined);
  getBounds = () => ({ x: 0, y: 0, width: 584, height: 444 });
  setPosition = mock(() => undefined);
  setAlwaysOnTop = mock(() => undefined);
  setVisibleOnAllWorkspaces = mock(() => undefined);
  loadURL = mock(() => Promise.resolve());
  on = mock((event: string, listener: Listener) => {
    const listeners = this.windowListeners.get(event) ?? [];
    listeners.push(listener);
    this.windowListeners.set(event, listeners);
  });
  isDestroyed = () => this.windowDestroyed;
  webContents = {
    isDestroyed: () => false,
    on: mock((_event: string, _listener: Listener) => undefined),
    send: mock(() => undefined),
  };
}

const createdWindows: StubWindow[] = [];
const sentToMain: unknown[] = [];

mock.module("electron", () =>
  electronMock({
    BrowserWindow: StubWindow,
    // electronMock replaces top-level keys (member identity matters), so the
    // screen surface the palette's positioning reads comes complete.
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getPrimaryDisplay: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getAllDisplays: () => [],
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      on: () => undefined,
    },
  }),
);

const {
  configureHotkeySettings,
  DEFAULT_ACCELERATORS,
  dispatchToFocused,
  GLOBAL_SHORTCUT_DEFAULTS,
  resolveAccelerator,
} = await import("./commands");
const { configureCommandPaletteWindow, __resetForTesting } =
  await import("./command-palette-window");
const { configureFloatingWindows } = await import("./floating-window");

configureFloatingWindows({
  createWindow: () => {
    const win = new StubWindow();
    createdWindows.push(win);
    return win as unknown as Electron.BrowserWindow;
  },
  platform: "linux",
  resolveRoute: (route: string) => `https://app.local${route}`,
});

configureCommandPaletteWindow({
  currentMainWindow: () => null,
  dispatchToMain: (command) => sentToMain.push(command),
  ensureMainWindowVisible: () => undefined,
});

let mockHotkeys: unknown = null;

configureHotkeySettings({
  read: () =>
    mockHotkeys && typeof mockHotkeys === "object"
      ? (mockHotkeys as Record<string, string>)
      : {},
  write: () => undefined,
  subscribe: () => () => undefined,
});

beforeEach(() => {
  StubWindow.focused = null;
  createdWindows.length = 0;
  sentToMain.length = 0;
});

afterEach(() => {
  mockHotkeys = null;
  __resetForTesting();
  for (const win of createdWindows.splice(0)) {
    if (!win.isDestroyed()) {
      win.close();
    }
  }
});

describe("resolveAccelerator", () => {
  test("returns the default when no override is set", () => {
    mockHotkeys = {};
    expect(resolveAccelerator("newConversation")).toBe(
      DEFAULT_ACCELERATORS.newConversation,
    );
  });

  test("returns the default when `hotkeys` is null", () => {
    mockHotkeys = null;
    expect(resolveAccelerator("currentConversation")).toBe(
      DEFAULT_ACCELERATORS.currentConversation,
    );
  });

  test("returns the user override when set to a non-empty string", () => {
    mockHotkeys = { newConversation: "CmdOrCtrl+Alt+T" };
    expect(resolveAccelerator("newConversation")).toBe("CmdOrCtrl+Alt+T");
  });

  test("treats an empty-string override as a disabled binding", () => {
    mockHotkeys = { newConversation: "" };
    expect(resolveAccelerator("newConversation")).toBe("");
  });

  test("falls back to the default for a non-string override", () => {
    mockHotkeys = { markCurrentUnread: 42 };
    expect(resolveAccelerator("markCurrentUnread")).toBe(
      DEFAULT_ACCELERATORS.markCurrentUnread,
    );
  });

  test("ignores overrides for other commands", () => {
    mockHotkeys = { newConversation: "CmdOrCtrl+Alt+T" };
    expect(resolveAccelerator("markCurrentUnread")).toBe(
      DEFAULT_ACCELERATORS.markCurrentUnread,
    );
  });
});

describe("compiled accelerator defaults", () => {
  test("no chord is claimed by two commands", () => {
    const owners = new Map<string, string[]>();
    for (const [kind, accelerator] of [
      ...Object.entries(DEFAULT_ACCELERATORS),
      ...Object.entries(GLOBAL_SHORTCUT_DEFAULTS),
    ]) {
      if (!accelerator) {
        continue;
      }
      const claimants = owners.get(accelerator);
      if (claimants) {
        claimants.push(kind);
      } else {
        owners.set(accelerator, [kind]);
      }
    }

    // Electron binds a duplicated chord to whichever menu item it builds
    // first and drops the other silently, so a collision reads as "the
    // shortcut does nothing" rather than as an error.
    const collisions = [...owners.entries()]
      .filter(([, kinds]) => kinds.length > 1)
      .map(([accelerator, kinds]) => `${accelerator}: ${kinds.join(", ")}`);
    expect(collisions).toEqual([]);
  });
});

describe("dispatchToFocused", () => {
  test("opens the palette window on a palette command aimed at a renderer", () => {
    StubWindow.focused = new StubWindow();

    dispatchToFocused({ kind: "commandPalette" });

    expect(createdWindows).toHaveLength(1);
    expect(StubWindow.focused.webContents.send).not.toHaveBeenCalled();
  });

  test("closes the focused palette when the palette command fires again", () => {
    dispatchToFocused({ kind: "commandPalette" });
    const palette = createdWindows[0]!;
    StubWindow.focused = palette;

    dispatchToFocused({ kind: "commandPalette" });

    expect(palette.close).toHaveBeenCalledTimes(1);
  });

  test("keeps other commands on the focused renderer's command stream", () => {
    const focused = new StubWindow();
    StubWindow.focused = focused;

    dispatchToFocused({ kind: "newConversation" });

    expect(createdWindows).toHaveLength(0);
    expect(focused.webContents.send).toHaveBeenCalledWith("cadet:command", {
      kind: "newConversation",
    });
  });

  test("routes other commands to the main window while the palette is focused", () => {
    dispatchToFocused({ kind: "commandPalette" });
    const palette = createdWindows[0]!;
    StubWindow.focused = palette;

    dispatchToFocused({ kind: "openSettings" });

    expect(palette.webContents.send).not.toHaveBeenCalledWith("cadet:command", {
      kind: "openSettings",
    });
    expect(sentToMain).toEqual([{ kind: "openSettings" }]);
  });
});
