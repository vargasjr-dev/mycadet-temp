import { spawn } from "node:child_process";

import type { LockfileAssistant } from "../../lockfile-contract";
import { resolveCliInvocation } from "../../cli-invocation";
import type { CliInvocation } from "../../util";

// `wake` cold-starts a stopped assistant, so it can legitimately run far
// longer than a teardown like `retire`: the CLI waits up to 60s for the daemon
// to answer (plus another 60s if it falls back to a source daemon) and up to
// 30s for the gateway. The wrapper timeout is a safety net for a truly hung
// process, so it must sit above those documented readiness windows — otherwise
// a slow-but-succeeding wake gets killed and misreported as a timeout.
const WAKE_TIMEOUT_MS = 180_000;

export type WakeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

/**
 * The local topology's wake leg. INTERIM: the daemon-start core (the
 * compiled-runtime sibling resolution, the environment-scoped ports, the
 * app-server edge restore) still lives in the CLI, so the leg drives the
 * CLI's own `wake` command for the entry — zero drift by construction, since
 * the spawned process IS the command. This leg is the ROUTE's mechanism: the
 * `cadet wake` command itself calls its own wakeLocal directly (spawning
 * itself through the operation would recurse). When the daemon-start
 * machinery migrates into the package, this leg becomes the in-process
 * daemon start and the spawn disappears.
 */
export async function wakeLocalServices(
  entry: LockfileAssistant,
): Promise<WakeResult> {
  const resolved = await resolveCliInvocation();
  return runCli(resolved, ["wake", entry.assistantId], WAKE_TIMEOUT_MS);
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
