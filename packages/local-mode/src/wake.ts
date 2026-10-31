import { spawn } from "node:child_process";

import type { CliInvocation } from "./util";
import { resolveCliInvocation } from "./cli-invocation";

// `wake` cold-starts a stopped assistant, so it can legitimately run far
// longer than a teardown like `retire`: the CLI waits up to 60s for the daemon
// to answer (plus another 60s if it falls back to a source daemon) and up to
// 30s for the gateway. The wrapper timeout is a safety net for a truly hung
// process, so it must sit above those documented readiness windows — otherwise
// a slow-but-succeeding wake gets killed and misreported as a timeout.
const WAKE_TIMEOUT_MS = 180_000;

/** The re-lease runs after the wake, inside the same safety-net window. */
const REPAIR_TIMEOUT_MS = 60_000;

export type WakeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export interface WakeOptions {
  /** Re-provision the guardian credential after the wake (the gateway's bootstrap reset + re-lease, the same machinery `cadet gateway token refresh` runs). Revokes the assistant's other device-bound tokens, so callers must gate this behind explicit user confirmation. */
  repairGuardian?: boolean;
}

/**
 * Start (or restart) a local assistant's daemon and gateway via the CLI's
 * `wake`, which also re-seeds the guardian token from a sibling environment.
 *
 * This is the non-destructive repair primitive: it revives a stopped or
 * mis-seeded local assistant in place without touching its data or identity,
 * the same way the native client re-pairs on a failed connection. Mirrors
 * {@link runRetire}'s never-reject contract so each host wires transport once
 * and surfaces a structured failure rather than a thrown error.
 */
export async function runWake(
  assistantId: string,
  options?: WakeOptions,
): Promise<WakeResult> {
  const resolved = await resolveCliInvocation();
  return runCli(resolved, ["wake", assistantId], WAKE_TIMEOUT_MS).then(
    (woken) => {
      if (!woken.ok || !options?.repairGuardian) {
        return woken;
      }
      // The credential repair is the gateway's own machinery now: the
      // gateway is up after the wake, so the re-lease runs against it.
      return runCli(
        resolved,
        ["gateway", "token", "refresh", assistantId],
        REPAIR_TIMEOUT_MS,
      );
    },
  );
}

function runCli(
  invocation: CliInvocation,
  args: string[],
  timeoutMs: number,
): Promise<WakeResult> {
  return new Promise((resolve) => {
    const child = spawn(invocation.command, [...invocation.baseArgs, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: WakeResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `CLI invocation timed out after ${timeoutMs / 1000} seconds`,
      });
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code === 0) {
        finish({ ok: true });
      } else {
        finish({ ok: false, status: 500, error: stderr || stdout });
      }
    });

    child.on("error", (err) => {
      finish({
        ok: false,
        status: 500,
        error: `Failed to spawn CLI: ${err.message}`,
      });
    });
  });
}
