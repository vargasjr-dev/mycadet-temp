/**
 * The app bundle's local-mode seam: typed wrappers over the `window.cadet`
 * local-mode bridge, the only local-mode transport this bundle has. Web's
 * twin module (clients/web/src/runtime/local-mode-host.ts) falls back to
 * same-origin `/v1` HTTP routes at the conductor's shapes when no bridge
 * exists; the app bundle is never served by a web dev server or a local
 * host, so
 * there is no HTTP arm here — availability is the bridge itself, detected
 * on the pairing channel so an older shell degrades to a structured
 * "unsupported" error instead of a thrown invoke.
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

/** Fallback when a host seam returns no usable message of its own. */
const PAIRING_FALLBACK_ERROR = "Pairing failed. Please try again.";

/** The app bundle's Electron check, mirroring web's `isElectron`. */
export function isElectronRuntime(): boolean {
  return typeof window !== "undefined" && window.cadet?.platform === "electron";
}

/**
 * Whether a local-mode host backs this runtime. Only the Electron shell
 * carries the bridge (the native shells and webview-only builds have no
 * `window.cadet`), and only newer preloads expose the pairing channels —
 * detecting on the channel itself means an older shell reports
 * unavailable rather than failing later mid-exchange.
 */
export function isLocalModeHostAvailable(): boolean {
  return isElectronRuntime() && window.cadet?.localMode?.pairingStart != null;
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
  const pairingStart = window.cadet?.localMode?.pairingStart;
  if (!pairingStart) {
    return {
      ok: false,
      error:
        "Connecting a paired assistant is not supported by this app version",
    };
  }
  const result = await pairingStart(address);
  if (!result.ok) {
    return {
      ...result,
      error: hostError(result),
      // Runtime guard: the rejection rides an untyped host seam, so a
      // reason no caller has copy for degrades to the host's own message.
      rejection: isPublicBaseUrlRejection(result.rejection)
        ? result.rejection
        : undefined,
    };
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
  const pairingPoll = window.cadet?.localMode?.pairingPoll;
  if (!pairingPoll) {
    return {
      ok: false,
      error:
        "Connecting a paired assistant is not supported by this app version",
    };
  }
  const result = await pairingPoll(handle, name);
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
    await window.cadet?.localMode?.pairingCancel?.(handle);
  } catch {
    // Unreachable session: cancelled, spent, or the host itself is gone.
  }
}

/** Wake (start/restart) a local assistant's daemon and gateway. */
export async function wakeLocalAssistantHost(
  assistantId: string,
  options?: { repairGuardian?: boolean },
): Promise<{ ok: boolean; error?: string }> {
  const wake = window.cadet?.localMode?.wake;
  if (!wake) {
    return { ok: false, error: "Wake is not supported by this app version" };
  }
  return wake(assistantId, options);
}

/** Destructively remove a local assistant and its data. */
export async function retireLocalAssistantHost(
  assistantId: string,
): Promise<{ ok: boolean; error?: string }> {
  const retire = window.cadet?.localMode?.retire;
  if (!retire) {
    return { ok: false, error: "Retire is not supported by this app version" };
  }
  return retire(assistantId);
}

/** Remove a paired entry and its stored guardian token from this device. */
export async function unpairLocalAssistant(
  assistantId: string,
): Promise<LockfileWriteResult> {
  const unpair = window.cadet?.localMode?.unpair;
  if (!unpair) {
    return {
      ok: false,
      error: "Removing a paired assistant is not supported by this app version",
    };
  }
  return unpair(assistantId);
}

/** Lifecycle probe for a local assistant's daemon and gateway. */
export async function statusLocalAssistantHost(
  assistantId: string,
): Promise<LocalAssistantStatusResult> {
  const status = window.cadet?.localMode?.status;
  if (!status) {
    return {
      ok: false,
      status: 501,
      error: "Status is not supported by this app version",
    };
  }
  return status(assistantId);
}

/** The renderer-safe lockfile, parsed through the shared total validation. */
export async function readLockfileHost(): Promise<Lockfile> {
  const readLockfile = window.cadet?.localMode?.readLockfile;
  if (!readLockfile) {
    throw new Error("The local assistant host isn't available here.");
  }
  return parseLockfile(await readLockfile());
}
