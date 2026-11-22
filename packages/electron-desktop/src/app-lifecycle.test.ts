import { beforeEach, describe, expect, mock, test } from "bun:test";

import {
  electronAppOverride,
  electronMock,
  recordedIpcHandlers,
} from "../test-setup";

// The lifecycle seam owns everything the three shells shipped identically:
// the lock, the schemes, the userData suffix, the launch capture, the
// second-instance focus, and — on ready — the universal installs, the
// protocol stack, the identity slice, the notification runtime, the universal
// app surface, and the classic-desktop composition, before handing over to
// the client's setup. Electron is mocked so the test drives resolve and
// reject paths without an Electron runtime; each install below is a
// recorder, so the test asserts the ORDER the surface assembles in.
let readyResolve: (() => void) | null = null;
const logCalls: Array<[string, ...unknown[]]> = [];
const appListeners = new Map<string, Array<() => void>>();
let lockWinner = true;

const deferredReady = () =>
  new Promise<void>((resolve) => {
    readyResolve = resolve;
  });

const appCalls: string[] = [];

mock.module("electron", () =>
  electronMock({
    app: electronAppOverride({
      requestSingleInstanceLock: () => lockWinner,
      // The composition raises the app emitter's listener ceiling for the
      // legit before-quit fan-out.
      setMaxListeners: () => undefined,
      on: (event: string, handler: () => void) => {
        const list = appListeners.get(event) ?? [];
        list.push(handler);
        appListeners.set(event, list);
      },
      whenReady: deferredReady,
      quit: () => {
        appCalls.push("quit");
      },
    }),
  }),
);

// startApp's single-purpose dependencies are mocked here (nothing else
// imports them, so no co-run pollution).
const calls: string[] = [];
const recorder = (name: string) => () => {
  calls.push(name);
};

mock.module("./commands", () => ({
  configureHotkeySettings: recorder("hotkey-settings"),
  settingsHotkeySettings: {},
}));
mock.module("./auto-update", () => ({
  installAutoUpdate: recorder("auto-update"),
}));
mock.module("./app-logger", () => ({
  default: {
    info: (...args: unknown[]) => logCalls.push(["info", ...args]),
    error: (...args: unknown[]) => logCalls.push(["error", ...args]),
    warn: (...args: unknown[]) => logCalls.push(["warn", ...args]),
  },
  getLogFilePaths: () => [],
}));
mock.module("./main-window", () => ({
  configureMainWindow: () => undefined,
  current: () => null,
  dispatchToMain: () => undefined,
  ensureVisible: async () => calls.push("ensure-visible"),
  installMainWindow: recorder("main-window"),
  // The companion's surface wiring reads the main window's visibility, so
  // the module is in this composition's graph.
  onMainWindowVisibilityChange: () => () => {},
}));
mock.module("./hotkeys", () => ({ installHotkeysIpc: recorder("hotkeys") }));
mock.module("./about", () => ({
  configureAboutRuntime: () => undefined,
  installAbout: recorder("about"),
}));
mock.module("./menu", () => ({
  installDesktopMenu: recorder("menu"),
  refreshDesktopMenuCliPath: () => undefined,
}));
mock.module("./global-shortcuts", () => ({
  installGlobalShortcuts: recorder("global-shortcuts"),
}));
mock.module("./quick-input-window", () => ({
  installQuickInput: recorder("quick-input"),
  toggleQuickInput: () => undefined,
}));
mock.module("./downloads", () => ({ installDownloads: recorder("downloads") }));
mock.module("./command-palette-window", () => ({
  installCommandPaletteWindow: recorder("palette"),
}));
mock.module("./popout-window", () => ({
  installPopoutWindows: recorder("popouts"),
}));
mock.module("./features/bundles", () => ({ install: recorder("bundles") }));
mock.module("./features/diagnostics", () => ({
  install: recorder("diagnostics"),
}));
mock.module("./features/window-attention", () => ({
  install: recorder("window-attention"),
}));
mock.module("./features/auth", () => ({ install: recorder("auth") }));
mock.module("./features/auxiliary-windows", () => ({
  install: recorder("auxiliary-windows"),
}));
mock.module("./features/dictation", () => ({
  install: recorder("dictation"),
  // The helper-hotkeys feature shares the bridge's client accessor.
  helperClient: () => {
    throw new Error("no helper client in this suite");
  },
}));
mock.module("./features/host-proxy", () => ({
  install: recorder("host-proxy"),
}));
mock.module("./features/login-item", () => ({
  install: recorder("login-item"),
}));
mock.module("./features/permissions", () => ({
  install: recorder("permissions"),
  getPermissionsService: () => null,
}));
// The per-OS permission arms resolve inside the package; the composition
// test pins the installs, not the OS answers.
mock.module("./features/permissions-strategy", () => ({
  permissionsStrategy: () => ({}),
  describeError: (err: unknown) => String(err),
}));
mock.module("./features/permission-guide-values", () => ({
  dragTarget: async () => ({ file: "/mock.app", icon: null }),
  openSettingsPane: async () => undefined,
  listSettingsWindows: async () => [],
}));
mock.module("./dictation-overlay-window", () => ({
  installDictationOverlay: recorder("dictation-overlay"),
}));
mock.module("./features/tray", () => ({ install: recorder("tray") }));
mock.module("./features/companion-window", () => ({
  installCompanionWindow: recorder("companion-window"),
  syncCompanionSurface: recorder("companion-sync"),
  setCompanionSurfaceVisible: () => undefined,
  showCompanionCoachmarks: () => undefined,
}));
mock.module("./features/share", () => ({ install: recorder("share") }));
mock.module("./features/helper-hotkeys", () => ({
  install: recorder("helper-hotkeys"),
}));
mock.module("./features/voice-mode-chord", () => ({
  install: recorder("voice-mode-chord"),
}));

const { startApp } = await import("./app-lifecycle");

const drain = async () => {
  readyResolve!();
  await Promise.resolve();
  await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
};

beforeEach(() => {
  calls.length = 0;
  logCalls.length = 0;
  appCalls.length = 0;
  appListeners.clear();
  recordedIpcHandlers.clear();
  lockWinner = true;
});

/** The universal surface, in the order startApp assembles it. The
 * auth/auxiliary-windows/login-item/main-window composition is shared by
 * every shell since the main-window fold; the tray, share, and host-proxy
 * installs joined it in R9 — every shell rides them, values shell-passed. */
const universalSurface = [
  "hotkey-settings",
  "auto-update",
  "bundles",
  "hotkeys",
  "about",
  "menu",
  "global-shortcuts",
  "diagnostics",
  "downloads",
  "palette",
  "quick-input",
  "popouts",
  "window-attention",
  "auth",
  "auxiliary-windows",
  "login-item",
  "main-window",
  "host-proxy",
  "tray",
  "share",
  "permissions",
  "companion-window",
];

/** The classic-only composition, appended on the classic platforms. The
 * dictation overlay follows the dictation install; its escape-monitor half
 * is wired inside installDictationOverlay itself. */
const classicSurface = [
  "dictation",
  "dictation-overlay",
  "helper-hotkeys",
  "voice-mode-chord",
];

describe("startApp", () => {
  test("logs ready, assembles the universal surface in order, and runs setup once Electron is ready", async () => {
    let ran = false;
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
      setup: () => {
        ran = true;
      },
    });

    await drain();

    expect(ran).toBe(true);
    expect(
      logCalls.some(
        ([level, message]) => level === "info" && message === "[app] ready",
      ),
    ).toBe(true);
    // The universal protocol stack registers through the shared registrar.
    expect(recordedIpcHandlers.size).toBeGreaterThan(0);
    // The web-contents security wiring rides every WebContents.
    expect(appListeners.has("web-contents-created")).toBe(true);
  });

  test("a lock loser quits and skips everything past the early wiring", async () => {
    lockWinner = false;

    let ran = false;
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
      setup: () => {
        ran = true;
      },
    });

    await drain();

    expect(appCalls).toContain("quit");
    expect(ran).toBe(false);
    // Only the early wiring (the settings provider + auto-update) ran; the
    // universal app surface, the shared composition, and the client's own
    // setup are all behind the lock gate.
    expect(calls).toEqual(["hotkey-settings", "auto-update"]);
  });

  test("the companion surface installs before setup and syncs after, on every desktop", async () => {
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
    });

    await drain();

    expect(calls).toContain("companion-window");
    // The menu-facing visibility entry is introduced to the window wiring
    // before anything can dispatch through it.
    expect(calls.indexOf("companion-window")).toBeGreaterThan(
      calls.indexOf("permissions"),
    );
    // The initial sync runs once the shell's own setup is done — the same
    // point the classic shell's setup used to sync at.
    expect(calls.indexOf("companion-sync")).toBeGreaterThan(
      calls.indexOf("companion-window"),
    );
  });

  test("a second-instance launch focuses the client's main window", async () => {
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
    });

    const secondInstance = appListeners.get("second-instance") ?? [];
    expect(secondInstance).toHaveLength(1);
    secondInstance[0]!();
    expect(calls).toContain("ensure-visible");
  });

  test("the client's setup runs after the classic composition on the classic platforms", async () => {
    let ran = false;
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
      setup: () => {
        ran = true;
      },
    });

    await drain();

    expect(ran).toBe(true);
    if (process.platform === "darwin") {
      // The classic-only tail is skipped; the client's own setup follows
      // the shared composition directly.
      expect(calls).toEqual(universalSurface);
      return;
    }
    expect(calls).toEqual([
      ...universalSurface,
      ...classicSurface,
      // The companion's initial sync runs once the shell's own setup is done.
      "companion-sync",
    ]);
  });

  test("reports a failed setup as `[app] whenReady setup failed`", async () => {
    const boom = new Error("install blew up");
    startApp({
      platform: "test-electron",
      titleBarMode: "hidden",
      interfaceId: "test",
      setup: () => {
        throw boom;
      },
    });

    await drain();

    const failure = logCalls.find(
      ([level, message]) =>
        level === "error" && message === "[app] whenReady setup failed:",
    );
    expect(failure).toBeDefined();
    expect(failure![2]).toBe(boom);
  });
});
