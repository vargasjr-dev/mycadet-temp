import { randomUUID } from "node:crypto";

import { Notification, app, shell, systemPreferences } from "electron";
import type {
  PermissionNotificationPresentation,
  SystemPermissionKind,
  SystemPermissionStatus,
} from "@mycadet/ipc-contract";
import type { PermissionsShellInputs } from "./permissions";
import { isPreparedNotificationSenderCurrent } from "../notifications";
import { resolveNotificationAvatarPath } from "../notification-avatar-path";
import { preparePermissionPresentation } from "./permission-presentation";
import { resolveEnvironmentName } from "@mycadet/shared";

export const describeError = (err: unknown): string =>
  err instanceof Error ? err.message : String(err);

import { runAppleScript } from "../apple-script-executor";
import {
  queryFreshHelperPermission,
  queryHelperPermission,
  requestHelperPermission,
  type HelperPermissionKind,
} from "./helper-permissions";
import log from "../app-logger";
import {
  getNotifier,
  isNotifierSupported,
  requestNotifierAuthorization,
  type NotifierAuthorizationResult,
} from "../notifier";
import { readScreenRecordingPermission } from "./screen-recording-permission";
import { typeIntoFrontApp, undoInFrontApp } from "./text-insertion";

const SECURITY_PANE_URL =
  "x-apple.systempreferences:com.apple.preference.security";

const SETTINGS_PANES: Record<SystemPermissionKind, string> = {
  accessibility: `${SECURITY_PANE_URL}?Privacy_Accessibility`,
  screen: `${SECURITY_PANE_URL}?Privacy_ScreenCapture`,
  microphone: `${SECURITY_PANE_URL}?Privacy_Microphone`,
  speechRecognition: `${SECURITY_PANE_URL}?Privacy_SpeechRecognition`,
  inputMonitoring: `${SECURITY_PANE_URL}?Privacy_ListenEvent`,
  automation: `${SECURITY_PANE_URL}?Privacy_Automation`,
  notifications: "x-apple.systempreferences:com.apple.preference.notifications",
};

const AUTOMATION_PROBE_SCRIPT =
  'tell application "System Events" to get name of first process';

const HELPER_PERMISSION_KINDS = new Set<SystemPermissionKind>([
  "speechRecognition",
  "inputMonitoring",
]);

const isHelperPermissionKind = (
  kind: SystemPermissionKind,
): kind is HelperPermissionKind => HELPER_PERMISSION_KINDS.has(kind);

const isAutomationDeniedError = (err: unknown): boolean => {
  const message = describeError(err).toLowerCase();
  return (
    message.includes("-1743") ||
    message.includes("-25211") ||
    message.includes("not authorized") ||
    message.includes("not authorised") ||
    message.includes("not allowed assistive access") ||
    message.includes("not allowed to send apple events") ||
    message.includes("not permitted to send apple events")
  );
};

const resolveAppBundleId = (): string => {
  if (!app.isPackaged) return "com.github.Electron";
  const env = resolveEnvironmentName();
  return env === "production"
    ? "ai.mycadet.electron"
    : `ai.mycadet.electron-${env}`;
};

const settingsPaneUrl = (kind: SystemPermissionKind): string => {
  if (kind !== "notifications") return SETTINGS_PANES[kind];
  return `${SETTINGS_PANES.notifications}?id=${encodeURIComponent(
    resolveAppBundleId(),
  )}`;
};

export async function openPermissionSettingsPane(
  kind: SystemPermissionKind,
): Promise<void> {
  preparePermissionPresentation();
  await shell.openExternal(settingsPaneUrl(kind));
}

// A permission prompt waits on the user, so give them time to answer before
// the outcome is called unknown.
const NOTIFICATION_PROMPT_TIMEOUT_MS = 30_000;

// The probe posts a real notification, so the user reads this on whichever
// path delivered it.
const NOTIFICATION_CONFIRMATION_BODY = "Notifications are enabled.";
const ASSISTANT_NOTIFICATION_CONFIRMATION_BODY =
  "You’re all set. I can send you notifications here.";

/**
 * Runs `probe` and resolves whatever it settles on, or `null` once `timeoutMs`
 * passes with no answer. The first settle wins, so a probe that answers twice
 * (or answers after the timeout) cannot change the outcome.
 */
const settleWithin = <T>(
  timeoutMs: number,
  probe: (settle: (value: T | null) => void) => void,
): Promise<T | null> =>
  new Promise((resolve) => {
    const timeout = setTimeout(() => {
      resolve(null);
    }, timeoutMs);
    timeout.unref?.();
    probe((value) => {
      clearTimeout(timeout);
      resolve(value);
    });
  });

/**
 * The Electron probe learns its answer by posting a notification, so a user
 * who allows sees a confirmation banner. The addon answers without posting
 * anything, so the native path posts the same banner itself. It carries no
 * category because it has no action buttons to route.
 */
const postNativeNotificationConfirmation = (
  presentation?: PermissionNotificationPresentation,
): void => {
  const notifier = getNotifier();
  if (!notifier) {
    return;
  }
  try {
    const sender =
      presentation &&
      isPreparedNotificationSenderCurrent(
        presentation.identity,
        presentation.sender,
      )
        ? presentation.sender
        : undefined;
    const avatarPngPath = sender
      ? resolveNotificationAvatarPath(
          {
            id: sender.id,
            name: sender.name,
            avatarPng: Buffer.from(sender.avatarBase64, "base64"),
            avatarHash: sender.avatarHash,
          },
          app.getPath("userData"),
          log,
        )
      : null;
    const resolvedSender =
      sender && avatarPngPath
        ? {
            id: sender.id,
            name: sender.name,
            avatarPngPath,
            conversationId: sender.id,
          }
        : undefined;
    notifier.show(
      {
        id: randomUUID(),
        title: resolvedSender?.name ?? "Cadet",
        body: resolvedSender
          ? ASSISTANT_NOTIFICATION_CONFIRMATION_BODY
          : NOTIFICATION_CONFIRMATION_BODY,
        categoryId: "",
        actions: [],
        ...(resolvedSender ? { sender: resolvedSender } : {}),
      },
      () => undefined,
    );
  } catch (error) {
    log.warn("[permissions] confirmation notification failed:", error);
  }
};

// Asking the addon rather than `electron.Notification.isSupported()`, which
// builds Electron's presenter and takes the notification center's delegate.
// Electron's own probe is consulted only when the addon cannot post, which is
// the case where the presenter gets built anyway.
const initialNotificationStatus = (): SystemPermissionStatus =>
  isNotifierSupported() || Notification.isSupported()
    ? "unknown"
    : "restricted";

const notificationStatus = {
  current: initialNotificationStatus(),
};

const automationStatus: { current: SystemPermissionStatus } = {
  current: "unknown",
};

const helperRequests = new Set<SystemPermissionKind>();

const readStatus = async (
  kind: SystemPermissionKind,
): Promise<SystemPermissionStatus> => {
  switch (kind) {
    case "accessibility":
      return systemPreferences.isTrustedAccessibilityClient(false)
        ? "granted"
        : "denied";
    // The helper's grant, not the app's: the helper takes every capture.
    case "screen":
      return await readScreenRecordingPermission();
    case "microphone":
      return systemPreferences.getMediaAccessStatus("microphone");
    case "speechRecognition":
      return await queryFreshHelperPermission(kind);
    case "inputMonitoring":
      return isHelperPermissionKind(kind)
        ? await queryHelperPermission(kind)
        : "unknown";
    case "automation":
      return automationStatus.current;
    case "notifications":
      return notificationStatus.current;
  }
};

const requestAutomation = async (): Promise<void> => {
  // AppleEvents has no harmless read API; only probe after an explicit user
  // request so opening Settings never triggers a surprise macOS prompt.
  try {
    await runAppleScript(AUTOMATION_PROBE_SCRIPT);
    automationStatus.current = "granted";
  } catch (err) {
    automationStatus.current = isAutomationDeniedError(err)
      ? "denied"
      : "unknown";
  }
};

const requestNotifications = async (
  presentation?: PermissionNotificationPresentation,
): Promise<void> => {
  // An addon that loads but reports unsupported is not a dead end: Electron
  // can still post, so the probe falls back to it rather than calling the
  // permission restricted.
  if (isNotifierSupported()) {
    const result = await settleWithin<NotifierAuthorizationResult>(
      NOTIFICATION_PROMPT_TIMEOUT_MS,
      (settle) => {
        void requestNotifierAuthorization().then(settle);
      },
    );
    if (result === null) {
      notificationStatus.current = "unknown";
      return;
    }
    notificationStatus.current = result.granted ? "granted" : "denied";
    if (result.granted) {
      postNativeNotificationConfirmation(presentation);
    }
    return;
  }
  if (!Notification.isSupported()) {
    notificationStatus.current = "restricted";
    return;
  }
  const status = await settleWithin<SystemPermissionStatus>(
    NOTIFICATION_PROMPT_TIMEOUT_MS,
    (settle) => {
      const notification = new Notification({
        title: "Cadet",
        body: NOTIFICATION_CONFIRMATION_BODY,
        silent: false,
      });
      notification.once("show", () => settle("granted"));
      notification.once("failed", () => settle("denied"));
      try {
        notification.show();
      } catch {
        settle(null);
      }
    },
  );
  notificationStatus.current = status ?? "unknown";
};

const pollTimers = new Map<
  SystemPermissionKind,
  ReturnType<typeof setInterval>
>();

const stopPolling = (kind: SystemPermissionKind): void => {
  const timer = pollTimers.get(kind);
  if (!timer) return;
  clearInterval(timer);
  pollTimers.delete(kind);
};

const startPolling = (
  kind: SystemPermissionKind,
  refresh: () => Promise<Record<string, { status: SystemPermissionStatus }>>,
): void => {
  stopPolling(kind);
  let attempts = 0;
  const timer = setInterval(() => {
    attempts += 1;
    void refresh().then((state) => {
      const status = state[kind]?.status;
      if (status === "granted" || attempts >= 150) {
        stopPolling(kind);
      }
    });
  }, 2_000);
  timer.unref?.();
  pollTimers.set(kind, timer);
};

// The windows arm: the OS's own settings deep links. Windows asks for no
// richer flow — its privacy pages are the request surface.
const WINDOWS_SETTINGS_URIS: Partial<Record<SystemPermissionKind, string>> = {
  screen: "ms-settings:privacy-graphicscaptureprogrammatic",
  microphone: "ms-settings:privacy-microphone",
  speechRecognition: "ms-settings:privacy-speech",
  notifications: "ms-settings:notifications",
  // No automation pane here — the privacy hub is the landing page.
  automation: "ms-settings:privacy",
};

/**
 * The shell inputs the composition installs, resolved per OS: this file's
 * macOS strategy, the windows deep links, and the shared defaults for
 * linux.
 */
export const permissionsStrategy = (): PermissionsShellInputs => {
  switch (process.platform) {
    case "darwin":
      return permissionsShell;
    case "win32":
      return { settingsUris: WINDOWS_SETTINGS_URIS };
    default:
      return {};
  }
};

/**
 * This OS answers every kind itself: native framework reads for the
 * app-launch permissions, the helper's consent-store for the kinds the
 * helper owns, and the addon's authorization flow for notifications.
 */
export const permissionsShell: PermissionsShellInputs = {
  settingsUris: SETTINGS_PANES,
  readStatus,
  canRequest: (kind, status) => {
    if (status === "restricted" || status === "granted") {
      return false;
    }
    if (kind === "screen") {
      return !helperRequests.has(kind);
    }
    return true;
  },
  request: async (kind, { presentation, refresh }) => {
    preparePermissionPresentation();
    try {
      switch (kind) {
        case "accessibility":
          systemPreferences.isTrustedAccessibilityClient(true);
          break;
        case "microphone":
          await systemPreferences.askForMediaAccess("microphone");
          break;
        case "screen":
          await requestHelperPermission("screen");
          helperRequests.add(kind);
          break;
        case "speechRecognition":
          await requestHelperPermission("speechRecognition");
          break;
        case "inputMonitoring":
          await requestHelperPermission("inputMonitoring");
          helperRequests.add(kind);
          break;
        case "automation":
          await requestAutomation();
          break;
        case "notifications":
          await requestNotifications(presentation);
          break;
      }
    } catch (err) {
      log.warn(`[permissions] request ${kind} failed:`, err);
    }

    const state = await refresh();
    if (["unknown", "not-determined"].includes(state[kind].status)) {
      startPolling(kind, refresh);
    }
  },
  openSettings: async (kind, { refresh }) => {
    if (kind === "inputMonitoring" || kind === "screen") {
      const state = await refresh();
      if (state[kind].status === "granted") {
        return;
      }
      // Native alerts own their Settings button and can outlive the helper.
      // Only a separate user action opens Settings directly. Screen
      // Recording's alert can land on another pane, so it always opens its own.
      const canShowNativeAlert =
        kind !== "screen" &&
        ["unknown", "not-determined"].includes(state[kind].status);
      if (canShowNativeAlert && !helperRequests.has(kind)) {
        await permissionsShell.request!(kind, { refresh });
        return;
      }
    }
    await openPermissionSettingsPane(kind);
    startPolling(kind, refresh);
  },
  insertText: typeIntoFrontApp,
  undoText: undoInFrontApp,
};
