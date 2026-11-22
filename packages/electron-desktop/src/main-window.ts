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

/** Shell-passed chrome: hidden (traffic lights), hiddenOverlay (caption overlay), or systemFrame. */
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

/** The native caption overlay's height, matching the renderer's inline title bar. */
const TITLE_BAR_HEIGHT = 44;

// Traffic lights: vertically centred in the renderer's inline title bar, mac-default inset.
const MAIN_WINDOW_BUTTON_POSITION = { x: 19, y: 15 } as const;

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

// Visibility subscribers (the dock); fires after assignment, so current() is live.
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

// A close waiting out the fullscreen-exit animation; ensureVisible withdraws it.
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
  // Onboarding and the main app share sizing; the persisted onboarding flag
  // drives only the traffic-light position.
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
        ? { titleBarStyle: "hidden" as const }
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
    // Live voice keeps running while the user works in another app.
    backgroundThrottling: false,
  });

  // Post-construction assert: the constructor option alone misses macOS
  // Tahoe's `.fullScreenPrimary` behavior.
  win.setFullScreenable(true);

  // Main owns the title; block the renderer's static `<title>`.
  win.webContents.on("page-title-updated", (event) => {
    event.preventDefault();
  });
  win.setTitle(currentTitle);

  // Position before `show` so the cluster never flickers; setOnboarding keeps it in sync.
  if (titleBarMode === "hidden") {
    applyWindowButtonPosition(
      win,
      onboardingActive ? null : { ...MAIN_WINDOW_BUTTON_POSITION },
    );
  }

  // Bounds persist unconditionally — an onboarding resize is a legitimate main size.
  trackWindowState("main", win);

  // Readiness resolves after BOTH load and show; WeakMap-keyed per window.
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

  win.on("show", fireVisibilityChange);
  win.on("hide", fireVisibilityChange);

  // The close button hides; only a quit takes the window down — this
  // renderer owns calls and the voice key, and the companion outlives it.
  win.on("close", (event) => {
    if (isQuitting || win.isDestroyed()) {
      return;
    }
    event.preventDefault();
    // A fullscreen hide leaves its Space black — exit fullscreen, hide on arrival.
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
    // Unblock pending `await ensureVisible()` so destroyed-before-ready callers don't hang.
    ready.release();
    if (mainWindow === win) {
      mainWindow = null;
    }
    fireVisibilityChange();
  });

  const loadTarget = getRendererBase();
  win.loadURL(loadTarget).catch((err: unknown) => {
    log.error(`[main-window] loadURL failed for ${loadTarget}:`, err);
  });

  mainWindow = win;
  // Fire after assignment so subscribers' current() is live.
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
 * Put the native color scheme on the scheme the app paints — Chromium's
 * caption-button hover wash takes its color from the native frame, so a
 * mismatched scheme washes the buttons out.
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
 * Paint the native caption buttons in the renderer's theme; persisted
 * because they're constructor options.
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
 * Switch the main window between the onboarding and main-app layouts —
 * the only difference is the traffic-light position. Persisted so the next
 * launch positions without a flicker.
 */
export const setOnboarding = (active: boolean): void => {
  const wasActive = readOnboardingActive();
  persistOnboardingMode(active);

  const win = mainWindow;
  if (!win || win.isDestroyed()) return;
  if (active === wasActive) return;

  if (configuration.get().titleBarMode === "hidden") {
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
  // The renderer is the only side that knows the route is an onboarding step.
  handle(MAIN_WINDOW_SET_ONBOARDING, z.tuple([z.boolean()]), ([active]) => {
    setOnboarding(active);
  });
  // The chooser's switch-to-origin: a remembered https base the window loads
  // directly (`loadURL` bypasses `will-navigate`, so the guard stays intact).
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
      // Only the window wearing the overlay describes it — stage and
      // auxiliary windows run the same bundle and report too.
      if (event.sender !== mainWindow?.webContents) {
        return;
      }
      setTitleBarOverlay(theme);
    },
  );
  on(IDENTITY_NAME, z.tuple([z.string()]), ([name]) => {
    setAssistantName(name);
  });
  // Seed the title from the persisted identity before the renderer's first publish.
  setAssistantName(getName());

  // before-quit covers the quit chords and menus; the updater's
  // quitAndInstall announces before-quit-for-update first.
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
