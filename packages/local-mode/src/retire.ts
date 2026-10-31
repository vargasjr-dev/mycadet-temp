import { spawn } from "node:child_process";

import {
  DAEMON_STOP_TIMEOUT_MS,
  HOST_WRAPPER_LONG_HEADROOM_MS,
} from "./lifecycle-budgets";
import type { CliInvocation } from "./util";
import { resolveCliInvocation } from "./cli-invocation";

const RETIRE_TIMEOUT_MS =
  DAEMON_STOP_TIMEOUT_MS + HOST_WRAPPER_LONG_HEADROOM_MS;

export type RetireResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export interface RetireOptions {
  cloudToken?: string;
}

export async function runRetire(
  assistantId: string,
  options: RetireOptions = {},
): Promise<RetireResult> {
  const resolved = await resolveCliInvocation();
  return new Promise((resolve) => {
    const child = spawn(
      resolved.command,
      [...resolved.baseArgs, "retire", assistantId, "--yes"],
      {
        ...(options.cloudToken
          ? {
              env: {
                ...process.env,
                CADET_PLATFORM_TOKEN: options.cloudToken,
              },
            }
          : {}),
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    let stdout = "";
    let stderr = "";
    let done = false;

    const finish = (result: RetireResult) => {
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
        error: `Retire timed out after ${RETIRE_TIMEOUT_MS / 1000} seconds`,
      });
    }, RETIRE_TIMEOUT_MS);

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
