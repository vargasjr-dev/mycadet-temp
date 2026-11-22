import type { BrowserWindow, BrowserWindowConstructorOptions } from "electron";

import { getRendererBase } from "./app-config";
import { createWindow } from "./windows";

type AlwaysOnTopLevel = NonNullable<
  Parameters<BrowserWindow["setAlwaysOnTop"]>[1]
>;
type IgnoreMouseEventsOptions = NonNullable<
  Parameters<BrowserWindow["setIgnoreMouseEvents"]>[1]
>;

export type FloatingWindowPosition =
  | { x: number; y: number }
  | ((win: BrowserWindow) => { x: number; y: number });

export interface CreateFloatingWindowOptions {
  kind: string;
  route: string;
  width: number;
  height: number;
  focusOnShow?: boolean;
  /**
   * Leave a new window off the screen for the caller to show, rather than
   * showing it straight away. A window this call reuses is shown either way.
   */
  callerShows?: boolean;
  alwaysOnTopLevel?: AlwaysOnTopLevel;
  visibleOnAllWorkspaces?: boolean;
  ignoreMouseEvents?: boolean | IgnoreMouseEventsOptions;
  browserWindow?: Omit<
    BrowserWindowConstructorOptions,
    | "webPreferences"
    | "type"
    | "width"
    | "height"
    | "frame"
    | "transparent"
    | "resizable"
    | "skipTaskbar"
    | "fullscreenable"
    | "show"
  >;
  position?: FloatingWindowPosition;
}

export const resolveRoute = (route: string): string =>
  `${getRendererBase()}${route.startsWith("/") ? route : `/${route}`}`;

const floatingWindows = new Map<string, BrowserWindow>();

const isAlive = (win: BrowserWindow): boolean =>
  !win.isDestroyed() && !win.webContents.isDestroyed();

export const getFloatingWindow = (kind: string): BrowserWindow | null => {
  const win = floatingWindows.get(kind);
  if (!win) {
    return null;
  }
  if (isAlive(win)) {
    return win;
  }
  floatingWindows.delete(kind);
  return null;
};

/**
 * Every floating window still alive, in no particular order.
 *
 * For callers that act on the surfaces as a group rather than on one by kind:
 * hiding the application takes all of them off the screen, and putting them
 * back is a statement about the set.
 */
export const listFloatingWindows = (): BrowserWindow[] => {
  const alive: BrowserWindow[] = [];
  for (const [kind, win] of floatingWindows) {
    if (isAlive(win)) {
      alive.push(win);
    } else {
      floatingWindows.delete(kind);
    }
  }
  return alive;
};

const applyPosition = (
  win: BrowserWindow,
  position: FloatingWindowPosition | undefined,
): void => {
  if (!position) {
    return;
  }
  const { x, y } = typeof position === "function" ? position(win) : position;
  win.setPosition(x, y);
};

export const repositionFloatingWindow = (
  kind: string,
  position: FloatingWindowPosition,
): void => {
  const win = getFloatingWindow(kind);
  if (win) {
    applyPosition(win, position);
  }
};

const showFloatingWindow = (win: BrowserWindow, focusOnShow: boolean): void => {
  if (focusOnShow) {
    win.show();
    win.focus();
    return;
  }
  win.showInactive();
};

const applyIgnoreMouseEvents = (
  win: BrowserWindow,
  ignoreMouseEvents: boolean | IgnoreMouseEventsOptions,
): void => {
  if (typeof ignoreMouseEvents === "boolean") {
    win.setIgnoreMouseEvents(true);
  } else {
    win.setIgnoreMouseEvents(true, ignoreMouseEvents);
  }
};

export const createFloatingWindow = ({
  kind,
  route,
  width,
  height,
  focusOnShow = false,
  callerShows = false,
  alwaysOnTopLevel = "floating",
  ignoreMouseEvents = false,
  visibleOnAllWorkspaces,
  browserWindow,
  position,
}: CreateFloatingWindowOptions): BrowserWindow => {
  const existing = getFloatingWindow(kind);
  if (existing) {
    applyPosition(existing, position);
    if (ignoreMouseEvents) {
      applyIgnoreMouseEvents(existing, ignoreMouseEvents);
    }
    showFloatingWindow(existing, focusOnShow);
    return existing;
  }

  const win = createWindow({
    browserWindow: {
      ...browserWindow,
      type: "panel",
      width,
      height,
      frame: false,
      transparent: true,
      resizable: false,
      skipTaskbar: true,
      fullscreenable: false,
      show: false,
    },
    navigation: "deny-all",
  });

  win.setAlwaysOnTop(true, alwaysOnTopLevel);
  if (ignoreMouseEvents) {
    applyIgnoreMouseEvents(win, ignoreMouseEvents);
  }
  // Floating panels default to following the cursor across Spaces (and
  // staying visible over full-screen apps); an explicit opt-out — the
  // permission guide must not haunt every Space — skips it.
  if (visibleOnAllWorkspaces !== false) {
    win.setVisibleOnAllWorkspaces(true, {
      visibleOnFullScreen: true,
      skipTransformProcessType: true,
    });
  }

  const cleanup = (): void => {
    if (floatingWindows.get(kind) === win) {
      floatingWindows.delete(kind);
    }
  };
  win.on("closed", cleanup);
  win.webContents.on("destroyed", cleanup);

  floatingWindows.set(kind, win);
  applyPosition(win, position);
  void win.loadURL(resolveRoute(route));
  if (!callerShows) {
    showFloatingWindow(win, focusOnShow);
  }
  return win;
};
