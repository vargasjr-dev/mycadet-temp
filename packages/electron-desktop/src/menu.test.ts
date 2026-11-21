import { describe, expect, mock, test } from "bun:test";

import type { CliPathMenuState } from "./menu";

const sent: unknown[] = [];
const builtTemplates: unknown[][] = [];

const electronApp = { isPackaged: true, name: "Cadet" };
const popups: Array<{
  template: unknown;
  options: { x: number; y: number; window: unknown };
}> = [];

mock.module("electron", () => ({
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
}));

let onboardingActive = false;
let chromeDevTools = false;
mock.module("./settings", () => ({
  createAppSettingsStore: () => undefined,
  readSetting: () => ({}),
  writeSetting: () => undefined,
  onSettingChange: () => () => undefined,
}));
mock.module("./window-state", () => ({
  readOnboardingActive: () => onboardingActive,
}));
mock.module("./devtools", () => ({
  areChromeDevToolsEnabled: () => chromeDevTools,
}));

const {
  buildDesktopMenu,
  installDesktopMenu,
  refreshDesktopMenuCliPath,
  setDesktopHasCloudSession,
} = await import("./menu");

test("the Log In/Log Out toggle follows the published session fact", () => {
  const label = (): string =>
    (submenu("File").find((item) =>
      ["Log In", "Log Out"].includes(String(item.label)),
    )?.label ?? "") as string;

  setDesktopHasCloudSession(true);
  expect(label()).toBe("Log Out");
  setDesktopHasCloudSession(false);
  expect(label()).toBe("Log In");
});

type MenuOptions = Parameters<typeof buildDesktopMenu>[0];

const submenu = (
  label: string,
  options: MenuOptions = { openAbout: () => undefined },
): Array<Record<string, unknown>> => {
  const item = buildDesktopMenu(options).find((entry) => entry.label === label);
  return item?.submenu as Array<Record<string, unknown>>;
};

const enabled = (menu: string, label: string, options?: MenuOptions): unknown =>
  submenu(menu, options).find((item) => item.label === label)?.enabled;

describe("buildDesktopMenu", () => {
  test("uses Window roles and disables unavailable providers", () => {
    expect(submenu("Window").some((item) => item.role === "close")).toBe(true);
    expect(enabled("Help", "Check for Updates...")).toBe(false);
    expect(enabled("File", "Install cadet Command...")).toBe(false);
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

  test("enables update and CLI items when handlers are provided", () => {
    const options = {
      openAbout: () => undefined,
      checkForUpdates: () => undefined,
      installCli: () => undefined,
    };
    expect(enabled("Help", "Check for Updates...", options)).toBe(true);
    expect(enabled("File", "Install cadet Command...", options)).toBe(true);
  });

  test("dispatches committed commands to the focused window", () => {
    const item = submenu("File").find(
      (entry) => entry.label === "New Conversation",
    );
    (item?.click as (() => void) | undefined)?.();
    expect(sent).toEqual([["cadet:command", { kind: "newConversation" }]]);
  });

  test("the View menu carries the shared history rows", () => {
    const labels = submenu("View").map((item) => String(item.label));
    expect(labels).toContain("Back");
    expect(labels).toContain("Forward");
  });
});

describe("installDesktopMenu", () => {
  type Handler = (args: unknown[], event: unknown) => unknown;
  const handlers = new Map<string, Handler>();
  installDesktopMenu({
    handle: ((channel: string, _schema: unknown, fn: Handler) => {
      handlers.set(channel, fn);
    }) as never,
    openAbout: () => undefined,
  });

  test("reports the top-level menu ids and labels", () => {
    const titles = handlers.get("cadet:menu:titles")?.([], {});
    expect(titles).toEqual([
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
});

// ---------------------------------------------------------------------------
// macOS: the app menu rides the same template. The module reads the platform
// per call, so tests stamp it; the CLI rows are driven through the `cliPath`
// dep exactly as the client passes its installer's state.
// ---------------------------------------------------------------------------
describe("buildDesktopMenu (macOS)", () => {
  const setPlatform = (value: string) =>
    Object.defineProperty(process, "platform", { value });

  type MenuItem = Record<string, unknown>;
  const macOptions = () => ({
    openAbout: () => undefined,
    checkForUpdates: () => undefined,
  });

  const cliPath = () => ({
    state: async () => ({ kind: "not-installed" }) as CliPathMenuState,
    inFlight: () => false,
    install: () => Promise.resolve(),
    uninstall: () => Promise.resolve(),
  });

  const appSubmenuShadowed = (): MenuItem | undefined => {
    const submenu = ((builtTemplates.at(-1) as MenuItem[])?.[0]?.submenu ??
      []) as MenuItem[];
    return submenu.find(
      (i) => i.label === "⚠ cadet is shadowed by another install",
    );
  };

  const labels = (items: MenuItem[]): string[] =>
    items
      .map((item) => item.label ?? item.role)
      .filter((l): l is string => typeof l === "string");

  const submenuOf = (template: MenuItem[], label: string): MenuItem[] =>
    (template.find((i) => i.label === label)?.submenu ?? []) as MenuItem[];

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

  test("prepends the app menu with About, updates, Settings, and roles", () =>
    withPlatform("darwin", () => {
      const rows = labels(
        (buildDesktopMenu(macOptions())[0]?.submenu ?? []) as MenuItem[],
      );
      expect(rows[0]).toBe("About Cadet");
      expect(rows).toContain("Check for Updates…");
      expect(rows).toContain("Settings…");
      expect(rows).toContain("Log In");
      expect(rows).toContain("services");
      expect(rows).toContain("hide");
      expect(rows).toContain("quit");
    }));

  test("keeps the File menu free of the session tail on macOS", () =>
    withPlatform("darwin", () => {
      const fileRows = labels(
        submenuOf(buildDesktopMenu(macOptions()) as MenuItem[], "File"),
      );
      expect(fileRows).not.toContain("Settings…");
      expect(fileRows).not.toContain("Log In");
      expect(fileRows).not.toContain("quit");
      expect(fileRows).toContain("New Conversation");
    }));

  test("applies the mac fullscreen chord, zoom role, and Window tail", () =>
    withPlatform("darwin", () => {
      const template = buildDesktopMenu({
        ...macOptions(),
        windowMenuTail: [{ label: "Front Row", role: "front" }],
      }) as MenuItem[];
      const viewSubmenu = submenuOf(template, "View");
      expect(viewSubmenu.find((i) => i.role === "togglefullscreen")).toEqual({
        role: "togglefullscreen",
        accelerator: "Control+Command+F",
      });
      const windowSubmenu = submenuOf(template, "Window");
      expect(windowSubmenu.some((i) => i.role === "zoom")).toBe(true);
      expect(windowSubmenu.some((i) => i.label === "Front Row")).toBe(true);
    }));

  test("drops the update rows from Help on macOS (the app menu owns them)", () =>
    withPlatform("darwin", () => {
      const helpRows = labels(
        submenuOf(buildDesktopMenu(macOptions()) as MenuItem[], "Help"),
      );
      expect(helpRows).not.toContain("Check for Updates...");
    }));

  test("renders the CLI rows from the cliPath dep's state", async () => {
    await withPlatform("darwin", async () => {
      let state: CliPathMenuState = { kind: "not-installed" };
      installDesktopMenu({
        handle: (() => undefined) as never,
        openAbout: () => undefined,
        cliPath: {
          state: async () => state,
          inFlight: () => false,
          install: () => Promise.resolve(),
          uninstall: () => Promise.resolve(),
        },
      });
      const appRows = (): string[] =>
        labels(
          ((builtTemplates.at(-1) as MenuItem[])?.[0]?.submenu ??
            []) as MenuItem[],
        );

      // Unknown/not-installed/foreign → the Install row.
      state = { kind: "not-installed" };
      await refreshDesktopMenuCliPath();
      let rows = appRows();
      expect(rows).toContain("Install cadet Command…");
      expect(rows).not.toContain("Uninstall cadet Command");

      // Installed with a ready runtime → Uninstall only.
      state = { kind: "installed", inPath: true, runtimeReady: true };
      await refreshDesktopMenuCliPath();
      rows = appRows();
      expect(rows).toContain("Uninstall cadet Command");
      expect(rows).not.toContain("Install cadet Command…");
      expect(rows).not.toContain("Repair cadet Command…");

      // A missing runtime offers Repair alongside Uninstall.
      state = { kind: "installed", inPath: true, runtimeReady: false };
      await refreshDesktopMenuCliPath();
      rows = appRows();
      expect(rows).toContain("Repair cadet Command…");
      expect(rows).toContain("Uninstall cadet Command");

      // Shadowed installs say so, disabled.
      state = {
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
        let detections = 0;
        const options = {
          ...macOptions(),
          cliPath: {
            ...cliPath(),
            state: async () => {
              detections += 1;
              return { kind: "not-installed" } as CliPathMenuState;
            },
          },
        } as Parameters<typeof buildDesktopMenu>[0];
        const rows = labels(
          (buildDesktopMenu(options)[0]?.submenu ?? []) as MenuItem[],
        );
        expect(rows).not.toContain("Install cadet Command…");
        expect(rows).not.toContain("Uninstall cadet Command");
        expect(detections).toBe(0);
      } finally {
        electronApp.isPackaged = true;
      }
    }));
});
