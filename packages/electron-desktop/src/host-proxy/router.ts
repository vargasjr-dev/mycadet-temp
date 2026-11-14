/**
 * Host proxy message router.
 *
 * Owns the desktop's executor registry: incoming host_* proxy requests are
 * dispatched to the executor registered for their kind, and unimplemented
 * executors post error results so daemon requests don't hang.
 */

import { hostname } from "node:os";

import { getDeviceId } from "../device-id";

import type { HostProxySseMessage } from "./sse";
import { HostProxyPoster } from "./poster";
import { setHostProxyExecutorLogger } from "./executors/logger";

// ---------------------------------------------------------------------------
// Executor interface
// ---------------------------------------------------------------------------

export interface HostProxyExecutor {
  handleRequest(message: HostProxySseMessage, poster: HostProxyPoster): void;
  handleCancel(message: HostProxySseMessage, poster: HostProxyPoster): void;
}

export type HostProxyExecutorKind =
  | "host_bash"
  | "host_file"
  | "host_transfer"
  | "host_browser"
  | "host_cu"
  | "host_ui_snapshot";

export interface HostProxyLogger {
  info(message: string, context?: unknown): void;
  warn(message: string, context?: unknown): void;
  error(message: string, context?: unknown): void;
}

export interface HostProxyRuntime {
  sseClientHeaders: () => Record<string, string>;
  sseFallbackClientHeaders?: () => Record<string, string>;
  posterClientHeaders: () => Record<string, string>;
  executors: Partial<Record<HostProxyExecutorKind, HostProxyExecutor>>;
  teardownExecutors?: () => void;
  logger: HostProxyLogger;
}

export interface HostProxyClientIdentity {
  interfaceId: string;
  /** Opt in only when the bundled CU executor supports window-only observations. */
  supportsWindowCapture?: boolean;
  /** Opt in only when the bundled CU executor runs `computer_use_sequence`. */
  supportsSequence?: boolean;
  /**
   * Opt in only when this client can draw the assistant's marks on the
   * surface a call is being shown. The overlay is a window the client opens
   * for itself, so a client without one answers the request with nothing.
   */
  supportsCoachmarks?: boolean;
}

export function createHostProxyClientHeaders(
  identity: HostProxyClientIdentity,
): Pick<HostProxyRuntime, "posterClientHeaders" | "sseClientHeaders"> {
  const posterClientHeaders = () => ({
    "X-Cadet-Client-Id": getDeviceId(),
  });
  return {
    posterClientHeaders,
    sseClientHeaders: () => ({
      ...posterClientHeaders(),
      "X-Cadet-Interface-Id": identity.interfaceId,
      "X-Cadet-Machine-Name": hostname(),
      ...(identity.supportsWindowCapture
        ? { "X-Cadet-Cu-Window-Capture": "1" }
        : {}),
      ...(identity.supportsSequence ? { "X-Cadet-Cu-Sequence": "1" } : {}),
      ...(identity.supportsCoachmarks ? { "X-Cadet-Cu-Annotate": "1" } : {}),
    }),
  };
}

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

const executors = new Map<string, HostProxyExecutor>();

let hostRuntime: HostProxyRuntime | null = null;

const requireRuntime = (): HostProxyRuntime => {
  if (!hostRuntime) {
    throw new Error("Host proxy runtime is not installed");
  }
  return hostRuntime;
};

const log: HostProxyLogger = {
  info: (message, context) => requireRuntime().logger.info(message, context),
  warn: (message, context) => requireRuntime().logger.warn(message, context),
  error: (message, context) => requireRuntime().logger.error(message, context),
};

// ---------------------------------------------------------------------------
// Executor registry
// ---------------------------------------------------------------------------

export function setExecutor(kind: string, executor: HostProxyExecutor): void {
  executors.set(kind, executor);
}

export function removeExecutor(kind: string): void {
  executors.delete(kind);
}

// ---------------------------------------------------------------------------
// Message dispatch
// ---------------------------------------------------------------------------

const EXECUTOR_KINDS: readonly HostProxyExecutorKind[] = [
  "host_bash",
  "host_file",
  "host_transfer",
  "host_browser",
  "host_cu",
  "host_ui_snapshot",
];

/** Route type → executor kind. Returns null for unknown types. */
function executorKindForType(
  type: string,
): { kind: string; action: "request" | "cancel" } | null {
  for (const kind of EXECUTOR_KINDS) {
    if (type === `${kind}_request`) return { kind, action: "request" };
    if (type === `${kind}_cancel`) return { kind, action: "cancel" };
  }
  return null;
}

function dispatchMessage(
  message: HostProxySseMessage,
  poster: HostProxyPoster,
): void {
  const { type } = message;
  const route = executorKindForType(type);
  if (!route) {
    // The gateway's /v1/events endpoint is the full assistant-event
    // firehose — streaming deltas (assistant_text_delta,
    // assistant_thinking_delta), tool events, sync notifications, and so
    // on. This connection exists only to service host_* proxy requests, so
    // every other event type is expected traffic we deliberately drop.
    // Only a host_*-shaped type we can't route is genuinely anomalous;
    // reserve the warning for that and ignore the rest silently. (Warning
    // per message previously emitted tens of thousands of lines per session
    // — dominated by streaming deltas — which buried real errors in the log
    // and pushed it toward the 10 MB rotation cap.)
    if (type.startsWith("host_")) {
      log.warn(
        "[host-proxy-router] unrecognized host proxy message type, ignoring",
        { type },
      );
    }
    return;
  }

  const executor = executors.get(route.kind);

  if (executor) {
    if (route.action === "request") {
      executor.handleRequest(message, poster);
    } else {
      executor.handleCancel(message, poster);
    }
    return;
  }

  // No executor registered — post an error result so the daemon doesn't hang.
  const requestId = message.requestId as string | undefined;
  if (!requestId) {
    log.warn(
      "[host-proxy-router] message missing requestId, cannot post stub error",
      { type },
    );
    return;
  }

  log.warn("[host-proxy-router] executor not yet implemented", { type });

  switch (route.kind) {
    case "host_bash":
      void poster.postBashResult({
        requestId,
        stdout: "",
        stderr: "Executor not yet implemented",
        exitCode: 1,
        timedOut: false,
      });
      break;
    case "host_file":
      void poster.postFileResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_transfer":
      void poster.postTransferResult({
        requestId,
        isError: true,
        errorMessage: "Executor not yet implemented",
      });
      break;
    case "host_browser":
      void poster.postBrowserResult({
        requestId,
        content: "Executor not yet implemented",
        isError: true,
      });
      break;
    case "host_cu":
      void poster.postCuResult({
        requestId,
        executionError: "Executor not yet implemented",
      });
      break;
    case "host_ui_snapshot":
      void poster.postUiSnapshotResult({
        requestId,
        isError: true,
        errorMessage: "Executor not yet implemented",
      });
      break;
  }
}

// ---------------------------------------------------------------------------
// Public install / teardown
// ---------------------------------------------------------------------------

/**
 * Register the runtime's executors with the router. Call once from
 * `app.whenReady()`. Returns a teardown function for `before-quit`.
 */
export function installHostProxyBridge(runtime: HostProxyRuntime): () => void {
  hostRuntime = runtime;
  setHostProxyExecutorLogger(runtime.logger);
  executors.clear();
  for (const [kind, executor] of Object.entries(runtime.executors)) {
    if (executor) {
      setExecutor(kind, executor);
    }
  }
  return () => {
    executors.clear();
    runtime.teardownExecutors?.();
    hostRuntime = null;
  };
}

// ---------------------------------------------------------------------------
// Test seams
// ---------------------------------------------------------------------------

export const __testing = {
  get executors() {
    return executors;
  },
  dispatchMessage,
  setRuntime(runtime: HostProxyRuntime) {
    hostRuntime = runtime;
  },
  reset() {
    executors.clear();
    hostRuntime = null;
  },
};
