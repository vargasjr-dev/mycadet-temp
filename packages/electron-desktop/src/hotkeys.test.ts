import { beforeEach, describe, expect, mock, test } from "bun:test";

import { electronMock, recordedIpcHandlers } from "../test-setup";

let hotkeys: Record<string, string> = {};
let listener: (() => void) | null = null;

// The handlers ride the shared registrar, whose `ipcMain.handle` the shared
// surface records; tests invoke the recorded wrappers directly. The
// sender-origin guard and schema parsing inside the registrar are covered
// by `ipc.test.ts`; here we drive the handler bodies.
// `./hotkeys` (via `./commands`) imports `BrowserWindow` from electron; stub
// the surface the broadcast path touches.
mock.module("electron", () =>
  electronMock({
    BrowserWindow: { getAllWindows: () => [] },
  }),
);

const { resolveHotkeyCatalog, installHotkeysIpc, __resetForTesting } =
  await import("./hotkeys");
const { configureHotkeySettings } = await import("./commands");

// The IPC wrapper rejects any sender whose frame origin isn't the app
// renderer's; the fake sender derives from the guard's own resolver.
const { protocol: allowedProtocol, host: allowedHost } =
  await import("./app-origin").then(({ resolveAllowedOrigin }) =>
    resolveAllowedOrigin(),
  );
const allowedEvent = {
  senderFrame: { origin: `${allowedProtocol}//${allowedHost}` },
};

const invoke = (channel: string, args: unknown[]): unknown => {
  const handler = recordedIpcHandlers.get(channel);
  if (!handler) throw new Error(`No handler for ${channel}`);
  return handler(allowedEvent, ...args);
};

beforeEach(() => {
  hotkeys = {};
  listener = null;
  configureHotkeySettings({
    read: () => hotkeys,
    write: (next) => {
      hotkeys = next;
      listener?.();
    },
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = null;
      };
    },
  });
  recordedIpcHandlers.clear();
  __resetForTesting();
});

describe("installHotkeysIpc with no platform exclusions", () => {
  test("darwin offers every command — no shell excludes any", () => {
    // There are no exclusions, platform-internal or caller-passed: every
    // shell offers the full catalog. Stamp darwin and reinstall to pin the
    // rule where the old macOS Talk exclusion used to bite.
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      __resetForTesting();
      installHotkeysIpc();

      const catalog = invoke("cadet:hotkeys:get", []) as Array<{ key: string }>;
      expect(catalog.map((c) => c.key)).toContain("toggleVoice");
      expect(() =>
        invoke("cadet:hotkeys:set", ["toggleVoice", "CmdOrCtrl+Shift+T"]),
      ).not.toThrow();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
      __resetForTesting();
    }
  });
});

describe("resolveHotkeyCatalog", () => {
  test("returns every rebindable command with its compiled default", () => {
    const catalog = resolveHotkeyCatalog();
    expect(catalog.filter((c) => c.rebindable).map((c) => c.key)).toEqual([
      "globalHotkey",
      "quickInput",
      "toggleVoice",
      "newConversation",
      "currentConversation",
      "markCurrentUnread",
      "togglePinConversation",
      "sidebarToggle",
      "popOut",
      "previousConversation",
      "nextConversation",
    ]);

    const newConversation = catalog.find((c) => c.key === "newConversation");
    expect(newConversation?.defaultAccelerator).toBe("CmdOrCtrl+N");
    expect(newConversation?.override).toBeNull();
    expect(newConversation?.accelerator).toBe("CmdOrCtrl+N");
    expect(newConversation?.rebindable).toBe(true);
  });

  test("includes reserved, non-rebindable accelerators for conflict checks", () => {
    const find = resolveHotkeyCatalog().find((c) => c.key === "find");
    expect(find?.rebindable).toBe(false);
    expect(find?.accelerator).toBe("CmdOrCtrl+F");
  });

  test("drops a reserved command whose accelerator the user disabled", () => {
    hotkeys = { find: "" };
    const catalog = resolveHotkeyCatalog();
    expect(catalog.some((c) => c.key === "find")).toBe(false);
  });

  test("reflects a custom override in the effective accelerator", () => {
    hotkeys = { newConversation: "CmdOrCtrl+Alt+T" };
    const entry = resolveHotkeyCatalog().find(
      (c) => c.key === "newConversation",
    );
    expect(entry?.override).toBe("CmdOrCtrl+Alt+T");
    expect(entry?.accelerator).toBe("CmdOrCtrl+Alt+T");
  });

  test("treats an empty-string override as a disabled binding", () => {
    hotkeys = { globalHotkey: "" };
    const entry = resolveHotkeyCatalog().find((c) => c.key === "globalHotkey");
    expect(entry?.override).toBe("");
    expect(entry?.accelerator).toBe("");
    expect(entry?.defaultAccelerator).toBe("CmdOrCtrl+Shift+G");
  });
});

describe("cadet:hotkeys:set", () => {
  beforeEach(() => {
    installHotkeysIpc();
  });

  test("persists a valid accelerator, merging into existing overrides", () => {
    hotkeys = { popOut: "CmdOrCtrl+Shift+O" };
    invoke("cadet:hotkeys:set", ["newConversation", "CmdOrCtrl+Alt+T"]);
    expect(hotkeys).toEqual({
      popOut: "CmdOrCtrl+Shift+O",
      newConversation: "CmdOrCtrl+Alt+T",
    });
  });

  test("stores an empty string to disable a binding", () => {
    invoke("cadet:hotkeys:set", ["globalHotkey", ""]);
    expect(hotkeys).toEqual({ globalHotkey: "" });
  });

  test("clears an override when passed null", () => {
    hotkeys = {
      newConversation: "CmdOrCtrl+Alt+T",
      popOut: "CmdOrCtrl+Shift+O",
    };
    invoke("cadet:hotkeys:set", ["newConversation", null]);
    expect(hotkeys).toEqual({ popOut: "CmdOrCtrl+Shift+O" });
  });

  test("rejects an invalid accelerator without writing", () => {
    expect(() =>
      invoke("cadet:hotkeys:set", ["newConversation", "NotAModifier+Q+Z"]),
    ).toThrow(/invalid accelerator/i);
    expect(hotkeys).toEqual({});
  });

  test("rejects an unknown command key without writing", () => {
    expect(() =>
      invoke("cadet:hotkeys:set", ["openSettings", "CmdOrCtrl+,"]),
    ).toThrow(/unknown hotkey command/i);
    expect(hotkeys).toEqual({});
  });
});
