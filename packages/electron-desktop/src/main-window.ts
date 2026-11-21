import { BrowserWindow, app, autoUpdater, nativeTheme, shell } from "electron";
import {
  IDENTITY_NAME,
  MAIN_WINDOW_ENSURE_VISIBLE,
  MAIN_WINDOW_SET_ONBOARDING,
  MAIN_WINDOW_NAVIGATE_TO,
  MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
  titleBarOverlayThemeSchema,
  type ColorScheme,
  type TitleBarOverlayTheme,
  type CadetCommand,
} from "@mycadet/ipc-contract";
import {
  readOnboardingActive,
  readTitleBarOverlayTheme,
  restoreBounds,
  setOnboarding as persistOnboardingMode,
  track as trackWindowState,
  writeTitleBarOverlayTheme,
} from "./window-state";
import { createWindowReadiness } from "./window-readiness";
import { createModuleConfiguration } from "./module-configuration";
import { z } from "zod";

import { getRendererBase } from "./app-config";
import { isAllowedOrigin, resolveAllowedOrigin } from "./app-origin";
import { handle, on } from "./ipc";
import { getName } from "./identity";
import log from "./app-logger";
import { createWindow } from "./windows";

const MAIN_MIN_SIZE = { width: 800, height: 600 } as const;
const DEFAULT_WINDOW_TITLE = "Cadet";

/**
 * How the window's chrome draws, per shell: the macOS traffic lights over a
 * hidden title bar, the Windows caption overlay, or the plain system frame.
 * A shell-passed value — the chrome is build configuration, not something
 * the shared code derives from the OS it happens to run on.
 */
export type MainWindowTitleBarMode = "hidden" | "hiddenOverlay" | "systemFrame";

interface MainWindowConfiguration {
  titleBarMode: MainWindowTitleBarMode;
}

const configuration =
  createModuleConfiguration<MainWindowConfiguration>("main-window");

/** Shell-passed chrome: call once from `startApp`, before any install. */
export const configureMainWindow = (next: MainWindowConfiguration): void => {
  configuration.configure(next);
};

/**
 * Windows draws its caption buttons in a native overlay whose height is
 * fixed by the builder config; the same renderer reports themes for it.
 */
const TITLE_BAR_HEIGHT = 44;

// macOS traffic-light (window controls) position for the main-app layout.
//
// The renderer's chat header (`clients/web` `ChatLayoutHeader`) renders as a
// unified ~44px title bar whose icon row sits *inline* with the window
// controls. To line them up we vertically centre the ~14px-tall traffic
// light cluster in that bar — `(44 − 14) / 2 ≈ 15` — and inset it ~19px from
// the left edge (matching the macOS default), so the header's left padding
// clears the cluster.
//
// Compact / pre-app surfaces (onboarding, the `/account/*` auth screens) have
// no such title bar, so they keep the system-default position. Those surfaces
// drive the setOnboarding IPC; the main app drives the reset.
const MAIN_WINDOW_BUTTON_POSITION = { x: 19, y: 15 } as const;

// The traffic lights are macOS chrome — on other desktops the API simply
// isn't there, and absence of the API is the no-op. Capability detection
// keeps this an OS-agnostic call site.
const applyWindowButtonPosition = (
  win: BrowserWindow,
  position: { x: number; y: number } | null,
): void => {
  if (typeof win.setWindowButtonPosition !== "function") {
    return;
  }
  win.setWindowButtonPosition(position);
};

let mainWindow: BrowserWindow | null = null;
let isQuitting = false;
let currentTitle = DEFAULT_WINDOW_TITLE;

const readiness = createWindowReadiness<BrowserWindow>();

// Visibility-change subscribers. The dock's state machine follows
// main-window show/hide/closed transitions without having to scan every
// BrowserWindow and identify "main." `browser-window-created` would fire
// BEFORE `mainWindow = win` lands (the Electron event is synchronous inside
// the constructor), so any identity check at that hook is racy. This
// subscription fires AFTER the assignment so `current()` is correct by the
// time the listener runs.
type VisibilityListener = () => void;
const visibilityListeners: VisibilityListener[] = [];

export const onMainWindowVisibilityChange = (
  listener: VisibilityListener,
): void => {
  visibilityListeners.push(listener);
};

const fireVisibilityChange = (): void => {
  for (const listener of visibilityListeners) listener();
};

// A close waiting for the window to come out of fullscreen before it hides.
// Withdrawn by `ensureVisible`, so a press that brings the app back during
// the exit animation is not undone by the hide landing after it.
let cancelPendingHide: (() => void) | null = null;

const installSameOriginNavigationGuard = (win: BrowserWindow): void => {
  const allowedOrigin = resolveAllowedOrigin();

  win.webContents.on("will-navigate", (event, url) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      event.preventDefault();
      return;
    }
    if (isAllowedOrigin(parsed, allowedOrigin)) {
      return;
    }
    event.preventDefault();
    if (parsed.protocol === "https:" || parsed.protocol === "http:") {
      void shell.openExternal(url);
    }
  });
};

const createMainWindow = (): BrowserWindow => {
  // Onboarding and the main app share the same sizing: restore the user's
  // saved state, which defaults to maximized (the work area) when nothing
  // has been persisted yet. A saved fullscreen session includes
  // `fullscreen: true` on the constructor; a windowed session omits the key
  // so the platform's native fullscreen affordance stays. The persisted
  // onboarding flag only drives the traffic-light position (compact
  // surfaces have no inline title bar).
  const onboardingActive = readOnboardingActive();
  const { maximized, fullscreen, ...restoredBounds } = restoreBounds(
    "main",
    "maximized",
  );
  const { titleBarMode } = configuration.get();
  const overlay = readTitleBarOverlayTheme();
  if (overlay) {
    syncNativeColorScheme(overlay.colorScheme);
  }
  const chromeOptions =
    titleBarMode === "hiddenOverlay"
      ? {
          titleBarStyle: "hidden" as const,
          titleBarOverlay: {
            color: overlay?.color,
            symbolColor: overlay?.symbolColor,
            height: TITLE_BAR_HEIGHT,
          },
        }
      : titleBarMode === "hidden"
        ? // macOS: hidden chrome keeps the traffic lights — the renderer
          // content extends up to the top edge behind them.
          { titleBarStyle: "hidden" as const }
        : {};
  const win = createWindow({
    browserWindow: {
      ...restoredBounds,
      minWidth: MAIN_MIN_SIZE.width,
      minHeight: MAIN_MIN_SIZE.height,
      fullscreenable: true,
      ...(fullscreen === true ? { fullscreen: true } : {}),
      ...chromeOptions,
      show: false,
    },
    navigation: { installGuard: installSameOriginNavigationGuard },
    // This window owns the live-voice session, which keeps running (and
    // keeps a floating panel on screen) while the user works in another app.
    backgroundThrottling: false,
  });

  // `fullscreenable` as a constructor option doesn't guarantee the
  // `.fullScreenPrimary` collection behavior on macOS Tahoe; asserting it
  // post-construction does. A no-op on the other desktops.
  win.setFullScreenable(true);

  // Main owns the window title (the active assistant's name). Block the
  // renderer's static `<title>` ("Cadet") from overriding it via
  // page-title updates, then seed the current name — the identity
  // subscription in `installMainWindow` keeps it live.
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.setTitle(currentTitle);

  // Line the traffic lights up with the renderer's inline title bar for the
  // main app; the compact onboarding / auth window keeps the system
  // default. Done before `show` (the window is created hidden) so there's
  // no flicker of the cluster jumping into place. The setOnboarding IPC
  // keeps this in sync as the user crosses between compact and main
  // surfaces.
  if (titleBarMode === "hidden") {
    applyWindowButtonPosition(
      win,
      onboardingActive ? null : { ...MAIN_WINDOW_BUTTON_POSITION },
    );
  }

  // Both modes share the main-app sizing now, so bounds are persisted
  // unconditionally — a resize during onboarding is a legitimate "main"
  // size and should survive the transition and the next launch.
  trackWindowState("main", win);

  // Readiness resolves only after BOTH the renderer has loaded AND the
  // window has shown + focused. Per-window state keyed via WeakMap so
  // concurrent `createWindow` calls can't cross-resolve each other's
  // promise.
  const ready = readiness.arm(win);
  win.webContents.once("did-finish-load", () => {
    ready.markLoaded();
  });

  win.once("ready-to-show", () => {
    if (maximized) {
      win.maximize();
    }
    win.show();
    win.focus();
    ready.markShown();
  });

  // Visibility transitions feed the dock state machine (via
  // `onMainWindowVisibilityChange`). Subscribed here — not in the
  // listener — so dock doesn't need to know how to identify "main".
  win.on("show", fireVisibilityChange);
  win.on("hide", fireVisibilityChange);

  // **The close button puts the window away; only a quit takes it down.**
  // This renderer is the one that runs calls and owns the voice key, and
  // the companion stays on screen after the window goes. Destroying it
  // would leave a press on Talk or a double tap of the key with nowhere to
  // land but a new window, which has to show itself to exist, so a user who
  // closed the app to be rid of it would get it back on their next press.
  // Hidden, it answers those presses where they were made, and anything
  // that raises the app shows this same window again.
  win.on("close", (event) => {
    if (isQuitting || win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    // A fullscreen window hidden in place leaves its Space behind, empty
    // and black, so it comes out of fullscreen first and hides on arrival.
    if (win.isFullScreen()) {
      cancelPendingHide?.();
      const hideOnArrival = (): void => {
        cancelPendingHide = null;
        win.hide();
      };
      win.once("leave-full-screen", hideOnArrival);
      cancelPendingHide = () => {
        win.off("leave-full-screen", hideOnArrival);
        cancelPendingHide = null;
      };
      win.setFullScreen(false);
      return;
    }
    win.hide();
  });

  win.on("closed", () => {
    // Unblock any pending `await ensureVisible()` so callers that hit the
    // destroyed-before-ready race (network failure during load, user quit
    // mid-load) don't hang forever. The caller's follow-up dispatch then
    // sees `current() === null` and no-ops; that's the right semantics,
    // since the window only closes for real on a quit.
    ready.release();
    if (mainWindow === win) {
      mainWindow = null;
    }
    // Subscribers (dock) re-read `current()` which is now null.
    fireVisibilityChange();
  });

  const loadTarget = getRendererBase();
  win.loadURL(loadTarget).catch((err: unknown) => {
    log.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  // Fire AFTER assignment so subscribers see the new window via `current()`
  // if they query it. The window itself isn't visible yet (created with
  // `show: false`); the `show`/`hide` listeners above drive subsequent
  // transitions.
  fireVisibilityChange();
  return win;
};

/** Recreate if destroyed, restore from minimize, show, focus, and await load. */
export const ensureVisible = (): Promise<void> => {
  // The latest ask wins over a close still waiting to hide.
  cancelPendingHide?.();
  if (!mainWindow || mainWindow.isDestroyed()) {
    const win = createMainWindow();
    return readiness.wait(win);
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }
  mainWindow.show();
  mainWindow.focus();
  return readiness.wait(mainWindow);
};

export const hide = (): void => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.hide();
};

export const current = (): BrowserWindow | null => mainWindow;

export const dispatchToMain = (command: CadetCommand): void => {
  const win = current();
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send("cadet:command", command);
  }
};

/** Module-private: {@link toggleVisibility} is the only caller. */
const isVisibleAndFocused = (): boolean => {
  const win = current();
  return !!win && !win.isDestroyed() && win.isVisible() && win.isFocused();
};

export const toggleVisibility = (): void => {
  if (isVisibleAndFocused()) {
    current()?.hide();
    return;
  }
  ensureVisible();
};

/**
 * Put the native color scheme on the scheme the app paints.
 *
 * Chromium washes a caption button on hover and press with a translucent
 * layer whose color comes from the native frame, not from the overlay's own
 * color, so a dark title bar under a light system scheme is washed in black
 * on black and the buttons stop responding to the pointer. Reporting the
 * app's scheme puts that wash on the right side of the surface underneath
 * it.
 */
const syncNativeColorScheme = (colorScheme: ColorScheme): void => {
  const systemPrefersDark =
    nativeTheme.themeSource === "system"
      ? nativeTheme.shouldUseDarkColors
      : nativeTheme.shouldUseDarkColorsForSystemIntegratedUI;
  nativeTheme.themeSource =
    (colorScheme === "dark") === systemPrefersDark ? "system" : colorScheme;
};

/**
 * Paint the native caption buttons in the renderer's theme.
 *
 * The overlay is OS chrome drawn over the webview, so it can't inherit the
 * themed title bar it sits in: the colors have to be handed to it. They're
 * persisted as well as applied because they're `BrowserWindow` constructor
 * options, so the next launch builds its window themed instead of opening
 * on the system caption colors until the renderer reports its theme.
 */
const setTitleBarOverlay = (theme: TitleBarOverlayTheme): void => {
  writeTitleBarOverlayTheme(theme);
  syncNativeColorScheme(theme.colorScheme);
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitleBarOverlay({
      color: theme.color,
      symbolColor: theme.symbolColor,
      height: TITLE_BAR_HEIGHT,
    });
  }
};

const setAssistantName = (name: string | null): void => {
  const nextTitle = name?.trim() || DEFAULT_WINDOW_TITLE;
  if (nextTitle === currentTitle) {
    return;
  }
  currentTitle = nextTitle;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setTitle(currentTitle);
  }
};

/**
 * Switch the main window between the onboarding and main-app layouts. Both
 * share the same sizing — the only per-mode difference is the traffic-light
 * position, since the inline title bar exists only on the main-app surface.
 * The mode is persisted so the next launch positions the traffic lights
 * without a flicker. Re-asserting the current mode (the renderer fires this
 * on every navigation) is a cheap no-op past the early return.
 */
export const setOnboarding = (active: boolean): void => {
  const wasActive = readOnboardingActive();
  persistOnboardingMode(active);

  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (active === wasActive) return;

  if (configuration.get().titleBarMode === "hidden") {
    // Re-centre (or reset) the traffic lights to match the layout we're
    // moving into — the inline title bar exists only on the main-app
    // surface.
    applyWindowButtonPosition(
      win,
      active ? null : { ...MAIN_WINDOW_BUTTON_POSITION },
    );
  }
};

let installed = false;

/** Register main-window IPC and create the initial window. */
export const installMainWindow = (): void => {
  if (installed) {
    return;
  }
  installed = true;

  handle(MAIN_WINDOW_ENSURE_VISIBLE, z.tuple([]), async () => {
    await ensureVisible();
  });
  // Renderer-driven onboarding mode. The renderer is the only side that
  // knows whether the current route is an onboarding step, so it toggles
  // the mode (traffic-light position) on/off as the user navigates.
  handle(MAIN_WINDOW_SET_ONBOARDING, z.tuple([z.boolean()]), ([active]) => {
    setOnboarding(active);
  });
  // The chooser's switch-to-origin: the renderer hands over a remembered
  // https base and the window loads it itself. `loadURL` does not fire
  // `will-navigate`, so the same-origin guard above — which ejects
  // renderer-initiated cross-origin navigations to the system browser —
  // stays intact for everything but this one deliberate escape.
  handle(MAIN_WINDOW_NAVIGATE_TO, z.tuple([z.string()]), ([url]) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    if (parsed.protocol !== "https:") {
      return;
    }
    void mainWindow?.loadURL(url);
  });
  handle(
    MAIN_WINDOW_SET_TITLE_BAR_OVERLAY,
    z.tuple([titleBarOverlayThemeSchema]),
    ([theme], event) => {
      // Only the window wearing the overlay describes it. Every window runs
      // the same renderer bundle and reports whatever theme it applied: the
      // offscreen theme-stage window stages arbitrary workspace tokens for
      // screenshots, and auxiliary windows carry no workspace theme at all.
      if (event.sender !== mainWindow?.webContents) {
        return;
      }
      setTitleBarOverlay(theme);
    },
  );
  on(IDENTITY_NAME, z.tuple([z.string()]), ([name]) => {
    setAssistantName(name);
  });
  // Seed the title from the persisted identity so a fresh process (or a
  // recreated window) shows the assistant's name, not the fallback, before
  // the renderer's first publish.
  setAssistantName(getName());

  // What lets the close button's close through. `before-quit` covers the
  // quit chords and the menus. An update install is the one quit that
  // closes the windows before it says so: the updater's `quitAndInstall`
  // announces `before-quit-for-update`, closes every window, and only then
  // quits.
  const letCloseThrough = (): void => {
    isQuitting = true;
  };
  app.on("before-quit", letCloseThrough);
  autoUpdater.on("before-quit-for-update", letCloseThrough);

  void ensureVisible();
};

export const __resetForTesting = (): void => {
  installed = false;
  isQuitting = false;
  currentTitle = DEFAULT_WINDOW_TITLE;
  cancelPendingHide = null;
};
