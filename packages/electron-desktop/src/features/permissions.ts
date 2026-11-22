import {
  BrowserWindow,
  Notification,
  app,
  shell,
  systemPreferences,
  type WebContents,
} from "electron";
import { z } from "zod";

import {
  PERMISSIONS_GET_STATE,
  PERMISSIONS_OPEN_SETTINGS,
  PERMISSIONS_QUIT_AND_REOPEN,
  PERMISSIONS_REQUEST,
  PERMISSIONS_STATE_EVENT,
  SYSTEM_PERMISSION_KINDS,
  SYSTEM_PERMISSION_STATUSES,
  TEXT_INSERT,
  TEXT_OPEN_SETTINGS,
  TEXT_UNDO,
  permissionNotificationPresentationSchema,
  type PermissionNotificationPresentation,
  type SystemPermissionKind,
  type SystemPermissionStateItem,
  type SystemPermissionStatus,
  type SystemPermissionsState,
  type TextInsertionResult,
} from "@mycadet/ipc-contract";

import { handle } from "../ipc";
import log from "../app-logger";
import { current } from "../main-window";
import { getSharedHelperClient } from "../native-helper-client";
import { describeError, permissionsStrategy } from "./permissions-strategy";

/**
 * Provider backed by the native helper sidecar (`permissions.state` and
 * `text.insert` RPC methods). Registered at composition time; until a
 * sidecar exists, helper-backed kinds are unavailable instead of faking
 * a status.
 */
export interface PermissionsNativeProvider {
  queryPermissions(): Promise<
    Partial<Record<SystemPermissionKind, SystemPermissionStatus>>
  >;
  insertText(text: string): Promise<{ status: string; reason?: string }>;
}

let nativeProvider: PermissionsNativeProvider | null = null;

export const configurePermissionsNative = (
  provider: PermissionsNativeProvider | null,
): void => {
  nativeProvider = provider;
};

const nativeStatusSchema = z.object({
  microphone: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  screen: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  speechRecognition: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
  notifications: z.enum(SYSTEM_PERMISSION_STATUSES).optional(),
});

const nativeInsertionSchema = z.object({
  status: z.string(),
  reason: z.string().nullable().optional(),
});

const createNativeProvider = (): PermissionsNativeProvider => ({
  async queryPermissions() {
    return nativeStatusSchema.parse(
      await getSharedHelperClient().call("permissions.state"),
    );
  },
  async insertText(text) {
    const result = nativeInsertionSchema.parse(
      await getSharedHelperClient().call("text.insert", { text }),
    );
    return result.reason === null || result.reason === undefined
      ? { status: result.status }
      : { status: result.status, reason: result.reason };
  },
});

const kindSchema = z.enum(SYSTEM_PERMISSION_KINDS);

/** What a request needs to act: the sender, the presentation, a refresh. */
export interface PermissionsRequestContext {
  sender?: WebContents;
  presentation?: PermissionNotificationPresentation;
  refresh(): Promise<SystemPermissionsState>;
}

/**
 * The surfaces only the shell's OS has: its own permission reads and
 * request actions, where its settings panes live, and its front-app
 * insertion machinery. Every hook is optional — the shared defaults
 * (the helper sidecar's answers, the notification probe, the deep links)
 * answer wherever the shell stays silent.
 */
export interface PermissionsShellInputs {
  /** The kind's settings deep-link; kinds without one have no remediation row. */
  settingsUris?: Partial<Record<SystemPermissionKind, string>>;
  /** The shell's own OS read; an undefined answer falls through to the shared defaults. */
  readStatus?: (
    kind: SystemPermissionKind,
  ) => Promise<SystemPermissionStatus | undefined>;
  /** The shell's own request action. */
  request?: (
    kind: SystemPermissionKind,
    context: PermissionsRequestContext,
  ) => Promise<void>;
  /** The shell's own settings flow, when the OS needs more than a deep link. */
  openSettings?: (
    kind: SystemPermissionKind,
    context: PermissionsRequestContext,
  ) => Promise<void>;
  /** The shell's own requestability rule; the default offers notifications only. */
  canRequest?: (
    kind: SystemPermissionKind,
    status: SystemPermissionStatus,
  ) => boolean;
  /** The shell's own front-app insertion machinery. */
  insertText?: (text: string) => Promise<TextInsertionResult>;
  /** The shell's own front-app undo machinery, answering the undo channel. */
  undoText?: () => Promise<TextInsertionResult>;
}

const NOT_APPLICABLE_KINDS = new Set<SystemPermissionKind>([
  "accessibility",
  "inputMonitoring",
  "automation",
]);

const mapMediaStatus = (status: string): SystemPermissionStatus =>
  SYSTEM_PERMISSION_STATUSES.includes(status as SystemPermissionStatus)
    ? (status as SystemPermissionStatus)
    : "unknown";

const allWindowsWebContents = () =>
  BrowserWindow.getAllWindows()
    .filter((win) => !win.isDestroyed() && !win.webContents.isDestroyed())
    .map((win) => win.webContents);

class PermissionsService {
  private lastStateJson: string | null = null;
  // Probe result plus the native status seen when probing. Dropped when the
  // native status changes or the window regains focus, since the per-app
  // toggle is invisible to the helper and the user may have changed it.
  private notificationProbe: {
    status: SystemPermissionStatus;
    nativeStatus: SystemPermissionStatus | undefined;
  } | null = null;

  constructor(private readonly shell: PermissionsShellInputs = {}) {}

  async state(): Promise<SystemPermissionsState> {
    const native = await this.readNativeStatuses();
    if (!this.shell.readStatus) {
      return Object.fromEntries(
        SYSTEM_PERMISSION_KINDS.map((kind) => [kind, this.item(kind, native)]),
      ) as SystemPermissionsState;
    }
    return Object.fromEntries(
      await Promise.all(
        SYSTEM_PERMISSION_KINDS.map(async (kind) => {
          const item = await this.readItem(kind, native);
          return [kind, item] as const;
        }),
      ),
    ) as SystemPermissionsState;
  }

  async refresh(): Promise<SystemPermissionsState> {
    const state = await this.state();
    this.broadcastIfChanged(state);
    return state;
  }

  async request(
    kind: SystemPermissionKind,
    presentation?: PermissionNotificationPresentation,
  ): Promise<SystemPermissionStateItem> {
    const context: PermissionsRequestContext = {
      presentation,
      refresh: () => this.refresh(),
    };
    if (this.shell.request) {
      await this.shell.request(kind, context);
    } else if (kind === "notifications") {
      const native = await this.readNativeStatuses();
      this.notificationProbe = {
        status: await this.probeNotifications(),
        nativeStatus: native.notifications,
      };
    } else {
      await this.openSettings(kind);
    }
    return (await this.refresh())[kind];
  }

  // A change made outside the app is picked up by the refresh that runs
  // when the app window regains focus.
  async openSettings(
    kind: SystemPermissionKind,
  ): Promise<SystemPermissionStateItem> {
    if (this.shell.openSettings) {
      await this.shell.openSettings(kind, { refresh: () => this.refresh() });
    } else {
      const uri = this.settingsUri(kind);
      if (uri) {
        await shell.openExternal(uri);
      }
    }
    return (await this.refresh())[kind];
  }

  refreshOnFocus(): Promise<SystemPermissionsState> {
    this.notificationProbe = null;
    return this.refresh();
  }

  quitAndReopen(): void {
    app.relaunch();
    app.quit();
  }

  private settingsUri(kind: SystemPermissionKind): string | undefined {
    return this.shell.settingsUris?.[kind];
  }

  private async readNativeStatuses(): Promise<
    Partial<Record<SystemPermissionKind, SystemPermissionStatus>>
  > {
    if (!nativeProvider) {
      return {};
    }
    try {
      return await nativeProvider.queryPermissions();
    } catch (err) {
      log.warn("[permissions] native permission query failed:", err);
      return {};
    }
  }

  private item(
    kind: SystemPermissionKind,
    native: Partial<Record<SystemPermissionKind, SystemPermissionStatus>>,
  ): SystemPermissionStateItem {
    const status = this.defaultStatus(kind, native);
    return this.assemble(kind, status);
  }

  // The shell reads its own OS; a failed or undefined answer falls back to
  // the shared chain.
  private async readItem(
    kind: SystemPermissionKind,
    native: Partial<Record<SystemPermissionKind, SystemPermissionStatus>>,
  ): Promise<SystemPermissionStateItem> {
    let status: SystemPermissionStatus;
    let error: string | undefined;
    try {
      const answer = await this.shell.readStatus?.(kind);
      status = answer ?? this.defaultStatus(kind, native);
    } catch (err) {
      status = "unknown";
      error = describeError(err);
      log.warn(`[permissions] read ${kind} failed:`, err);
    }
    const item = this.assemble(kind, status);
    return error ? { ...item, error } : item;
  }

  private assemble(
    kind: SystemPermissionKind,
    status: SystemPermissionStatus,
  ): SystemPermissionStateItem {
    const settled = status === "granted" || status === "restricted";
    const canRequest = this.shell.canRequest
      ? this.shell.canRequest(kind, status)
      : kind === "notifications" && !settled;
    return {
      kind,
      status,
      canRequest,
      canOpenSettings:
        this.settingsUri(kind) !== undefined && status !== "granted",
      requiresRestart: false,
    };
  }

  private defaultStatus(
    kind: SystemPermissionKind,
    native: Partial<Record<SystemPermissionKind, SystemPermissionStatus>>,
  ): SystemPermissionStatus {
    if (NOT_APPLICABLE_KINDS.has(kind)) {
      return "not-applicable";
    }
    const probe = this.notificationProbe;
    if (
      kind === "notifications" &&
      probe &&
      probe.nativeStatus === native.notifications
    ) {
      return probe.status;
    }
    if (native[kind]) {
      return native[kind];
    }
    // Screen is deliberately absent: Electron often reports it as granted
    // without trusting the OS's real answer, so only the helper's
    // consent-store read is trusted.
    if (kind === "microphone") {
      return mapMediaStatus(systemPreferences.getMediaAccessStatus(kind));
    }
    return "unknown";
  }

  private probeNotifications(): Promise<SystemPermissionStatus> {
    if (!Notification.isSupported()) {
      return Promise.resolve("restricted");
    }
    return new Promise((resolve) => {
      let settled = false;
      const settle = (status: SystemPermissionStatus) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        resolve(status);
      };
      const timeout = setTimeout(() => settle("unknown"), 30_000);
      timeout.unref?.();

      const notification = new Notification({
        title: "Cadet",
        body: "Notifications are enabled.",
      });
      notification.once("show", () => settle("granted"));
      notification.once("failed", () => settle("denied"));
      try {
        notification.show();
      } catch {
        settle("unknown");
      }
    });
  }

  private broadcastIfChanged(state: SystemPermissionsState): void {
    const stateJson = JSON.stringify(state);
    if (stateJson === this.lastStateJson) {
      return;
    }
    this.lastStateJson = stateJson;
    for (const webContents of allWindowsWebContents()) {
      webContents.send(PERMISSIONS_STATE_EVENT, state);
    }
  }
}

const insertIntoFrontApp = async (
  inputs: PermissionsShellInputs,
  text: string,
): Promise<TextInsertionResult> => {
  if (BrowserWindow.getFocusedWindow() !== null) {
    return { status: "cadet-focused" };
  }
  if (inputs.insertText) {
    return inputs.insertText(text);
  }
  if (!nativeProvider) {
    log.warn("[text-insertion] no native insertion provider registered");
    return { status: "blocked" };
  }
  try {
    const result = await nativeProvider.insertText(text);
    if (result.status === "inserted") {
      return { status: "inserted" };
    }
    log.warn("[text-insertion] helper refused insertion:", result.reason);
  } catch (err) {
    log.warn("[text-insertion] helper insertion failed:", err);
  }
  // Bring the app back so the user sees why nothing was inserted.
  current()?.show();
  return { status: "blocked" };
};

let installedService: PermissionsService | null = null;

/**
 * The service the IPC handlers answer from, for a main-process caller that
 * needs to read or refresh a permission. Null before install.
 */
export const getPermissionsService = (): PermissionsService | null =>
  installedService;

export const install = (): void => {
  // The per-OS arm resolves here, inside the feature — the composition
  // just installs.
  const inputs = permissionsStrategy();
  configurePermissionsNative(createNativeProvider());
  const service = new PermissionsService(inputs);
  installedService = service;

  handle(PERMISSIONS_GET_STATE, z.tuple([]), () => service.refresh());
  handle(
    PERMISSIONS_REQUEST,
    z.tuple([
      kindSchema,
      permissionNotificationPresentationSchema.optional().catch(undefined),
    ]),
    ([kind, presentation]) => service.request(kind, presentation),
  );
  handle(PERMISSIONS_OPEN_SETTINGS, z.tuple([kindSchema]), ([kind]) =>
    service.openSettings(kind),
  );
  handle(PERMISSIONS_QUIT_AND_REOPEN, z.tuple([]), () => {
    service.quitAndReopen();
  });

  handle(TEXT_INSERT, z.tuple([z.string()]), ([text]) =>
    insertIntoFrontApp(inputs, text),
  );
  if (inputs.undoText) {
    handle(TEXT_UNDO, z.tuple([]), () => inputs.undoText?.());
  }
  handle(TEXT_OPEN_SETTINGS, z.tuple([]), () => {
    const uri = inputs.settingsUris?.automation;
    if (uri) {
      void shell.openExternal(uri);
    }
    return Promise.resolve();
  });

  app.on("browser-window-focus", () => {
    void service.refreshOnFocus();
  });
};
