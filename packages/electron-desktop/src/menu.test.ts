import { describe, expect, mock, test } from "bun:test";

import type { CliPathMenuState } from "./menu";
import { electronMock } from "../test-setup";

const sent: unknown[] = [];
const builtTemplates: unknown[][] = [];

const electronApp = {
  isPackaged: true,
  name: "Cadet",
  getVersion: () => "0.0.0",
};
const popups: Array<{
  template: unknown;
  options: { x: number; y: number; window: unknown };
}> = [];

mock.module("electron", () =>
  electronMock({
    app: electronApp,
    BrowserWindow: {
      getFocusedWindow: () => ({
        webContents: { send: (...args: unknown[]) => sent.push(args) },
      }),
      getAllWindows: () => [],
      fromWebContents: () => ({ isDestroyed: () => false }),
    },
    Menu: {
      buildFromTemplate: (template: unknown) => {
        builtTemplates.push(template as never);
        return {
          template,
          popup: (options: {
            x: number;
            y: number;
            window: unknown;
            callback: () => void;
          }) => {
            popups.push({ template, options });
            options.callback();
          },
        };
      },
      setApplicationMenu: () => undefined,
    },
    // The shared ipc registrar needs the main-process surface at import time.
    ipcMain: {
      handle: () => undefined,
      handleOnce: () => undefined,
      on: () => undefined,
      removeHandler: () => undefined,
    },
    shell: { openExternal: () => Promise.resolve() },
    // The command graph's palette module links `screen` for its positioning;
    // no test here drives a palette window, so the bindings need only exist.
    screen: {
      getDisplayMatching: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getDisplayNearestPoint: () => ({
        workArea: { x: 0, y: 0, width: 1920, height: 1080 },
      }),
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
    },
  }),
);

// The menu reads every one of these states itself now: the session token,
// the onboarding flag, the companion hidden flag, and the CLI wrapper's
// install state. Tests flip the mocks, never the menu.
let sessionToken: string | null = null;
let onboardingActive = false;
let chromeDevTools = false;
let companionHidden = false;
let cliPathState: CliPathMenuState = { kind: "not-installed" };

const sessionTokenListeners: Array<() => void> = [];
const onboardingListeners: Array<(active: boolean) => void> = [];
const companionHiddenListeners: Array<() => void> = [];

mock.module("./settings", () => ({
  createAppSettingsStore: () => undefined,
  readSetting: () => ({}),
  writeSetting: () => undefined,
  onSettingChange: () => () => undefined,
}));
mock.module("./session-token-store", () => ({
  getSessionToken: () => sessionToken,
  onSessionTokenChange: (listener: () => void) => {
    sessionTokenListeners.push(listener);
    return () => undefined;
  },
}));
mock.module("./window-state", () => ({
  readOnboardingActive: () => onboardingActive,
  onOnboardingChange: (listener: (active: boolean) => void) => {
    onboardingListeners.push(listener);
    return () => undefined;
  },
  readCompanionHidden: () => companionHidden,
  onCompanionHiddenChange: (listener: () => void) => {
    companionHiddenListeners.push(listener);
    return () => undefined;
  },
  // The main window's surface, now in this graph since the unrolled
  // command-palette module imports it directly.
  readTitleBarOverlayTheme: () => undefined,
  writeTitleBarOverlayTheme: () => undefined,
  restoreBounds: () => ({ width: 1280, height: 800 }),
  setOnboarding: () => undefined,
  track: () => undefined,
}));
mock.module("./devtools", () => ({
  areChromeDevToolsEnabled: () => chromeDevTools,
}));
// The updates rows hold the real module's checkForUpdates; the updater's
// own surface is stubbed because nothing here drives a check.
mock.module("electron-updater", () => ({
  autoUpdater: {
    checkForUpdates: () => Promise.resolve({ downloadPromise: null }),
    logger: null,
    autoDownload: false,
    autoInstallOnAppQuit: false,
    channel: "",
    allowDowngrade: false,
    setFeedURL: () => undefined,
    on: () => undefined,
    quitAndInstall: () => undefined,
  },
}));
// The CLI family, per platform, exactly as the shells' modules answer.
const cliFlowCalls: string[] = [];
mock.module("./cli-path-installer", () => ({
  getCliPathInstallState: async () => cliPathState,
}));
mock.module("./cli-path-flow", () => ({
  isCliPathFlowInFlight: () => false,
  runInstallCliCommandFlow: async () => {
    cliFlowCalls.push("install");
  },
  runUninstallCliCommandFlow: async () => {
    cliFlowCalls.push("uninstall");
  },
}));
mock.module("./win32-cli/cli-path-flow", () => ({
  runInstallCliCommandFlow: async () => {
    cliFlowCalls.push("launcher-install");
  },
}));

// The shared ipc registrar is captured so tests invoke the menu's channels
// the way a validated IPC message would.
type Handler = (args: unknown[], event: unknown) => unknown;
const handlers = new Map<string, Handler>();
mock.module("./ipc", () => ({
  handle: (channel: string, _schema: unknown, fn: Handler) => {
    handlers.set(channel, fn);
  },
  handleSync: () => undefined,
  on: () => undefined,
}));

const {
  buildDesktopMenu,
  installDesktopMenu,
  refreshDesktopMenuCliPath,
  setDesktopHasCloudSession,
} = await import("./menu");

type MenuItem = Record<string, unknown>;

const submenu = (label: string): Array<Record<string, unknown>> =>
  (buildDesktopMenu().find((entry) => entry.label === label)?.submenu ??
    []) as Array<Record<string, unknown>>;

const enabled = (menu: string, label: string): unknown =>
  submenu(menu).find((item) => item.label === label)?.enabled;

const labels = (items: MenuItem[]): string[] =>
  items
    .map((item) => item.label ?? item.role)
    .filter((l): l is string => typeof l === "string");

const submenuOf = (template: MenuItem[], label: string): MenuItem[] =>
  (template.find((i) => i.label === label)?.submenu ?? []) as MenuItem[];

describe("buildDesktopMenu", () => {
  test("uses Window roles; the session token drives the Log In/Log Out toggle", () => {
    const label = (): string =>
      (submenu("File").find((item) =>
        ["Log In", "Log Out"].includes(String(item.label)),
      )?.label ?? "") as string;

    sessionToken = "token";
    setDesktopHasCloudSession();
    expect(label()).toBe("Log Out");
    sessionToken = null;
    setDesktopHasCloudSession();
    expect(label()).toBe("Log In");
  });

  test("wires every provider it offers: updates, install row, commands", () => {
    const updatesRow = submenu("Help").find(
      (item) => item.label === "Check for Updates...",
    );
    expect(typeof updatesRow?.click).toBe("function");
    expect(enabled("File", "Install cadet Command...")).toBe(true);
    expect(enabled("Window", "Pop Out Conversation")).toBeUndefined();
  });

  test("gates Settings on onboarding and devtools on the flag", () => {
    expect(enabled("File", "Settings...")).toBe(true);
    expect(submenu("View").some((item) => item.role === "toggleDevTools")).toBe(
      false,
    );

    onboardingActive = true;
    chromeDevTools = true;
    try {
      expect(enabled("File", "Settings...")).toBe(false);
      expect(
        submenu("View").some((item) => item.role === "toggleDevTools"),
      ).toBe(true);
    } finally {
      onboardingActive = false;
      chromeDevTools = false;
    }
  });

  test("dispatches committed commands to the focused window", () => {
    const item = submenu("File").find(
      (entry) => entry.label === "New Conversation",
    );
    (item?.click as (() => void) | undefined)?.();
    expect(sent).toEqual([["cadet:command", { kind: "newConversation" }]]);
  });

  test("the View menu carries the shared history rows", () => {
    const rows = submenu("View").map((item) => String(item.label));
    expect(rows).toContain("Back");
    expect(rows).toContain("Forward");
  });
});

describe("installDesktopMenu", () => {
  installDesktopMenu();

  test("reports the top-level menu ids and labels", () => {
    const titles = handlers.get("cadet:menu:titles")?.([], {});
    expect(titles).toEqual([
      // The app menu prepends on every platform — Electron no-ops the
      // `appMenu` role where it doesn't apply.
      { id: "undefined", label: "Cadet" },
      { id: "file", label: "File" },
      { id: "edit", label: "Edit" },
      { id: "view", label: "View" },
      { id: "window", label: "Window" },
      { id: "help", label: "Help" },
    ]);
  });

  test("pops the requested submenu at zoom-scaled coordinates", async () => {
    await handlers.get("cadet:menu:popup")?.(["edit", 100, 44], {
      sender: { getZoomFactor: () => 1.25 },
    });
    expect(popups).toHaveLength(1);
    expect(popups[0]?.options.x).toBe(125);
    expect(popups[0]?.options.y).toBe(55);
    expect(popups[0]?.options.window).toBeDefined();
    const items = popups[0]?.template as Array<Record<string, unknown>>;
    expect(items.some((item) => item.role === "undo")).toBe(true);
  });

  test("ignores popups for unknown ids", async () => {
    await handlers.get("cadet:menu:popup")?.(["nope", 0, 0], {
      sender: { getZoomFactor: () => 1 },
    });
    expect(popups).toHaveLength(1);
  });

  test("re-applies when the session token store announces a change", () => {
    // The subscription is the menu's own wiring: the shells never carry it.
    sessionToken = "token";
    for (const listener of sessionTokenListeners) listener();
    expect(submenu("File").some((item) => item.label === "Log Out")).toBe(true);
    sessionToken = null;
    setDesktopHasCloudSession();
  });

  test("re-applies when onboarding flips", () => {
    onboardingActive = true;
    for (const listener of onboardingListeners) listener(true);
    expect(enabled("File", "Settings...")).toBe(false);
    onboardingActive = false;
  });
});

// ---------------------------------------------------------------------------
// The one template serves every platform — the tests stamp the platform only
// where the CLI rows' state flows through it. The app menu prepends
// everywhere, the Window menu carries the companion rows everywhere.
// ---------------------------------------------------------------------------
describe("buildDesktopMenu (shared template)", () => {
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value });

  const appSubmenuShadowed = (): MenuItem | undefined => {
    const rows = ((builtTemplates.at(-1) as MenuItem[])?.[0]?.submenu ??
      []) as MenuItem[];
    return rows.find(
      (i) => i.label === "⚠ cadet is shadowed by another install",
    );
  };

  const withPlatform = (
    platform: string,
    run: () => void | Promise<void>,
  ): Promise<void> => {
    const original = process.platform;
    setPlatform(platform);
    try {
      return Promise.resolve(run()).finally(() => setPlatform(original));
    } catch (err) {
      setPlatform(original);
      throw err;
    }
  };

  test("prepends the app menu with About, updates, Settings, and roles", () => {
    const rows = labels((buildDesktopMenu()[0]?.submenu ?? []) as MenuItem[]);
    expect(rows[0]).toBe("About Cadet");
    expect(rows).toContain("Check for Updates…");
    expect(rows).toContain("Settings…");
    expect(rows).toContain("Log In");
    expect(rows).toContain("services");
    expect(rows).toContain("hide");
    expect(rows).toContain("quit");
  });

  test("carries the session tail in the File menu on every platform", () => {
    const fileRows = labels(
      submenuOf(buildDesktopMenu() as MenuItem[], "File"),
    );
    expect(fileRows).toContain("New Conversation");
    // The session tail — Settings, the Log In/Out toggle, the quit role —
    // is the same tail on all three platforms now.
    expect(fileRows).toContain("Log In");
    expect(fileRows).toContain("quit");
  });

  test("keeps the role's own fullscreen chord, zoom and close roles, and the companion rows", () => {
    const template = buildDesktopMenu() as MenuItem[];
    const viewSubmenu = submenuOf(template, "View");
    // No accelerator override: the role assigns each platform's own default
    // (Control+Command+F on macOS, F11 elsewhere).
    expect(viewSubmenu.find((i) => i.role === "togglefullscreen")).toEqual({
      role: "togglefullscreen",
    });
    const windowSubmenu = submenuOf(template, "Window");
    expect(windowSubmenu.some((i) => i.role === "zoom")).toBe(true);
    expect(windowSubmenu.some((i) => i.role === "close")).toBe(true);
    // The tail is the menu's own rows now: the companion checkbox built
    // from the shared state, then the front role.
    expect(windowSubmenu.some((i) => i.label === "Show Companion")).toBe(true);
    expect(windowSubmenu.some((i) => i.role === "front")).toBe(true);
  });

  test("renders the CLI rows from the wrapper family's state", async () => {
    await withPlatform("darwin", async () => {
      installDesktopMenu();
      const appRows = (): string[] =>
        labels(
          ((builtTemplates.at(-1) as MenuItem[])?.[0]?.submenu ??
            []) as MenuItem[],
        );

      // Unknown/not-installed/foreign → the Install row.
      cliPathState = { kind: "not-installed" };
      await refreshDesktopMenuCliPath();
      let rows = appRows();
      expect(rows).toContain("Install cadet Command…");
      expect(rows).not.toContain("Uninstall cadet Command");

      // Installed with a ready runtime → Uninstall only.
      cliPathState = { kind: "installed", inPath: true, runtimeReady: true };
      await refreshDesktopMenuCliPath();
      rows = appRows();
      expect(rows).toContain("Uninstall cadet Command");
      expect(rows).not.toContain("Install cadet Command…");
      expect(rows).not.toContain("Repair cadet Command…");

      // A missing runtime offers Repair alongside Uninstall.
      cliPathState = { kind: "installed", inPath: true, runtimeReady: false };
      await refreshDesktopMenuCliPath();
      rows = appRows();
      expect(rows).toContain("Repair cadet Command…");
      expect(rows).toContain("Uninstall cadet Command");

      // Shadowed installs say so, disabled.
      cliPathState = {
        kind: "shadowed",
        shadowedBy: "/usr/local/bin/cadet",
        inPath: true,
        runtimeReady: true,
      };
      await refreshDesktopMenuCliPath();
      const shadowed = appRows() && appSubmenuShadowed();
      expect(shadowed?.enabled).toBe(false);
    });
  });

  test("unpackaged builds render no CLI rows and never detect", () =>
    withPlatform("darwin", () => {
      electronApp.isPackaged = false;
      try {
        const rows = labels(
          (buildDesktopMenu()[0]?.submenu ?? []) as MenuItem[],
        );
        expect(rows).not.toContain("Install cadet Command…");
        expect(rows).not.toContain("Uninstall cadet Command");
      } finally {
        electronApp.isPackaged = true;
      }
    }));

  test("re-applies when the companion surface's hidden flag moves", () =>
    withPlatform("darwin", () => {
      installDesktopMenu();
      companionHidden = true;
      for (const listener of companionHiddenListeners) listener();
      const windowSubmenu = submenu("Window");
      expect(
        windowSubmenu.some((item) => item.label === "Show Companion"),
      ).toBe(true);
      const checkbox = windowSubmenu.find(
        (item) => item.label === "Show Companion",
      );
      expect(checkbox?.checked).toBe(false);
      companionHidden = false;
    }));
});
