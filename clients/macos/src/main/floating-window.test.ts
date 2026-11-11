import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { RENDERER_BASE_PROD } from "./app-config";

type Listener = () => void;

type StubWebContents = {
  on: (event: string, listener: Listener) => StubWebContents;
  isDestroyed: () => boolean;
  emit: (event: string) => void;
};

type CreateWindowOptions = {
  browserWindow: Record<string, unknown>;
  navigation: unknown;
};

const appState = { isPackaged: false };
const created: Array<{ opts: CreateWindowOptions; win: StubBrowserWindow }> =
  [];

// The full options the floating-window module hands its createWindow dep,
// staged so the stubbed BrowserWindow constructor can record them next to
// the window it builds.
let stagedOpts: CreateWindowOptions | undefined;

/**
 * The mocked `electron.BrowserWindow`: constructed wherever the module under
 * test asks Electron for a window, carrying the observable surface the
 * floating-window package drives (listeners, show variants, loadURL) plus
 * the `calls` trace the click-through assertions read.
 */
class StubBrowserWindow {
  static getFocusedWindow() {
    return null;
  }

  opts: CreateWindowOptions;

  calls: string[] = [];
  private windowListeners = new Map<string, Listener[]>();
  private webContentsListeners = new Map<string, Listener[]>();
  private windowDestroyed = false;
  private webContentsDestroyed = false;

  webContents = {
    on: (event: string, listener: Listener): StubWebContents => {
      const listeners = this.webContentsListeners.get(event) ?? [];
      listeners.push(listener);
      this.webContentsListeners.set(event, listeners);
      return this.webContents;
    },
    isDestroyed: (): boolean => this.webContentsDestroyed,
    emit: (event: string): void => {
      if (event === "destroyed") this.webContentsDestroyed = true;
      for (const listener of this.webContentsListeners.get(event) ?? []) {
        listener();
      }
    },
  };

  isDestroyed = (): boolean => this.windowDestroyed;

  on = (event: string, listener: Listener): StubBrowserWindow => {
    const listeners = this.windowListeners.get(event) ?? [];
    listeners.push(listener);
    this.windowListeners.set(event, listeners);
    return this;
  };

  emit = (event: string): void => {
    if (event === "closed") this.windowDestroyed = true;
    for (const listener of this.windowListeners.get(event) ?? []) listener();
  };

  setPosition = mock((_x: number, _y: number) => undefined);
  setAlwaysOnTop = mock((_flag: boolean, _level: string) => undefined);
  setIgnoreMouseEvents = mock(
    (_ignore: boolean, _options?: { forward?: boolean }) => {
      this.calls.push("setIgnoreMouseEvents");
    },
  );
  setVisibleOnAllWorkspaces = mock(
    (_visible: boolean, _opts: Record<string, boolean>) => undefined,
  );
  show = mock(() => {
    this.calls.push("show");
  });
  focus = mock(() => undefined);
  showInactive = mock(() => {
    this.calls.push("showInactive");
  });
  loadURL = mock((_url: string) => Promise.resolve());

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

mock.module("electron", () => ({
  app: appState,
  BrowserWindow: StubBrowserWindow,
  ipcMain: {
    handle: mock(() => undefined),
    on: mock(() => undefined),
  },
  screen: {
    getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    getDisplayNearestPoint: () => ({
      workArea: { x: 0, y: 0, width: 1440, height: 900 },
    }),
  },
}));

const { BrowserWindow } = await import("electron");
const {
  configureFloatingWindows,
  createFloatingWindow,
  createWindowRouteResolver,
  getFloatingWindow,
} = await import("@mycadet/electron-desktop/floating-window");

configureFloatingWindows({
  createWindow: (opts) => {
    stagedOpts = opts;
    return new BrowserWindow(opts.browserWindow);
  },
  platform: "darwin",
  resolveRoute: createWindowRouteResolver(() => RENDERER_BASE_PROD),
});

let nextKind = 1;
const kind = (name: string): string => `${name}-${nextKind++}`;

beforeEach(() => {
  created.length = 0;
  stagedOpts = undefined;
  appState.isPackaged = false;
});

afterEach(() => {
  for (const { win } of created) {
    if (!win.isDestroyed()) win.emit("closed");
  }
});

/** The window the latest createFloatingWindow call built. */
const lastWindow = (): StubBrowserWindow => {
  const entry = created.at(-1);
  if (!entry) throw new Error("expected a created window");
  return entry.win;
};

describe("createFloatingWindow", () => {
  test("creates floating panels with the shared defaults and deny-all navigation", () => {
    createFloatingWindow({
      kind: kind("defaults"),
      route: "dictation-overlay",
      width: 480,
      height: 160,
    });
    const win = lastWindow();

    expect(created).toHaveLength(1);
    expect(created[0]?.opts.navigation).toBe("deny-all");
    expect(created[0]?.opts.browserWindow).toMatchObject({
      type: "panel",
      width: 480,
      height: 160,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
    });
    expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, "floating"]]);
    expect(win.setVisibleOnAllWorkspaces.mock.calls).toEqual([
      [
        true,
        {
          visibleOnFullScreen: true,
          skipTransformProcessType: true,
        },
      ],
    ]);
    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "app://mycadet.ai/assistant/dictation-overlay",
    );
  });

  test("resolves packaged renderer routes under the assistant base", () => {
    appState.isPackaged = true;

    createFloatingWindow({
      kind: kind("packaged-url"),
      route: "/command-palette",
      width: 320,
      height: 200,
    });
    const win = lastWindow();

    expect(win.loadURL.mock.calls[0]?.[0]).toBe(
      "app://mycadet.ai/assistant/command-palette",
    );
  });

  test("uses showInactive unless focus is explicitly requested", () => {
    createFloatingWindow({
      kind: kind("passive"),
      route: "/passive",
      width: 100,
      height: 100,
      focusOnShow: false,
    });
    const passive = lastWindow();
    expect(passive.showInactive).toHaveBeenCalledTimes(1);
    expect(passive.show).not.toHaveBeenCalled();
    expect(passive.focus).not.toHaveBeenCalled();

    createFloatingWindow({
      kind: kind("focused"),
      route: "/focused",
      width: 100,
      height: 100,
      focusOnShow: true,
    });
    const focused = lastWindow();
    expect(focused.showInactive).not.toHaveBeenCalled();
    expect(focused.show).toHaveBeenCalledTimes(1);
    expect(focused.focus).toHaveBeenCalledTimes(1);
  });

  test("leaves a new window hidden when the caller shows it", () => {
    createFloatingWindow({
      kind: kind("caller-shows"),
      route: "/caller-shows",
      width: 100,
      height: 100,
      callerShows: true,
    });
    const win = lastWindow();
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();

    win.emit("ready-to-show");
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(win.show).not.toHaveBeenCalled();
  });

  test("reuses the existing window for a kind and repositions it before showing", () => {
    let x = 10;
    const singletonKind = kind("singleton");
    const position = () => ({ x, y: x + 1 });

    createFloatingWindow({
      kind: singletonKind,
      route: "/singleton",
      width: 100,
      height: 100,
      focusOnShow: true,
      position,
    });
    const first = lastWindow();

    x = 20;
    createFloatingWindow({
      kind: singletonKind,
      route: "/singleton",
      width: 100,
      height: 100,
      focusOnShow: true,
      position,
    });
    const second = lastWindow();

    expect(second).toBe(first);
    expect(created).toHaveLength(1);
    expect(first.setPosition.mock.calls).toEqual([
      [10, 11],
      [20, 21],
    ]);
    expect(first.show).toHaveBeenCalledTimes(2);
    expect(first.focus).toHaveBeenCalledTimes(2);
    expect(first.loadURL).toHaveBeenCalledTimes(1);
  });

  test("allows callers to opt out of Spaces visibility and customize the top level", () => {
    createFloatingWindow({
      kind: kind("spaces-opt-out"),
      route: "/overlay",
      width: 100,
      height: 100,
      visibleOnAllWorkspaces: false,
      alwaysOnTopLevel: "pop-up-menu",
    });
    const win = lastWindow();

    expect(win.setAlwaysOnTop.mock.calls).toEqual([[true, "pop-up-menu"]]);
    expect(win.setVisibleOnAllWorkspaces).not.toHaveBeenCalled();
  });

  test("applies click-through behavior before showing the window", () => {
    createFloatingWindow({
      kind: kind("click-through"),
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: true,
    });
    const win = lastWindow();

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([[true]]);
    expect(win.calls).toEqual(["setIgnoreMouseEvents", "showInactive"]);
  });

  test("can forward mouse movement while click-through", () => {
    createFloatingWindow({
      kind: kind("click-through-forward"),
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    });
    const win = lastWindow();

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([
      [true, { forward: true }],
    ]);
  });

  test("reapplies click-through behavior when reusing an existing window", () => {
    const singletonKind = kind("click-through-reuse");

    createFloatingWindow({
      kind: singletonKind,
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    });
    const win = lastWindow();
    win.setIgnoreMouseEvents.mockClear();

    createFloatingWindow({
      kind: singletonKind,
      route: "/overlay",
      width: 100,
      height: 100,
      ignoreMouseEvents: { forward: true },
    });

    expect(win.setIgnoreMouseEvents.mock.calls).toEqual([
      [true, { forward: true }],
    ]);
  });

  test("drops the singleton reference when the window closes", () => {
    const cleanupKind = kind("closed");
    createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    const first = lastWindow();

    first.emit("closed");

    expect(getFloatingWindow(cleanupKind)).toBeNull();
    createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    const second = lastWindow();
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });

  test("drops the singleton reference when webContents is destroyed", () => {
    const cleanupKind = kind("webcontents-destroyed");
    createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    const first = lastWindow();

    first.webContents.emit("destroyed");

    expect(getFloatingWindow(cleanupKind)).toBeNull();
    createFloatingWindow({
      kind: cleanupKind,
      route: "/cleanup",
      width: 100,
      height: 100,
    });
    const second = lastWindow();
    expect(second).not.toBe(first);
    expect(created).toHaveLength(2);
  });
});
