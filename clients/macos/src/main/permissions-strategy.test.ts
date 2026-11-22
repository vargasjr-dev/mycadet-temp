import { beforeEach, describe, expect, mock, test } from "bun:test";
import { electronMock } from "@mycadet/electron-desktop/test-setup";

import type {
  Notifier,
  NotifierAuthorizationResult,
  NotifierRequest,
} from "@mycadet/electron-desktop/notifier";
import {
  SYSTEM_PERMISSION_KINDS,
  type PermissionNotificationPresentation,
  type SystemPermissionKind,
  type SystemPermissionsState,
  type SystemPermissionStatus,
} from "@mycadet/ipc-contract";

// Counted rather than asserted on construction: the whole point of the native
// path is that Electron's presenter is never built, and building it is what
// hands Electron the notification center's delegate.
let electronNotificationsConstructed = 0;
let electronIsSupportedCalls = 0;
let electronSupported = true;
let electronNotificationOptions: {
  title: string;
  body: string;
  silent: boolean;
} | null = null;

type ElectronListener = () => void;

class FakeElectronNotification {
  private listeners = new Map<string, ElectronListener>();

  constructor(options: { title: string; body: string; silent: boolean }) {
    electronNotificationsConstructed += 1;
    electronNotificationOptions = options;
  }

  static isSupported(): boolean {
    electronIsSupportedCalls += 1;
    return electronSupported;
  }

  once(event: string, listener: ElectronListener): this {
    this.listeners.set(event, listener);
    return this;
  }

  show(): void {
    this.listeners.get("show")?.();
  }
}

/** The helper launches and Settings opens, in the order they happened. */
const helperCalls: string[] = [];
let helperScreenStatus = "denied";
let helperInputMonitoringStatus = "denied";

mock.module("electron", () =>
  electronMock({
    app: {
      getVersion: () => "0.0.0",
      getName: () => "Cadet",
      isPackaged: false,
      getPath: () => "/tmp/cadet-permissions-test",
      relaunch: () => undefined,
      quit: () => undefined,
      on: () => undefined,
    },
    BrowserWindow: { getAllWindows: () => [] },
    Notification: FakeElectronNotification,
    shell: {
      openExternal: async (url: string) => {
        helperCalls.push(`open ${url}`);
      },
    },
    systemPreferences: {
      isTrustedAccessibilityClient: () => true,
      askForMediaAccess: async () => {
        helperCalls.push("request microphone");
        return true;
      },
      // The app's own grant, which says nothing about the helper's: granted
      // here so a screen status that followed it would be caught.
      getMediaAccessStatus: () => "granted",
    },
  }),
);

mock.module("@mycadet/electron-desktop/app-logger", () => ({
  getLogFilePaths: () => [],
  default: { info: () => undefined, warn: () => undefined },
}));

mock.module("./appleScriptExecutor", () => ({
  runAppleScript: async () => "",
}));

mock.module("@mycadet/electron-desktop/helper-permissions", () => ({
  queryFreshHelperPermission: async () => "granted",
  queryHelperPermission: async () => helperInputMonitoringStatus,
  requestHelperPermission: async (kind: string) => {
    helperCalls.push(`request ${kind}`);
  },
}));

// The text-insertion flow's helper seams; the strategy's insertText never
// runs in this suite.
mock.module("@mycadet/electron-desktop/helper-hotkeys", () => ({
  readFrontAppFocus: async () => ({
    takesText: true,
    helperAnswered: true,
  }),
  postFrontAppShortcut: async () => "sent",
}));

mock.module("./screen-recording-permission", () => ({
  readScreenRecordingPermission: async () => helperScreenStatus,
}));

let notifier: Notifier | null = null;
let authorizationResult: NotifierAuthorizationResult | null = { granted: true };
let authorizationRequest =
  async (): Promise<NotifierAuthorizationResult | null> => authorizationResult;
let preparedSenderCurrent = true;
let nativeShowError: Error | null = null;
const nativePosts: NotifierRequest[] = [];
const resolveNotificationAvatarPath = mock(() => "/tmp/avatar.png");

mock.module("@mycadet/electron-desktop/notification-avatar-path", () => ({
  resolveNotificationAvatarPath,
}));

mock.module("@mycadet/electron-desktop/notifications", () => ({
  __resetForTesting: () => undefined,
  __setDeliveryTimeoutForTesting: () => undefined,
  CATEGORY_ACTIONS: {},
  NOTIFICATION_CATEGORIES: [],
  configureNotifications: () => undefined,
  createElectronNotification: () => undefined,
  installNotifications: () => undefined,
  isPreparedNotificationSenderCurrent: (identity: { scopeId: string }) =>
    preparedSenderCurrent && /^scope:v1:[a-f0-9]{64}$/.test(identity.scopeId),
}));

mock.module("@mycadet/electron-desktop/notifier", () => ({
  getNotifier: () => notifier,
  isNotifierSupported: () => notifier?.isSupported() ?? false,
  requestNotifierAuthorization: () => authorizationRequest(),
}));

const { permissionsShell } = await import("./permissions-strategy");
const { onPermissionPresentation } =
  await import("@mycadet/electron-desktop/permissions");

const nativeNotifier = (isSupported = true): Notifier => ({
  isSupported: () => isSupported,
  requestAuthorization: () => undefined,
  registerCategories: () => undefined,
  restoreDelegate: () => undefined,
  show: (request) => {
    if (nativeShowError) {
      throw nativeShowError;
    }
    nativePosts.push(request);
  },
});

// The strategy runs inside the shared service, whose refresh feeds the
// item assembly; the fixture mirrors what the real service would read —
// the helper-backed kinds from the same fakes the probes read.
const refresh = async (): Promise<SystemPermissionsState> =>
  Object.fromEntries(
    SYSTEM_PERMISSION_KINDS.map((kind) => [
      kind,
      {
        kind,
        status:
          kind === "screen"
            ? helperScreenStatus
            : kind === "inputMonitoring"
              ? helperInputMonitoringStatus
              : "granted",
        canRequest: false,
        canOpenSettings: false,
        requiresRestart: false,
      },
    ]),
  ) as SystemPermissionsState;

const request = async (
  kind: SystemPermissionKind,
  presentation?: PermissionNotificationPresentation,
): Promise<SystemPermissionStatus> => {
  await permissionsShell.request!(kind, { presentation, refresh });
  return (await permissionsShell.readStatus!(kind))!;
};

const openSettings = async (kind: SystemPermissionKind): Promise<void> => {
  await permissionsShell.openSettings!(kind, { refresh });
};

describe("notification permission requests", () => {
  beforeEach(() => {
    electronNotificationsConstructed = 0;
    electronIsSupportedCalls = 0;
    electronSupported = true;
    electronNotificationOptions = null;
    nativePosts.length = 0;
    notifier = nativeNotifier();
    authorizationResult = { granted: true };
    authorizationRequest = async () => authorizationResult;
    preparedSenderCurrent = true;
    nativeShowError = null;
    resolveNotificationAvatarPath.mockClear();
  });

  test("prompts through the addon and leaves electron.Notification alone", async () => {
    const status = await request("notifications");

    expect(status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(0);
    expect(electronIsSupportedCalls).toBe(0);
  });

  // The Electron probe posts a notification to learn its answer, so a granted
  // permission always ends in a banner; the addon answers without posting one.
  test("posts the same confirmation banner the Electron probe leaves behind", async () => {
    await request("notifications");

    expect(nativePosts.length).toBe(1);
    expect(nativePosts[0]!.body).toBe("Notifications are enabled.");
    expect(nativePosts[0]!.actions).toEqual([]);
    expect(electronNotificationsConstructed).toBe(0);
  });

  test("records a refused prompt as denied", async () => {
    authorizationResult = { granted: false, error: "not authorized" };

    const status = await request("notifications");

    expect(status).toBe("denied");
    expect(electronNotificationsConstructed).toBe(0);
    expect(nativePosts.length).toBe(0);
  });

  test("does not confirm an unknown native authorization outcome", async () => {
    authorizationResult = null;

    const status = await request("notifications");

    expect(status).toBe("unknown");
    expect(nativePosts).toHaveLength(0);
  });

  test("falls back to the Electron probe when the addon cannot notify", async () => {
    notifier = nativeNotifier(false);

    const status = await request("notifications");

    expect(status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
    expect(nativePosts.length).toBe(0);
  });

  test("posts a personalized confirmation for an exact prepared sender", async () => {
    const avatarPng = Buffer.from("avatar-bytes");
    const presentation = {
      presentation: "assistant" as const,
      identity: {
        scopeId: `scope:v1:${"a".repeat(64)}`,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: avatarPng.toString("base64"),
        avatarHash: new Bun.CryptoHasher("sha256")
          .update(avatarPng)
          .digest("hex"),
      },
    };

    const status = await request("notifications", presentation);

    expect(status).toBe("granted");
    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Alice",
      body: "You’re all set. I can send you notifications here.",
      categoryId: "",
      actions: [],
      sender: {
        id: "native-a",
        name: "Alice",
        avatarPngPath: "/tmp/avatar.png",
        conversationId: "native-a",
      },
    });
    expect(nativePosts[0]!.subtitle).toBeUndefined();
  });

  test("degrades to one plain confirmation when the captured scope changes", async () => {
    let settleAuthorization:
      | ((result: NotifierAuthorizationResult) => void)
      | undefined;
    authorizationRequest = () =>
      new Promise((resolve) => {
        settleAuthorization = resolve;
      });
    const presentation = {
      presentation: "assistant" as const,
      identity: {
        scopeId: `scope:v1:${"a".repeat(64)}`,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: Buffer.from("avatar-bytes").toString("base64"),
        avatarHash: "a".repeat(64),
      },
    };

    const pending = permissionsShell.request!("notifications", {
      presentation,
      refresh,
    });
    await Promise.resolve();
    preparedSenderCurrent = false;
    settleAuthorization?.({ granted: true });
    await pending;

    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Cadet",
      body: "Notifications are enabled.",
    });
    expect(nativePosts[0]!.sender).toBeUndefined();
    expect(resolveNotificationAvatarPath).not.toHaveBeenCalled();
  });

  test("keeps a granted result when the confirmation fails", async () => {
    nativeShowError = new Error("notification failed");

    const status = await request("notifications");

    expect(status).toBe("granted");
    expect(nativePosts).toHaveLength(0);
  });

  test("degrades a raw-scope sender to a plain confirmation", async () => {
    const avatarPng = Buffer.from("avatar-bytes");
    const presentation = {
      presentation: "assistant" as const,
      identity: {
        scopeId: "raw-scope",
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: avatarPng.toString("base64"),
        avatarHash: new Bun.CryptoHasher("sha256")
          .update(avatarPng)
          .digest("hex"),
      },
    };

    await request("notifications", presentation);

    expect(nativePosts).toHaveLength(1);
    expect(nativePosts[0]).toMatchObject({
      title: "Cadet",
      body: "Notifications are enabled.",
    });
    expect(nativePosts[0]!.sender).toBeUndefined();
    expect(resolveNotificationAvatarPath).not.toHaveBeenCalled();
  });

  test("keeps the Electron fallback probe plain with a captured sender", async () => {
    notifier = nativeNotifier(false);
    const avatarPng = Buffer.from("avatar-bytes");

    const status = await request("notifications", {
      presentation: "assistant",
      identity: {
        scopeId: `scope:v1:${"a".repeat(64)}`,
        assistantId: "assistant-a",
        nativeSenderId: "native-a",
      },
      sender: {
        id: "native-a",
        name: "Alice",
        avatarBase64: avatarPng.toString("base64"),
        avatarHash: new Bun.CryptoHasher("sha256")
          .update(avatarPng)
          .digest("hex"),
      },
    });

    expect(status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
    expect(electronNotificationOptions).toEqual({
      title: "Cadet",
      body: "Notifications are enabled.",
      silent: false,
    });
    expect(nativePosts).toHaveLength(0);
  });

  test("falls back to the Electron probe when the addon is unavailable", async () => {
    notifier = null;

    const status = await request("notifications");

    expect(status).toBe("granted");
    expect(electronNotificationsConstructed).toBe(1);
  });

  test("reports restricted only when neither path can post", async () => {
    notifier = nativeNotifier(false);
    electronSupported = false;

    const status = await request("notifications");

    expect(status).toBe("restricted");
    expect(electronNotificationsConstructed).toBe(0);
  });
});

describe("permission setup", () => {
  beforeEach(() => {
    helperCalls.length = 0;
    helperScreenStatus = "denied";
    helperInputMonitoringStatus = "denied";
  });

  test("reports the helper's grant, not the app's", async () => {
    const status = await permissionsShell.readStatus!("screen");

    expect(status).toBe("denied");
  });

  test("opens Screen Recording Settings without the native alert", async () => {
    const stop = onPermissionPresentation(() => {
      helperCalls.push("yield tour");
    });
    try {
      await openSettings("screen");
      expect(helperCalls).toEqual([
        "yield tour",
        "open x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
      ]);
    } finally {
      stop();
    }
  });

  test("opens Input Monitoring Settings immediately after a denial", async () => {
    await openSettings("inputMonitoring");

    expect(helperCalls).toEqual([
      "open x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    ]);
  });

  test("requests Input Monitoring before opening Settings when it is not determined", async () => {
    helperInputMonitoringStatus = "not-determined";

    await openSettings("inputMonitoring");
    expect(helperCalls).toEqual(["request inputMonitoring"]);

    helperInputMonitoringStatus = "denied";
    await openSettings("inputMonitoring");
    expect(helperCalls).toEqual([
      "request inputMonitoring",
      "open x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent",
    ]);
  });

  test("does not open Settings for a helper grant that already arrived", async () => {
    helperScreenStatus = "granted";
    await openSettings("screen");
    expect(helperCalls).toEqual([]);
  });

  test("a request asks the helper", async () => {
    helperScreenStatus = "granted";

    const status = await request("screen");

    expect(helperCalls).toEqual(["request screen"]);
    expect(status).toBe("granted");
  });

  test("yields before a native microphone prompt and unsubscribes", async () => {
    const stop = onPermissionPresentation(() => {
      helperCalls.push("yield tour");
    });
    try {
      await request("microphone");
      expect(helperCalls).toEqual(["yield tour", "request microphone"]);
    } finally {
      stop();
    }
    helperCalls.length = 0;
    await request("microphone");
    expect(helperCalls).toEqual(["request microphone"]);
  });
});
