import { beforeEach, expect, mock, test } from "bun:test";
import { electronMock } from "../../test-setup";
import type { PermissionsShellInputs } from "./permissions";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_REQUEST,
  SYSTEM_PERMISSION_KINDS,
  TEXT_INSERT,
  TEXT_OPEN_SETTINGS,
  type SystemPermissionKind,
  type SystemPermissionStatus,
} from "@mycadet/ipc-contract";

type Handler = (args: unknown[]) => unknown;

// The per-OS arm, as a test knob: install resolves the shell inputs
// internally now, so the tests stage what the strategy should answer.
let strategyInputs: PermissionsShellInputs = {};
mock.module("./permissions-strategy", () => ({
  permissionsStrategy: () => strategyInputs,
  describeError: (err: unknown): string =>
    err instanceof Error ? err.message : String(err),
}));

const handlers = new Map<string, Handler>();
const openExternal = mock(async () => undefined);
const mediaStatus = mock((_kind: string): string => "granted");
let notificationOutcome: "show" | "failed" = "show";

class FakeNotification {
  static isSupported = () => true;
  private listeners = new Map<string, () => void>();
  once(event: string, listener: () => void) {
    this.listeners.set(event, listener);
    return this;
  }
  show() {
    this.listeners.get(notificationOutcome)?.();
  }
}
const defaultHelperCall = async (method: string): Promise<unknown> => {
  if (method === "permissions.state") {
    return {
      microphone: "granted",
      speechRecognition: "denied",
      notifications: "granted",
    };
  }
  return { status: "inserted", reason: null };
};
const helperCall = mock(defaultHelperCall);

let onFocus: (() => void) | null = null;

mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      on: mock((event: string, listener: () => void) => {
        if (event === "browser-window-focus") {
          onFocus = listener;
        }
      }),
      quit: mock(() => undefined),
      relaunch: mock(() => undefined),
    },
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    shell: { openExternal },
    systemPreferences: { getMediaAccessStatus: mediaStatus },
    Notification: FakeNotification,
  }),
);
mock.module("../ipc", () => ({
  handle: (channel: string, _schema: unknown, handler: Handler) => {
    handlers.set(channel, handler);
  },
}));
mock.module("../app-logger", () => ({
  getLogFilePaths: () => [],
  default: { warn: mock(() => undefined) },
}));
mock.module("../main-window", () => ({ current: () => null }));
mock.module("../native-helper-client", () => ({
  getSharedHelperClient: () => ({ call: helperCall }),
}));

const { install: permissionsInstall } = await import("../features/permissions");

// The Windows shell's own deep links, passed as values — the feature never
// derives an OS.
const WINDOWS_SETTINGS_URIS: Partial<Record<SystemPermissionKind, string>> = {
  screen: "ms-settings:privacy-graphicscaptureprogrammatic",
  microphone: "ms-settings:privacy-microphone",
  speechRecognition: "ms-settings:privacy-speech",
  notifications: "ms-settings:notifications",
  automation: "ms-settings:privacy",
};

beforeEach(() => {
  handlers.clear();
  helperCall.mockReset();
  helperCall.mockImplementation(defaultHelperCall);
  openExternal.mockClear();
  mediaStatus.mockReset();
  mediaStatus.mockImplementation(() => "granted");
  notificationOutcome = "show";
  strategyInputs = { settingsUris: WINDOWS_SETTINGS_URIS };
  permissionsInstall();
});

test("statuses come from the app's own reads; insertion rides the helper", async () => {
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    {
      microphone: { status: "granted" },
      speechRecognition: { status: "unknown" },
      notifications: { status: "unknown" },
    },
  );
  await expect(handlers.get(TEXT_INSERT)!(["hello"])).resolves.toEqual({
    status: "inserted",
  });

  expect(helperCall).not.toHaveBeenCalledWith("permissions.state");
  expect(helperCall).toHaveBeenCalledWith("text.insert", { text: "hello" });
});

test("reports kinds without an OS answer as not-applicable and opens screen capture settings", async () => {
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    {
      accessibility: { status: "not-applicable" },
      screen: {
        status: "unknown",
        canOpenSettings: true,
      },
      inputMonitoring: { status: "not-applicable" },
      automation: { status: "not-applicable", canOpenSettings: true },
    },
  );

  await handlers.get(PERMISSIONS_OPEN_SETTINGS)!(["screen"]);

  expect(mediaStatus).not.toHaveBeenCalledWith("screen");
  expect(openExternal).toHaveBeenCalledWith(
    "ms-settings:privacy-graphicscaptureprogrammatic",
  );
});

test("reports the shell's screen capture consent with a settings link", async () => {
  strategyInputs = {
    ...strategyInputs,
    readStatus: async (kind) => (kind === "screen" ? "denied" : undefined),
  };
  handlers.clear();
  permissionsInstall();
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { screen: { status: "denied", canRequest: false, canOpenSettings: true } },
  );
});

test("requests notifications by probing instead of opening settings", async () => {
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "unknown", canRequest: true } },
  );

  notificationOutcome = "failed";
  await expect(
    handlers.get(PERMISSIONS_REQUEST)!(["notifications"]),
  ).resolves.toMatchObject({ status: "denied", canOpenSettings: true });
  expect(openExternal).not.toHaveBeenCalled();

  // The probe's answer stands in later reads, not just the request's.
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "denied" } },
  );
});

test("regaining focus drops the notification probe result", async () => {
  // The real shell read mirrors the OS: it answers denied while the toggle
  // is off, granted once the user flips it. The probe only supersedes a
  // read until focus resets it.
  let shellNotificationsStatus: SystemPermissionStatus = "denied";
  strategyInputs = {
    ...strategyInputs,
    readStatus: async (kind) =>
      kind === "notifications" ? shellNotificationsStatus : undefined,
  };
  handlers.clear();
  permissionsInstall();
  notificationOutcome = "failed";
  await expect(
    handlers.get(PERMISSIONS_REQUEST)!(["notifications"]),
  ).resolves.toMatchObject({ status: "denied" });

  shellNotificationsStatus = "granted";
  onFocus!();
  await expect(handlers.get(PERMISSIONS_GET_STATE)!([])).resolves.toMatchObject(
    { notifications: { status: "granted" } },
  );
});

test("requesting a settings-only kind opens its settings page", async () => {
  await handlers.get(PERMISSIONS_REQUEST)!(["microphone"]);
  expect(openExternal).toHaveBeenCalledWith("ms-settings:privacy-microphone");
});

test("the automation settings request opens the shell's privacy pane", async () => {
  await handlers.get(TEXT_OPEN_SETTINGS)!([]);
  expect(openExternal).toHaveBeenCalledWith("ms-settings:privacy");
});

// The presentation argument degrades rather than rejects: a renderer that
// mangles it still gets its permission request through.
test("a malformed presentation degrades to a plain request", async () => {
  const malformed = {
    presentation: "assistant",
    identity: { scopeId: "scope" },
    sender: { id: "native-a", name: "Alice" },
  };
  await expect(
    handlers.get(PERMISSIONS_REQUEST)!(["notifications", malformed]),
  ).resolves.toMatchObject({ status: "granted" });
});

test("the shell's own reads, requests, and insertion win over the defaults", async () => {
  handlers.clear();
  const reads: SystemPermissionKind[] = [];
  const requested: SystemPermissionKind[] = [];
  const inserted: string[] = [];
  const askedFor: SystemPermissionKind[] = [];
  strategyInputs = {
    settingsUris: { microphone: "shell://mic-pane" },
    readStatus: async (kind) => {
      reads.push(kind);
      return kind === "microphone" ? "denied" : undefined;
    },
    request: async (kind, { refresh }) => {
      requested.push(kind);
      await refresh();
    },
    openSettings: async (kind) => {
      askedFor.push(kind);
    },
    insertText: async (text) => {
      inserted.push(text);
      return { status: "inserted" };
    },
  };
  permissionsInstall();

  const state = (await handlers.get(PERMISSIONS_GET_STATE)!([])) as Record<
    string,
    { status: SystemPermissionStatus; canRequest: boolean }
  >;
  // The shell's answer wins where it gives one; the shared defaults answer
  // where it stays silent.
  expect(state.microphone.status).toBe("denied");
  expect(state.screen.status).toBe("unknown");
  expect(reads.length).toBe(SYSTEM_PERMISSION_KINDS.length);

  await handlers.get(PERMISSIONS_REQUEST)!(["microphone"]);
  expect(requested).toEqual(["microphone"]);

  await handlers.get(PERMISSIONS_OPEN_SETTINGS)!(["screen"]);
  expect(askedFor).toEqual(["screen"]);

  await expect(handlers.get(TEXT_INSERT)!(["hello"])).resolves.toEqual({
    status: "inserted",
  });
  expect(inserted).toEqual(["hello"]);
});

test("a throwing shell read surfaces in the item's error field", async () => {
  handlers.clear();
  strategyInputs = {
    readStatus: async (kind) => {
      if (kind === "screen") {
        throw new Error("consent store unreachable");
      }
      return undefined;
    },
  };
  permissionsInstall();
  const state = (await handlers.get(PERMISSIONS_GET_STATE)!([])) as Record<
    string,
    { status: SystemPermissionStatus; error?: string }
  >;
  expect(state.screen.status).toBe("unknown");
  expect(state.screen.error).toBe("consent store unreachable");
});
