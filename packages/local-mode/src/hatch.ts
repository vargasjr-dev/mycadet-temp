import { spawn } from "node:child_process";

import {
  DAEMON_READINESS_WINDOW_MS,
  DAEMON_STOP_TIMEOUT_MS,
  HOST_WRAPPER_LONG_HEADROOM_MS,
} from "./lifecycle-budgets";
import type { CliInvocation } from "./util";
import { resolveCliInvocation } from "./cli-invocation";

// A hatch whose daemon comes up but never becomes ready spends the readiness
// window first, then rolls back through the full daemon stop, so the wrapper
// has to cover both plus the gateway and CES cleanup that follows.
const HATCH_TIMEOUT_MS =
  DAEMON_READINESS_WINDOW_MS +
  DAEMON_STOP_TIMEOUT_MS +
  HOST_WRAPPER_LONG_HEADROOM_MS;
// Docker hatches pull images and wait up to 5 min for container readiness.
const DOCKER_HATCH_TIMEOUT_MS = 10 * 60 * 1000;

export type HatchResult =
  | { ok: true; assistantId: string }
  | { ok: false; status: number; error: string };

export interface RunHatchOptions {
  remote?: string;
}

export async function runHatch(
  options?: RunHatchOptions,
): Promise<HatchResult> {
  const resolved = await resolveCliInvocation();
  return new Promise((resolve) => {
    const args = [...resolved.baseArgs, "hatch"];
    if (options?.remote) {
      args.push("--remote", options.remote);
    }

    const child = spawn(resolved.command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: HatchResult) => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      resolve(result);
    };

    const timeoutMs =
      options?.remote === "docker" ? DOCKER_HATCH_TIMEOUT_MS : HATCH_TIMEOUT_MS;
    const timeout = setTimeout(() => {
      child.kill("SIGTERM");
      finish({
        ok: false,
        status: 500,
        error: `Hatch timed out after ${timeoutMs / 1000} seconds`,
      });
    }, timeoutMs);

    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.on("close", (code) => {
      if (code !== 0) {
        const error =
          stderr.trim() ||
          stdout.trim() ||
          `Hatch failed: the CLI exited with code ${code ?? "unknown"} and produced no output.`;
        finish({ ok: false, status: 500, error });
        return;
      }
      const assistantId = stdout
        .match(/Hatching (?:local|Docker) assistant:\s+(.+)/)?.[1]
        ?.trim();
      if (!assistantId) {
        finish({
          ok: false,
          status: 500,
          error:
            "Hatch reported success but no assistant id was found in the CLI output.",
        });
        return;
      }
      finish({ ok: true, assistantId });
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
