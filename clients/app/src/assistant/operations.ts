/**
 * The app bundle's assistant operations: typed wrappers over the same-origin
 * `/v1` routes the serving host answers through its operator route table —
 * the Electron shell's `app://` handler (mounted ahead of the gateway
 * data-plane forward) and, on dev, the Vite dev middleware. The operator
 * backend proxies to the cloud or the local machine as each route decides,
 * so nothing here knows or cares which one is behind the answer.
 *
 * The pairing exchange itself runs in the serving host's trusted process (the
 * shared host library the web dev server and the CLI web interface also use):
 * the device code and the credentials it buys never cross this boundary — the
 * renderer holds only the opaque session handle.
 *
 * Leaf module: must not import from chooser/screen modules.
 */

import type {
  LocalPairingPollResult,
  LocalPairingStartResult,
} from "@mycadet/ipc-contract";
import type { LockfileWriteResult } from "@mycadet/local-mode/contract";
import { isPublicBaseUrlRejection } from "@app/utils/pairing-address";

/** Fallback when a host returns no usable message of its own. */
const PAIRING_FALLBACK_ERROR = "Pairing failed. Please try again.";

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
  let result: LocalPairingStartResult | { ok: false; error?: string };
  try {
    const res = await fetch("/v1/remote-web/pairing-start", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ address }),
    });
    result = (await res.json().catch(() => null)) ?? { ok: false };
  } catch {
    result = { ok: false };
  }
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
 * `imported` answer has already persisted the pairing host-side; the caller
 * reloads its own view of the roster before resolving.
 */
export async function pollAssistantPairing(
  handle: string,
  name?: string,
): Promise<LocalPairingPollResult> {
  let result: LocalPairingPollResult | { ok: false; error?: string };
  try {
    const res = await fetch("/v1/remote-web/pairing-poll", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle, name }),
    });
    result = (await res.json().catch(() => null)) ?? { ok: false };
  } catch {
    result = { ok: false };
  }
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
    await fetch("/v1/remote-web/pairing-cancel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ handle }),
    });
  } catch {
    // Unreachable session: cancelled, spent, or the host itself is gone.
  }
}

/** Remove a paired entry and its stored guardian token from this device. */
export async function unpairAssistant(
  assistantId: string,
): Promise<LockfileWriteResult> {
  try {
    const res = await fetch(
      `/v1/assistants/${encodeURIComponent(assistantId)}/unpair`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      },
    );
    return (
      (await res.json().catch(() => null)) ??
      ({ ok: false, error: PAIRING_FALLBACK_ERROR } as LockfileWriteResult)
    );
  } catch {
    return { ok: false, error: PAIRING_FALLBACK_ERROR };
  }
}

/**
 * Provision an assistant through the serving host's hatch operation: the
 * host runs the Cadet CLI in its trusted process and returns the same
 * `{ ok, assistantId }` contract the CLI's own hatch reports; callers read
 * the resolution endpoint to discover the new assistant regardless. (The
 * platform's own hatch rides the app's cloud API.)
 *
 * The hatch coalesces: concurrent and remount-driven callers await the SAME
 * in-flight (or already-resolved) hatch instead of starting over, so HMR
 * remounts, StrictMode double-mounts, and the shell's session-driven
 * remounts never spawn duplicate hatches. A held promise answers only for
 * the SAME remote — the guard can outlive a trip through the hosting screen,
 * where the user may switch modes, and the abandoned mode's assistant must
 * not be adopted for the new choice. The guard releases on failure (a retry
 * re-hatches) and via `releaseHatchGuard` — the caller knows when the
 * handoff is genuinely done, and a later onboarding session must hatch a
 * brand-new assistant instead of reusing a resolved one.
 */
let hatchPromise: Promise<HatchAssistantResult> | null = null;
let hatchRemote: string | undefined;

export function releaseHatchGuard(): void {
  hatchPromise = null;
  hatchRemote = undefined;
}

type HatchAssistantResult = {
  ok: boolean;
  assistantId?: string;
  error?: string;
};

export async function hatchAssistant(
  remote?: string,
): Promise<HatchAssistantResult> {
  if (hatchPromise && hatchRemote !== remote) {
    releaseHatchGuard();
  }
  if (!hatchPromise) {
    hatchRemote = remote;
    hatchPromise = requestHatch(remote).then((result) => {
      if (!result.ok) {
        releaseHatchGuard();
      }
      return result;
    });
  }
  return hatchPromise;
}

async function requestHatch(
  remote?: string,
): Promise<HatchAssistantResult> {
  try {
    const res = await fetch("/v1/assistants/hatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ remote }),
    });
    const parsed = (await res.json().catch(() => null)) as {
      ok?: boolean;
      assistantId?: string;
      error?: string;
    } | null;
    return parsed?.ok
      ? { ok: true, assistantId: parsed.assistantId }
      : { ok: false, error: parsed?.error ?? PAIRING_FALLBACK_ERROR };
  } catch {
    return { ok: false, error: PAIRING_FALLBACK_ERROR };
  }
}
