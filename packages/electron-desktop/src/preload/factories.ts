import { ipcRenderer, type IpcRendererEvent } from "electron";

import type {
  AppVersionInfo,
  BundleScanData,
  CadetCommand,
  DeepLink,
  DownloadDoneEvent,
  NotificationActionEvent,
  ResolvedHotkey,
  TextInsertionResult,
  TitleBarOverlayTheme,
  UpdateState,
  CadetBridge,
  WindowAttentionPayload,
  VellumMigrationConfirmInfo,
  VellumMigrationProbe,
  VellumMigrationRunState,
  VellumMigrationStepEvent,
} from "@mycadet/ipc-contract";
import {
  COMPANION_SET_UNPLACED_DICTATION_OFFER,
  DOWNLOADS_DONE_EVENT,
  DOWNLOADS_REVEAL,
  NOTIFICATIONS_ACTION,
  NOTIFICATIONS_PREPARE_IDENTITY,
  NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER,
  NOTIFICATIONS_RESET_IDENTITIES,
  NOTIFICATIONS_SHOW,
  WINDOW_ATTENTION,
  VELLUM_MIGRATION_DECLINE,
  VELLUM_MIGRATION_GET,
  VELLUM_MIGRATION_PREPARE,
  VELLUM_MIGRATION_START,
  VELLUM_MIGRATION_STATE_EVENT,
  VELLUM_MIGRATION_STEP_EVENT,
} from "@mycadet/ipc-contract";

export const dictationOfferBridge: Pick<
  NonNullable<CadetBridge["companion"]>,
  "setUnplacedDictationOffer"
> = {
  setUnplacedDictationOffer: (offer) => {
    ipcRenderer.send(COMPANION_SET_UNPLACED_DICTATION_OFFER, offer);
  },
};

const subscribe =
  <Payload>(channel: string) =>
  (callback: (payload: Payload) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, payload: Payload): void => {
      callback(payload);
    };
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.off(channel, handler);
    };
  };

/**
 * Like {@link subscribe}, but the IPC listener is installed once when the
 * subscriber is created and the latest payload is replayed to each callback
 * as it registers.
 *
 * Push-only channels whose first payload arrives on page load need this: the
 * preload evaluates ahead of every page script, so the listener below is in
 * place for that payload, while the renderer callbacks are React effects and
 * lazy routes that register afterwards. Without the replay such a callback
 * holds its default until the next transition on the channel.
 */
const subscribeWithReplay = <Payload>(
  channel: string,
): ((callback: (payload: Payload) => void) => () => void) => {
  const callbacks = new Set<(payload: Payload) => void>();
  let latest: { payload: Payload } | null = null;
  ipcRenderer.on(
    channel,
    (_event: IpcRendererEvent, payload: Payload): void => {
      latest = { payload };
      // Snapshot so a callback that subscribes mid-dispatch is served by its own
      // replay instead of twice, and re-check membership so one that
      // unsubscribes mid-dispatch is not called after the fact.
      for (const callback of [...callbacks]) {
        if (!callbacks.has(callback)) {
          continue;
        }
        callback(payload);
      }
    },
  );
  return (callback) => {
    callbacks.add(callback);
    if (latest) {
      // Synchronous, so the replay always lands before the caller holds the
      // unsubscribe function and can never outlive it.
      callback(latest.payload);
    }
    return () => {
      callbacks.delete(callback);
    };
  };
};

export const deepLinksBridge: CadetBridge["deepLinks"] = {
  drain: () =>
    ipcRenderer.invoke("cadet:deepLinks:drain") as Promise<DeepLink[]>,
  onLink: (callback) => {
    const handler = (_event: IpcRendererEvent, link: DeepLink): void => {
      callback(link);
    };
    ipcRenderer.on("cadet:deepLinks:event", handler);
    ipcRenderer.send("cadet:deepLinks:subscribe");
    return () => {
      ipcRenderer.off("cadet:deepLinks:event", handler);
      ipcRenderer.send("cadet:deepLinks:unsubscribe");
    };
  },
};

export const launchAtLoginBridge: CadetBridge["launchAtLogin"] = {
  get: () => ipcRenderer.invoke("cadet:launchAtLogin:get") as Promise<boolean>,
  set: (enabled) =>
    ipcRenderer.invoke("cadet:launchAtLogin:set", enabled) as Promise<void>,
};

/** Renderer side of `installHotkeysIpc`. */
export const hotkeysBridge: CadetBridge["hotkeys"] = {
  get: () =>
    ipcRenderer.invoke("cadet:hotkeys:get") as Promise<ResolvedHotkey[]>,
  set: (key, accelerator) =>
    ipcRenderer.invoke("cadet:hotkeys:set", key, accelerator) as Promise<void>,
  onChange: subscribe<ResolvedHotkey[]>("cadet:hotkeys:changed"),
};

/** Renderer side of `installBundleConfirmation`. */
export const bundleConfirmBridge: CadetBridge["bundleConfirm"] = {
  getData: () =>
    ipcRenderer.invoke(
      "cadet:bundleConfirm:getData",
    ) as Promise<BundleScanData | null>,
  respond: (accepted) => {
    ipcRenderer.send("cadet:bundleConfirm:respond", accepted);
  },
};

/** Renderer side of `installDownloads`. */
export const downloadsBridge: CadetBridge["downloads"] = {
  onDone: subscribe<DownloadDoneEvent>(DOWNLOADS_DONE_EVENT),
  reveal: (id) => ipcRenderer.invoke(DOWNLOADS_REVEAL, id),
};

/** Renderer side of `installAutoUpdate`. */
export const updateBridge: CadetBridge["update"] = {
  getState: () =>
    ipcRenderer.invoke("cadet:update:getState") as Promise<UpdateState>,
  check: () => ipcRenderer.invoke("cadet:update:check") as Promise<void>,
  install: () => ipcRenderer.invoke("cadet:update:install") as Promise<void>,
  onState: subscribe<UpdateState>("cadet:update:state"),
};

/**
 * The one surface built per composition: it owns a publisher-session identity
 * (a per-preload random ID) whose registration is awaited by the identity
 * methods, so it cannot be a shared module-level object.
 */
export const createNotificationsBridge = (): CadetBridge["notifications"] => {
  // Sandboxed Electron preload can omit randomUUID. This ID only separates
  // publisher sessions on the same sender and is never a credential.
  const publisherSessionId =
    globalThis.crypto?.randomUUID?.() ??
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const publisherRegistration = ipcRenderer
    .invoke(NOTIFICATIONS_REGISTER_IDENTITY_PUBLISHER, {
      publisherSessionId,
    })
    .then(
      (registered) => registered === true,
      () => false,
    );
  return {
    show: (payload) =>
      ipcRenderer.invoke(NOTIFICATIONS_SHOW, payload) as Promise<{
        success: boolean;
        errorMessage?: string;
      }>,
    registerIdentityPublisher: () => publisherRegistration,
    prepareIdentity: async (payload) => {
      await publisherRegistration;
      await ipcRenderer.invoke(NOTIFICATIONS_PREPARE_IDENTITY, {
        ...payload,
        publisherSessionId,
      });
    },
    resetIdentities: async (payload) => {
      await publisherRegistration;
      await ipcRenderer.invoke(NOTIFICATIONS_RESET_IDENTITIES, {
        ...payload,
        publisherSessionId,
      });
    },
    onAction: subscribe<NotificationActionEvent>(NOTIFICATIONS_ACTION),
    onWindowAttention: createWindowAttentionSubscriber(),
  };
};

/**
 * Built per composition: each subscriber keeps its own latest-payload replay
 * state, so a shared instance would cross-talk between compositions.
 */
export function createWindowAttentionSubscriber(): CadetBridge["notifications"]["onWindowAttention"] {
  return subscribeWithReplay<WindowAttentionPayload>(WINDOW_ATTENTION);
}

/** Renderer side of the vellum migration feature. */
export const vellumMigrationBridge: CadetBridge["vellumMigration"] = {
  get: (): Promise<VellumMigrationProbe> =>
    ipcRenderer.invoke(VELLUM_MIGRATION_GET),
  prepare: (): Promise<VellumMigrationConfirmInfo | null> =>
    ipcRenderer.invoke(VELLUM_MIGRATION_PREPARE),
  start: (): Promise<VellumMigrationRunState> =>
    ipcRenderer.invoke(VELLUM_MIGRATION_START),
  decline: (options): Promise<void> =>
    ipcRenderer.invoke(VELLUM_MIGRATION_DECLINE, options),
  onStep: subscribe<VellumMigrationStepEvent>(VELLUM_MIGRATION_STEP_EVENT),
  onState: subscribeWithReplay<VellumMigrationRunState>(
    VELLUM_MIGRATION_STATE_EVENT,
  ),
};

/** The app surface: version reporting and the marketing-site handoff. */
export const appBridge: CadetBridge["app"] = {
  versionInfo: (): Promise<AppVersionInfo> =>
    ipcRenderer.invoke("cadet:app:versionInfo"),
  openWebsite: (): Promise<void> => ipcRenderer.invoke("cadet:app:openWebsite"),
};

/** The command surface: the main process drives renderer commands. */
export const commandsBridge: CadetBridge["commands"] = {
  on: (callback) => {
    const handler = (_event: IpcRendererEvent, command: CadetCommand) => {
      callback(command);
    };
    ipcRenderer.on("cadet:command", handler);
    return () => {
      ipcRenderer.off("cadet:command", handler);
    };
  },
};

/** The main window's surface, minus the Windows-only overlay hook. */
export const mainWindowBridge: Omit<
  CadetBridge["mainWindow"],
  "setTitleBarOverlay"
> = {
  ensureVisible: (): Promise<void> =>
    ipcRenderer.invoke("cadet:mainWindow:ensureVisible"),
  setOnboarding: (active): Promise<void> =>
    ipcRenderer.invoke("cadet:mainWindow:setOnboarding", active),
  navigateTo: (url): Promise<void> =>
    ipcRenderer.invoke("cadet:mainWindow:navigateTo", url),
};

/**
 * Windows alone answers `setTitleBarOverlay` — its title-bar controls are
 * drawn by the system, so theme changes must reach the native overlay; the
 * other desktops frame their windows themselves.
 */
export const mainWindowSetTitleBarOverlay: NonNullable<
  CadetBridge["mainWindow"]["setTitleBarOverlay"]
> = (theme: TitleBarOverlayTheme): Promise<void> =>
  ipcRenderer.invoke("cadet:mainWindow:setTitleBarOverlay", theme);

/** The text surface, minus the macOS-only undo hook. */
export const textBridge: Omit<CadetBridge["text"], "undoInFrontApp"> = {
  insertIntoFrontApp: (text): Promise<TextInsertionResult> =>
    ipcRenderer.invoke("cadet:text:insertIntoFrontApp", text),
  openAutomationSettings: (): Promise<void> =>
    ipcRenderer.invoke("cadet:text:openAutomationSettings"),
};

/**
 * Where the helper can undo its own insertion — the automation-feedback loop
 * needs a way to roll it back.
 */
export const textUndoInFrontApp: NonNullable<
  CadetBridge["text"]["undoInFrontApp"]
> = (): Promise<TextInsertionResult> =>
  ipcRenderer.invoke("cadet:text:undoInFrontApp");
