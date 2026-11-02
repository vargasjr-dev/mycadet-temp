/**
 * The app bundle's local-mode seam: typed wrappers over the same-origin
 * `/v1` routes the serving host answers through its operator route table —
 * the Electron shell's `app://` handler (mounted ahead of the gateway
 * data-plane forward) and, on dev, the Vite dev middleware. There is no
 * bridge arm: the operations run in the serving host's trusted process, and
 * the wire contract is the same on every host, so the renderer never learns
 * which one served it.
 *
 * The pairing exchange itself runs in the shell's main process (the shared
 * host library the web dev server and the CLI web interface also use): the
 * device code and the credentials it buys never cross this boundary — the
 * renderer holds only the opaque session handle.
 *
 * Leaf module: must not import from chooser/screen modules.
 */

import type {
  LocalAssistantStatusResult,
  LocalPairingPollResult,
  LocalPairingStartResult,
} from "@mycadet/ipc-contract";
import {
  parseLockfile,
  type Lockfile,
  type LockfileAssistant,
  type LockfileWriteResult,
} from "@mycadet/local-mode/contract";
import { isPublicBaseUrlRejection } from "@app/utils/pairing-address";

export type {
  Lockfile,
  LockfileAssistant,
  LocalPairingPollResult,
  LocalPairingStartResult,
};

/** Failure surfaced when no local-mode host backs this runtime. */
const LOCAL_HOST_UNAVAILABLE_ERROR =
  "The local assistant host isn't available here.";

/** Fallback when a host returns no usable message of its own. */
const PAIRING_FALLBACK_ERROR = "Pairing failed. Please try again.";

/** The app bundle's Electron check, mirroring web's `isElectron`. */
export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && window.cadet?.platform === "electron";
}

/**
 * Whether a local-mode host backs this runtime. Only the Electron shell
 * serves the operator routes to this bundle (the native shells and
 * webview-only builds have no `window.cadet`), so the check is the platform
 * itself — the routes need no capability detection.
 */
export function isLocalModeHostAvailable(): boolean {
  return isElectronRuntime();
}

/**
 * POST a local-mode command and read back its `{ ok, ... }` result. Always
 * resolves, never throws: an unavailable host (no request sent) and a non-JSON
 * response both resolve to `{ ok: false }`.
 */
async function postLocalCommand<T extends { ok: boolean }>(
  path: string,
  body: unknown,
): Promise<T | { ok: false; error: string }> {
  if (!isLocalModeHostAvailable()) {
    return { ok: false, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
  try {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (res.status === 204) {
      return { ok: true } as T;
    }
    const parsed = (await res.json().catch(() => null)) as T | null;
    return parsed ?? { ok: false, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  } catch {
    return { ok: false, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
}

function hostError(result: { error?: string }): string {
  return result.error || PAIRING_FALLBACK_ERROR;
}

/**
 * Begin pairing with the assistant at `address`, a pairing link copied
 * from its "Pair a device" card or a bare `https://host` URL. The device
 * code stays in the main process; the reply is the opaque `handle` plus,
 * when the address carried no approved code of its own, the code to
 * approve on the assistant's machine.
 */
export async function startAssistantPairing(
  address: string,
): Promise<LocalPairingStartResult> {
  const result = await postLocalCommand<LocalPairingStartResult>(
    "/v1/remote-web/pairing-start",
    { address },
  );
  if (!result.ok) {
    // Runtime guard: the rejection rides an untyped host response, so a
    // reason no caller has copy for degrades to the host's own message.
    const rejection =
      "rejection" in result && isPublicBaseUrlRejection(result.rejection)
        ? result.rejection
        : undefined;
    return { ...result, error: hostError(result), rejection };
  }
  return result;
}

/**
 * One exchange attempt for a live pairing session. Transport only — an
 * `imported` answer has already persisted the lockfile entry host-side;
 * the caller reloads its own view of the lockfile before resolving.
 */
export async function pollAssistantPairing(
  handle: string,
  name?: string,
): Promise<LocalPairingPollResult> {
  const result = await postLocalCommand<LocalPairingPollResult>(
    "/v1/remote-web/pairing-poll",
    { handle, name },
  );
  if (!result.ok) {
    return { ...result, error: hostError(result) };
  }
  if (result.status === "pending") {
    return result;
  }
  if (!result.assistantId) {
    return { ok: false, error: PAIRING_FALLBACK_ERROR };
  }
  return { ...result, accessOnly: result.accessOnly === true };
}

/**
 * Forget a pending pairing session, so its code cannot be exchanged later.
 * A handle the host no longer knows is already the outcome wanted, so a
 * rejection resolves quietly.
 */
export async function cancelAssistantPairing(handle: string): Promise<void> {
  try {
    await postLocalCommand<{ ok: boolean }>("/v1/remote-web/pairing-cancel", {
      handle,
    });
  } catch {
    // Unreachable session: cancelled, spent, or the host itself is gone.
  }
}

/** Remove a paired entry and its stored guardian token from this device. */
export async function unpairLocalAssistant(
  assistantId: string,
): Promise<LockfileWriteResult> {
  return postLocalCommand<LockfileWriteResult>(
    `/v1/assistants/${encodeURIComponent(assistantId)}/unpair`,
    {},
  );
}

/** Lifecycle probe for a local assistant's daemon and gateway. */
export async function statusLocalAssistantHost(
  assistantId: string,
): Promise<LocalAssistantStatusResult> {
  if (!isLocalModeHostAvailable()) {
    return { ok: false, status: 0, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
  let res: Response;
  try {
    res = await fetch(`/v1/assistants/${encodeURIComponent(assistantId)}/`);
  } catch {
    return { ok: false, status: 0, error: LOCAL_HOST_UNAVAILABLE_ERROR };
  }
  const parsed = (await res
    .json()
    .catch(() => null)) as LocalAssistantStatusResult | null;
  return (
    parsed ?? {
      ok: false,
      status: res.status,
      error: LOCAL_HOST_UNAVAILABLE_ERROR,
    }
  );
}

/** The renderer-safe lockfile, parsed through the shared total validation. */
export async function readLockfileHost(): Promise<Lockfile> {
  if (!isLocalModeHostAvailable()) {
    throw new Error(LOCAL_HOST_UNAVAILABLE_ERROR);
  }
  const res = await fetch("/v1/assistants/");
  if (!res.ok) {
    throw new Error(`lockfile fetch failed: ${res.status}`);
  }
  return parseLockfile(await res.json());
}

/**
 * Provision a local assistant. The serving host runs the Cadet CLI in its
 * trusted process and returns the same `{ ok, assistantId }` contract the
 * CLI's own hatch reports; callers reload the lockfile to discover the new
 * assistant regardless.
 */
export async function hatchLocalAssistantHost(
  remote?: string,
): Promise<{ ok: boolean; assistantId?: string; error?: string }> {
  return postLocalCommand("/v1/assistants/hatch", { remote });
}
