import { extractErrorMessage } from "@/utils/api-errors";

import type { GetAssistantResult } from "@/assistant/api";
import type { AssistantResolutionState } from "@/assistant/types";

/**
 * Error code the Electron main process's cloud proxy puts in its
 * synthesized 502 body when `net.fetch` itself failed (the request
 * never reached the cloud — e.g. `net::ERR_NETWORK_CHANGED` while
 * Wi-Fi reassociates after sleep). Mirrors `PROXY_NETWORK_ERROR_CODE`
 * in `packages/electron-desktop/src/cloud-forward.ts`; the two must stay in
 * sync, but there is no shared package between the renderer and the
 * Electron main bundle to host the constant.
 */
export const PROXY_NETWORK_ERROR_CODE = "proxy_network_error";

export const TRANSPORT_ERROR_MESSAGE = "Connection interrupted. Reconnecting…";

/**
 * Does this failed `/assistant/` result look like a transport failure
 * (device offline, network flapping on wake) rather than a server
 * answer? Two signals:
 *   - the structured code the Electron cloud proxy attaches when
 *     its own `net.fetch` rejected, and
 *   - a raw Chromium `net::ERR_*` string in the detail (older
 *     Electron builds forwarded the error message verbatim).
 */
export function isTransportShapedError(
  error: Record<string, unknown>,
): boolean {
  if (error.code === PROXY_NETWORK_ERROR_CODE) {
    return true;
  }
  const detail = typeof error.detail === "string" ? error.detail : "";
  return detail.includes("net::ERR_");
}

/**
 * Whether this resolution kind can serve chat queries and the surfaces
 * that mirror them (sidebar, Home Screen widgets, dock badge).
 *
 * `active` is a running assistant. `self_hosted` is too: the cloud
 * record is provisioned and the daemon is the runtime, so the same
 * conversation list that ChatPage already renders must also reach the
 * layout-owned queries.
 */
export function assistantStateCanServeChat(
  kind: AssistantResolutionState["kind"],
): boolean {
  return kind === "active" || kind === "self_hosted";
}

/**
 * Map a `/assistant/` result onto the resolution state.
 *
 * Transport-shaped failures get friendly copy (never a raw `net::ERR_*`
 * string) and the `transient` marker the chat page renders with
 * reconnecting copy instead of a terminal error.
 */
export function resolveAssistantLifecycleState(
  result: GetAssistantResult,
): AssistantResolutionState {
  if (result.ok) {
    switch (result.data.status) {
      case "active":
        return {
          kind: "active",
          isLocal: result.data.is_local ?? false,
          maintenanceMode: result.data.maintenance_mode,
        };
      case "initializing":
        return { kind: "initializing" };
      case "to_be_deleted":
        return { kind: "cleaning_up" };
      default:
        return {
          kind: "error",
          message: `Unexpected assistant status: ${result.data.status}`,
        };
    }
  }

  if (result.status === 404) {
    return { kind: "auto_hatch" };
  }

  if (isTransportShapedError(result.error)) {
    return {
      kind: "error",
      transient: true,
      message: TRANSPORT_ERROR_MESSAGE,
    };
  }

  return {
    kind: "error",
    message: extractErrorMessage(
      result.error,
      undefined,
      "Failed to check assistant status.",
    ),
  };
}

export function shouldRecoverFromHatchFailure(status?: number): boolean {
  return status === undefined || status >= 500;
}

/**
 * The Django hatch endpoint returns 503 + `{ code: "platform_hosted_disabled" }`
 * when platform hosting is unavailable (global capacity kill-switch). The
 * onboarding flow surfaces this as a user-friendly message instead of
 * recovering / retrying.
 */
export const PLATFORM_HOSTED_DISABLED_CODE = "platform_hosted_disabled";

export const PLATFORM_HOSTED_DISABLED_MESSAGE =
  "We are at capacity for Cadet Managed Assistants, more will be available soon!";

export function isCloudHostedDisabled(
  status: number | undefined,
  error: Record<string, unknown> | undefined,
): boolean {
  if (status !== 503) {
    return false;
  }
  return error?.code === PLATFORM_HOSTED_DISABLED_CODE;
}
