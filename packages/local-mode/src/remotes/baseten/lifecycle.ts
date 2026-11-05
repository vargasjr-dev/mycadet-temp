/**
 * The baseten lifecycle legs — sleep, wake, retire — all delegating to the
 * cadet runtime RUNNING IN the sandbox: the image hatches a golden
 * assistant as a plain local hatch (the entrypoint wakes it at boot), so
 * each operation's own CLI command executes inside through
 * {@link execBasetenSandbox}, whose streaming output carries the inner
 * cadet's narration to the caller's terminal. Retire adds the platform
 * teardown: the sandbox itself is deleted (it stops billing the moment it
 * is), which also subsumes any inner state an already-terminated sandbox
 * would have lost.
 */

import { unlinkSync } from "node:fs";
import { basetenTokenPath } from "../../config.js";
import type { LockfileAssistant } from "../../lockfile-contract";
import { deleteBasetenSandbox } from "./api.js";
import {
  execBasetenSandbox,
  type BasetenExecService,
} from "./exec.js";

/** The entry fields every baseten lifecycle leg needs. */
type BasetenEntry = {
  assistantId: string;
  name: string;
  sandboxUrl: string;
};

/**
 * Entries hatched before the create-output parse (the era whose sandbox
 * name never reached the lockfile) carry neither name nor URL — the legs
 * cannot reach into a sandbox they cannot name. The re-hatch heals the
 * entry in place: create reuses the live sandbox and records its identity.
 */
function resolveEntryFields(
  entry: LockfileAssistant,
): { ok: true; fields: BasetenEntry } | { ok: false; status: number; error: string } {
  const baseten = entry.cloud === "baseten" ? entry : undefined;
  if (!baseten?.name || !baseten.sandboxUrl) {
    return {
      ok: false,
      status: 409,
      error: `Assistant '${entry.assistantId}' has no sandbox name/URL recorded — re-hatch with \`cadet hatch --remote baseten\` (it reuses the live sandbox and records its identity), then retry.`,
    };
  }
  return {
    ok: true,
    fields: {
      assistantId: baseten.assistantId,
      name: baseten.name,
      sandboxUrl: baseten.sandboxUrl,
    },
  };
}

async function execInSandbox(
  fields: BasetenEntry,
  command: string[],
  service?: BasetenExecService,
): Promise<number> {
  const { code } = await execBasetenSandbox({
    assistantId: fields.assistantId,
    sandboxUrl: fields.sandboxUrl,
    name: fields.name,
    command,
    service,
  });
  return code;
}

export type BasetenSleepOptions = {
  /** Stop even when an active phone-call keepalive lease holds the assistant. */
  force?: boolean;
  /** Wait for in-flight background work before stopping. */
  wait?: boolean;
};

/**
 * Sleep the sandbox's assistant: `cadet sleep` inside — the daemon stack
 * drains and stops like any local hatch, and once nothing runs the sandbox
 * goes on standby on its own (Baseten pauses an idle sandbox after ~30s and
 * bills only its storage until the next request wakes it).
 */
export async function sleepBaseten(
  entry: LockfileAssistant,
  options: BasetenSleepOptions = {},
): Promise<{ ok: true; kind: "remote" } | { ok: false; status: number; error: string }> {
  const fields = resolveEntryFields(entry);
  if (!fields.ok) return fields;
  try {
    const code = await execInSandbox(fields.fields, [
      "cadet",
      "sleep",
      ...(options.force ? ["--force"] : []),
      ...(options.wait ? ["--wait"] : []),
    ]);
    if (code !== 0) {
      return {
        ok: false,
        status: 500,
        error: `'cadet sleep' inside the sandbox exited with ${code}.`,
      };
    }
    return { ok: true, kind: "remote" };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Wake the sandbox's assistant: `cadet wake` inside. The request itself
 * wakes a standby sandbox (Baseten resumes it on the next request), and the
 * entrypoint's own `cadet wake &` makes this idempotent — the services that
 * are already up stay up.
 */
export async function wakeBaseten(
  entry: LockfileAssistant,
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const fields = resolveEntryFields(entry);
  if (!fields.ok) return fields;
  try {
    const code = await execInSandbox(fields.fields, ["cadet", "wake"]);
    if (code !== 0) {
      return {
        ok: false,
        status: 500,
        error: `'cadet wake' inside the sandbox exited with ${code}.`,
      };
    }
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      status: 500,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Retire the sandbox's assistant: `cadet retire --yes` inside tears the
 * inner hatch down gracefully, then the sandbox itself is deleted — the
 * platform teardown that stops the billing. The inner retire is
 * best-effort: a sandbox that already terminated or expired has no inner
 * state left to retire, so only the delete's failure (beyond a 404) fails
 * the operation. The sandbox token file beside the lockfile goes with the
 * entry.
 */
export async function retireBaseten(entry: LockfileAssistant): Promise<{
  ok: true;
} | { ok: false; status: number; error: string }> {
  const fields = resolveEntryFields(entry);
  if (!fields.ok) return fields;
  let innerError: string | undefined;
  try {
    const code = await execInSandbox(fields.fields, ["cadet", "retire", "--yes"]);
    if (code !== 0) {
      innerError = `'cadet retire' inside the sandbox exited with ${code}.`;
    }
  } catch (err) {
    innerError = err instanceof Error ? err.message : String(err);
  }

  try {
    await deleteBasetenSandbox(fields.fields.name);
  } catch (err) {
    const deleteError = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      status: 502,
      error: innerError
        ? `${innerError} The sandbox delete also failed: ${deleteError}`
        : `The sandbox delete failed: ${deleteError}`,
    };
  }

  try {
    unlinkSync(basetenTokenPath(fields.fields.assistantId));
  } catch {
    // Best-effort — the token file may never have existed (the CLI-arm
    // hatch needs no key, so no token was minted).
  }
  return { ok: true };
}
