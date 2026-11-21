import { existsSync } from "node:fs";
import path from "node:path";

import { app } from "electron";
import { z } from "zod";

import { buildHelperToastRequest } from "../helper-toast-request";
import {
  configureNotifications,
  installNotifications,
  type NotificationCreateOptions,
  type NotificationLike,
} from "../notifications";
import { NativeSidecarClient } from "@mycadet/native-sidecar/supervisor";

import { handle } from "../ipc";
import log from "../app-logger";
import { ensureVisible } from "../main-window";

/**
 * Notifications feature for the classic-desktop shells. Delivery prefers the
 * native helper's `notifications/show` toast module where a helper binary
 * ships (Windows toasts are the only path with per-category action buttons,
 * and the helper reports activation back over JSON-RPC so clicks and buttons
 * route the same category metadata as macOS). Without the helper binary (dev
 * runs before `build:native-helper`, and every Linux install until a sidecar
 * ships), the shared module's default `electron.Notification` path delivers
 * click-only toasts.
 *
 * A toast from a sender puts the assistant's avatar in the toast's image
 * slot, which the helper reads from a file, so the assistant's name is the
 * title and the conversation title becomes the subtitle. The default path
 * draws the same avatar through `electron.Notification`'s `icon`.
 */

// The helper binary name and its dev-override env are per-platform names of
// the same seam: one supervised sidecar the toasts ride.
const HELPER_EXECUTABLE =
  process.platform === "win32"
    ? "Cadet.WindowsHelper.exe"
    : "cadet-linux-helper";

// Bound on toasts a user could still interact with.
const MAX_TRACKED_TOASTS = 200;

const TOAST_EVENT_SCHEMA = z.object({
  token: z.string(),
  kind: z.enum(["click", "action"]),
  actionIndex: z.number().int().nonnegative().optional(),
});

const SHOW_RESULT_SCHEMA = z.object({
  success: z.boolean(),
  errorMessage: z.string().optional(),
});

export const resolveHelperPath = (): string | null => {
  const override =
    process.env[
      process.platform === "win32"
        ? "CADET_WINDOWS_HELPER_PATH"
        : "CADET_LINUX_HELPER_PATH"
    ];
  // `resourcesPath` (the packaged install's resources dir) is only set under
  // an Electron runtime; the app-path candidate is the dev publish dir.
  const resourcesPath: string | undefined = process.resourcesPath;
  const tail = ["native-helper", process.arch, HELPER_EXECUTABLE];
  const candidates = [
    ...(override ? [override] : []),
    ...(resourcesPath ? [path.join(resourcesPath, ...tail)] : []),
    path.join(app.getAppPath(), "resources", ...tail),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
};

type ToastListener = (...args: unknown[]) => void;

/**
 * `NotificationLike` factory backed by the helper. One supervised JSON-RPC
 * client is created lazily on the first toast; activation events route back
 * to the matching toast's listeners by token.
 */
export const createHelperToastFactory = (
  helperPath: string,
): ((options: NotificationCreateOptions) => NotificationLike) => {
  let client: NativeSidecarClient | null = null;
  const listenersByToken = new Map<string, Record<string, ToastListener>>();
  let nextToken = 1;

  const ensureClient = (): NativeSidecarClient => {
    if (client) {
      return client;
    }
    client = new NativeSidecarClient({
      name: process.platform === "win32" ? "windows-helper" : "linux-helper",
      resolveExecutablePath: () => helperPath,
      logger: log,
      // Generous: the first toast may wait on toast-identity registration.
      responseTimeoutMs: 10_000,
    });
    client.onNotification(
      "notifications/event",
      TOAST_EVENT_SCHEMA,
      (event) => {
        const listeners = listenersByToken.get(event.token);
        if (event.kind === "click") {
          listeners?.["click"]?.();
        } else if (event.actionIndex !== undefined) {
          // An action without a readable index is dropped: defaulting could
          // route an ambiguous press as e.g. a tool-call "Allow".
          listeners?.["action"]?.(undefined, event.actionIndex);
        }
      },
    );
    app.once("before-quit", () => client?.shutdown());
    return client;
  };

  return (options) => {
    const token = `toast-${nextToken++}`;
    const listeners: Record<string, ToastListener> = {};
    listenersByToken.set(token, listeners);
    if (listenersByToken.size > MAX_TRACKED_TOASTS) {
      const oldest = listenersByToken.keys().next().value;
      if (oldest !== undefined) {
        listenersByToken.delete(oldest);
      }
    }
    const on = ((event: string, listener: ToastListener): void => {
      listeners[event] = listener;
    }) as NotificationLike["on"];
    const show = (): void => {
      // Promise.resolve() defers ensureClient/call so a synchronous throw
      // (helper unavailable, circuit open) still acks as a failed delivery
      // instead of rejecting the renderer's invoke.
      Promise.resolve()
        .then(() => {
          const params = buildHelperToastRequest(options, {
            token,
            userDataDir: app.getPath("userData"),
            logger: log,
          });
          return ensureClient().call("notifications/show", params);
        })
        .then((result) => {
          const parsed = SHOW_RESULT_SCHEMA.safeParse(result);
          if (parsed.success && parsed.data.success) {
            listeners["show"]?.();
          } else {
            const message = parsed.success
              ? (parsed.data.errorMessage ?? "Toast delivery failed")
              : "Invalid helper response";
            listeners["failed"]?.(undefined, message);
          }
        })
        .catch((error: unknown) => {
          listeners["failed"]?.(
            undefined,
            error instanceof Error ? error.message : String(error),
          );
        });
    };
    return { on, show };
  };
};

export const install = (): void => {
  const helperPath = resolveHelperPath();
  configureNotifications({
    ipc: { handle },
    ensureVisible,
    logger: log,
    ...(helperPath ? { create: createHelperToastFactory(helperPath) } : {}),
  });
  installNotifications();
};
