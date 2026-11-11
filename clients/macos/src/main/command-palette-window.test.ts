import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { IpcHandle } from "@mycadet/electron-desktop/ipc";

import { RENDERER_BASE_PROD } from "./app-config";

type Listener = (...args: unknown[]) => void;

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string, ...args: unknown[]) => void;
  send: ReturnType<typeof mock>;
};

type FocusedSource = {
  webContents: { send: ReturnType<typeof mock> };
  isDestroyed: () => boolean;
  getBounds: () => Electron.Rectangle;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

const appState = { isPackaged: false, name: "Cadet" };
const created: Array<{ opts: CreateWindowOptions; win: StubBrowserWindow }> =
  [];
const ipcHandlers = new Map<
  string,
  (args: unknown, event?: unknown) => unknown
>();

// The full options the floating-window module hands its createWindow dep,
// staged so the stubbed BrowserWindow constructor can record them.
let stagedOpts: CreateWindowOptions | undefined;

let focusedWindow: StubBrowserWindow | FocusedSource | null = null;

const setFocusedWindow = (
  win: StubBrowserWindow | FocusedSource | null,
): void => {
  focusedWindow = win;
};
let activeWorkArea: Electron.Rectangle = {
  x: 1440,
  y: 100,
  width: 1600,
  height: 900,
};
let currentMainWindow: {
  isDestroyed: () => boolean;
  isVisible: () => boolean;
  isMinimized: () => boolean;
} | null = null;

/**
 * The mocked `electron.BrowserWindow`: constructed wherever the palette asks
 * Electron for a window, carrying the observable surface the modules under
 * test drive (listeners, visibility state, close/show variants, loadURL).
 */
class StubBrowserWindow {
  static getFocusedWindow() {
    return focusedWindow;
  }

  static getAllWindows() {
    return focusedWindow ? [focusedWindow] : [];
  }

  opts: CreateWindowOptions;

  private windowListeners = new Map<string, Listener[]>();
  private webContentsListeners = new Map<string, Listener[]>();
  private windowDestroyed = false;
  private webContentsDestroyed = false;
  private visible = false;
  private minimized = false;
  private bounds: Electron.Rectangle = { x: 0, y: 0, width: 584, height: 444 };

  webContents = {
    on: (event: string, listener: Listener): StubWebContents => {
      const listeners = this.webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      this.webContentsListeners.set(event, listeners);
      return this.webContents;
    },
    isDestroyed: (): boolean => this.webContentsDestroyed,
    emit: (event: string, ...args: unknown[]): void => {
      if (event === "destroyed") this.webContentsDestroyed = true;
      for (const listener of this.webContentsListeners.get(event) ?? []) {
        listener(...args);
      }
    },
    send: mock(() => undefined),
  };

  isDestroyed = (): boolean => this.windowDestroyed;
  isVisible = (): boolean => this.visible;
  isMinimized = (): boolean => this.minimized;
  getBounds = (): Electron.Rectangle => ({ ...this.bounds });

  on = (event: string, listener: Listener): StubBrowserWindow => {
    const listeners = this.windowListeners.get(event) ?? [];
    listeners.push(listener);
    this.windowListeners.set(event, listeners);
    return this;
  };

  emit = (event: string, ...args: unknown[]): void => {
    if (event === "closed") {
      this.windowDestroyed = true;
      this.visible = false;
    }
    if (event === "hide") this.visible = false;
    if (event === "show") this.visible = true;
    for (const listener of this.windowListeners.get(event) ?? []) {
      listener(...args);
    }
  };

  close = mock((): void => {
    this.emit("closed");
  });
  setPosition = mock((x: number, y: number): void => {
    this.bounds.x = x;
    this.bounds.y = y;
  });
  setAlwaysOnTop = mock((_flag: boolean, _level: string): void => undefined);
  setIgnoreMouseEvents = mock((_ignore: boolean): void => undefined);
  setVisibleOnAllWorkspaces = mock(
    (_visible: boolean, _opts: Record<string, boolean>): void => undefined,
  );
  show = mock((): void => {
    this.visible = true;
  });
  focus = mock((): void => {
    setFocusedWindow(this);
  });
  showInactive = mock((): void => {
    this.visible = true;
  });
  loadURL = mock((_url: string): Promise<void> => Promise.resolve());

  constructor(options: Record<string, unknown>) {
    // The floating-window module stages the full createWindow options before
    // constructing; the browserWindow subset is what Electron itself receives.
    this.opts = stagedOpts ?? {
      browserWindow: options,
      navigation: undefined,
    };
    created.push({ opts: this.opts, win: this });
  }
}

const makeFocusedSource = (
  bounds: Electron.Rectangle = { x: 1500, y: 200, width: 900, height: 700 },
): FocusedSource => ({
  webContents: { send: mock(() => undefined) },
  isDestroyed: () => false,
  getBounds: () => bounds,
});

const makeMainWindow = ({
  visible = true,
  minimized = false,
  destroyed = false,
}: {
  visible?: boolean;
  minimized?: boolean;
  destroyed?: boolean;
}) => ({
  isDestroyed: () => destroyed,
  isVisible: () => visible,
  isMinimized: () => minimized,
});

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: StubBrowserWindow,
  Menu: {
    buildFromTemplate: mock((template: unknown) => template),
    setApplicationMenu: mock((_menu: unknown) => undefined),
  },
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({ workArea: activeWorkArea }),
    getDisplayMatching: mock((_bounds: Electron.Rectangle) => ({
      workArea: activeWorkArea,
    })),
  },
  shell: {
    openExternal: mock(() => Promise.resolve()),
  },
}));

const { BrowserWindow } = await import("electron");

const createWindowMock = mock(
  (opts: CreateWindowOptions): Electron.BrowserWindow => {
    stagedOpts = opts;
    return new BrowserWindow(opts.browserWindow);
  },
);

// A plain IpcHandle implementation rather than a bun mock: the generic
// registration signature can't round-trip through Mock's own generics.
const handleCalls: Array<[string, unknown]> = [];
const handleMock: IpcHandle = (channel, schema, fn) => {
  handleCalls.push([channel, fn]);
  void schema;
  ipcHandlers.set(channel, (args, event) =>
    Reflect.apply(fn, undefined, [args, event]),
  );
};

const ensureVisibleMock = mock(async () => undefined);
const dispatchToMainMock = mock((_command: unknown) => undefined);

mock.module("./windows", () => ({
  createWindow: createWindowMock,
}));

mock.module("./ipc", () => ({
  handle: handleMock,
}));

mock.module("./main-window", () => ({
  current: () => currentMainWindow,
  ensureVisible: ensureVisibleMock,
  dispatchToMain: dispatchToMainMock,
}));

mock.module("@mycadet/electron-desktop/settings", () => ({
  readHotkeyOverride: () => null,
  readSetting: () => null,
  writeSetting: () => {},
  onSettingChange: () => () => {},
}));

mock.module("@mycadet/electron-desktop/about", () => ({
  openAboutWindow: mock(() => undefined),
}));

mock.module("./auto-update.client", () => ({
  checkForUpdates: mock(() => undefined),
}));

mock.module("./devtools", () => ({
  areChromeDevToolsEnabled: () => false,
}));

mock.module("@mycadet/electron-desktop/window-state", () => ({
  readOnboardingActive: () => false,
  readCompanionHidden: () => false,
  onCompanionHiddenChange: () => () => {},
}));

// Stubbed so `./menu`, imported below for `dispatchMenuCommand`, doesn't drag
// the real companion surface into this file's module graph, along with the
// rest of `window-state` that the mock above deliberately doesn't cover.
mock.module("./companion-window", () => ({
  setCompanionSurfaceVisible: () => undefined,
}));

// Full `./cli-path-installer` surface so this mock — which leaks into co-run
// test files via the global module registry — doesn't break sibling modules.
mock.module("./cli-path-installer", () => ({
  WRAPPER_MARKER: "# cadet-cli-wrapper v1",
  getWrapperDir: () => "/tmp/.local/bin",
  getWrapperPath: () => "/tmp/.local/bin/cadet",
  buildWrapperScript: () => "",
  readWrapperOwnership: () => "absent",
  installWrapper: () => "installed",
  getCliPathInstallState: async () => ({ kind: "not-installed" }),
  uninstallWrapper: () => "absent",
}));

mock.module("./cli-path-flow", () => ({
  runInstallCliCommandFlow: async () => undefined,
  runUninstallCliCommandFlow: async () => undefined,
  isCliPathFlowInFlight: () => false,
}));

const {
  __resetForTesting,
  commandPaletteDispatchCommandSchema,
  configureCommandPaletteWindow,
  installCommandPaletteWindow,
  openCommandPaletteWindow,
  selectCommandPaletteCommand,
} = await import("@mycadet/electron-desktop/command-palette-window");
const { configureFloatingWindows, createWindowRouteResolver } =
  await import("@mycadet/electron-desktop/floating-window");

configureFloatingWindows({
  createWindow: createWindowMock,
  platform: "darwin",
  resolveRoute: createWindowRouteResolver(() => RENDERER_BASE_PROD),
});
configureCommandPaletteWindow({
  currentMainWindow: () => currentMainWindow,
  dispatchToMain: dispatchToMainMock,
  ensureMainWindowVisible: ensureVisibleMock,
  handle: handleMock,
});
const { dispatchMenuCommand } = await import("./menu");

beforeEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
  created.length = 0;
  ipcHandlers.clear();
  createWindowMock.mockClear();
  handleCalls.length = 0;
  ensureVisibleMock.mockClear();
  dispatchToMainMock.mockClear();
  appState.isPackaged = false;
  activeWorkArea = { x: 1440, y: 100, width: 1600, height: 900 };
  focusedWindow = makeFocusedSource();
  currentMainWindow = null;
  __resetForTesting();
});

afterEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.close();
  }
});

describe("openCommandPaletteWindow", () => {
  test("opens a focused singleton floating window centered in the focused display work area", () => {
    const first = openCommandPaletteWindow();
    expect(first).toBeUndefined();

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    const { opts, win } = created[0]!;
    expect(opts.navigation).toBe("deny-all");
    expect(opts.browserWindow).toMatchObject({
      type: "panel",
      width: 584,
      height: 444,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
      minimizable: false,
      maximizable: false,
      hasShadow: true,
      backgroundColor: "#00000000",
    });
    expect(win.setPosition.mock.calls).toEqual([[1948, 328]]);
    expect(win.show).toHaveBeenCalledTimes(1);
    expect(win.focus).toHaveBeenCalledTimes(1);
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "app://mycadet.ai/assistant/floating/command-palette",
    );

    openCommandPaletteWindow();

    expect(createWindowMock).toHaveBeenCalledTimes(1);
    expect(win.show).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalledTimes(2);
    expect(win.loadURL).toHaveBeenCalledTimes(1);
  });

  test("closes when the floating window blurs", () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;

    win.emit("blur");

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.isDestroyed()).toBe(true);
  });

  test("closes on Escape before-input events", () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;
    const preventDefault = mock(() => undefined);

    win.webContents.emit(
      "before-input-event",
      { preventDefault },
      {
        type: "keyDown",
        key: "Escape",
      },
    );

    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(win.isDestroyed()).toBe(true);
  });
});

describe("installCommandPaletteWindow", () => {
  test("registers open, dismiss, and select IPC handlers", async () => {
    installCommandPaletteWindow();

    expect(handleCalls.map(([channel]) => channel)).toEqual([
      "cadet:commandPalette:open",
      "cadet:commandPalette:dismiss",
      "cadet:commandPalette:select",
    ]);

    ipcHandlers.get("cadet:commandPalette:open")?.([]);
    expect(created).toHaveLength(1);

    ipcHandlers.get("cadet:commandPalette:dismiss")?.([]);
    expect(created[0]!.win.close).toHaveBeenCalledTimes(1);

    currentMainWindow = makeMainWindow({ visible: true });
    await ipcHandlers.get("cadet:commandPalette:select")?.([
      { kind: "sidebarToggle" },
    ]);
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "sidebarToggle" });

    await ipcHandlers.get("cadet:commandPalette:select")?.([
      { kind: "openConversation", conversationId: "conv-123" },
    ]);
    expect(dispatchToMainMock).toHaveBeenCalledWith({
      kind: "openConversation",
      conversationId: "conv-123",
    });
  });
});

describe("selectCommandPaletteCommand", () => {
  test("closes the palette and dispatches to a visible main window without refocusing it", async () => {
    openCommandPaletteWindow();
    const win = created[0]!.win;
    currentMainWindow = makeMainWindow({ visible: true });

    await selectCommandPaletteCommand({ kind: "openSettings" });

    expect(win.close).toHaveBeenCalledTimes(1);
    expect(ensureVisibleMock).not.toHaveBeenCalled();
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "openSettings" });
  });

  test("ensures the main window before dispatch when it is hidden", async () => {
    currentMainWindow = makeMainWindow({ visible: false });

    await selectCommandPaletteCommand({ kind: "shareFeedback" });

    expect(ensureVisibleMock).toHaveBeenCalledTimes(1);
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "shareFeedback" });
  });
});

describe("commandPaletteDispatchCommandSchema", () => {
  test("accepts palette-dispatchable commands, with and without payloads", () => {
    expect(
      commandPaletteDispatchCommandSchema.safeParse({ kind: "sidebarToggle" })
        .success,
    ).toBe(true);
    expect(
      commandPaletteDispatchCommandSchema.safeParse({
        kind: "selectAssistant",
        assistantId: "ast-1",
      }).success,
    ).toBe(true);
  });

  test("rejects the kinds the palette never offers", () => {
    // Pins the exclusion list in the dispatch type to the runtime schema:
    // both reject the same kinds.
    expect(
      commandPaletteDispatchCommandSchema.safeParse({ kind: "commandPalette" })
        .success,
    ).toBe(false);
    expect(
      commandPaletteDispatchCommandSchema.safeParse({
        kind: "removePairedAssistant",
        assistantId: "paired-1",
      }).success,
    ).toBe(false);
  });
});

describe("dispatchMenuCommand", () => {
  test("routes the Command Palette menu command to the floating window", () => {
    const source = makeFocusedSource();
    focusedWindow = source;

    dispatchMenuCommand({ kind: "commandPalette" });

    expect(created).toHaveLength(1);
    expect(source.webContents.send).not.toHaveBeenCalled();
  });

  test("closes the focused palette when the Command Palette accelerator is pressed again", () => {
    openCommandPaletteWindow();
    const palette = created[0]!.win;

    dispatchMenuCommand({ kind: "commandPalette" });

    expect(palette.close).toHaveBeenCalledTimes(1);
    expect(palette.isDestroyed()).toBe(true);
  });

  test("keeps other menu commands on the focused renderer command stream", () => {
    const source = makeFocusedSource();
    focusedWindow = source;

    dispatchMenuCommand({ kind: "newConversation" });

    expect(created).toHaveLength(0);
    expect(source.webContents.send).toHaveBeenCalledWith("cadet:command", {
      kind: "newConversation",
    });
  });

  test("routes non-palette menu commands to the main window while the palette is focused", () => {
    openCommandPaletteWindow();
    const palette = created[0]!.win;

    dispatchMenuCommand({ kind: "openSettings" });

    expect(palette.webContents.send).not.toHaveBeenCalledWith("cadet:command", {
      kind: "openSettings",
    });
    expect(dispatchToMainMock).toHaveBeenCalledWith({ kind: "openSettings" });
  });
});
