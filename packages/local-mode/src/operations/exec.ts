import { readCloudToken } from "../cloud-auth";
import { getCloudBaseUrl } from "@mycadet/shared";
import { cliCommand } from "../environment";
import type { LockfileAssistant } from "../lockfile-contract";
import { execBasetenSandbox } from "../remotes/baseten/exec";
import {
  execAppleContainer,
  sshAppleContainer,
} from "../remotes/apple-container/exec";
import { execDocker } from "../remotes/docker/exec";
import { execLocal } from "../remotes/local/exec";
import type { ServiceName } from "../remotes/docker/statefulset";
import {
  interactiveSession,
  nonInteractiveExec,
  shellEscapeArgs,
} from "../remotes/cloud/exec";

/** The exec timeout a caller implies by passing nothing (`--timeout` omitted). */
export const DEFAULT_EXEC_TIMEOUT = 30_000;

/** Options the exec operation dispatches on. */
export interface ExecCommandOptions {
  /** The full argv after `--` — the command to run inside the service. */
  command: string[];
  /** Which service's directory/state the command runs against. */
  service: ServiceName;
  /** Interactive mode with TTY (like docker exec -it). */
  interactive?: boolean;
  /** Cloud only: show debug output. */
  verbose?: boolean;
  /** Milliseconds before the sandbox kills the process; 0 = never. Feeding
   * the default is the same as feeding nothing. */
  timeoutMs?: number;
}

/**
 * An exec's outcome: the command either ran (its own exit code — its output
 * already went to the caller's stdio) or was refused before any spawn
 * (status + the diagnostic the CLI prints).
 */
export type ExecCommandResult =
  | { ok: true; code: number }
  | { ok: false; code: number }
  | { ok: false; status: number; error: string };

/**
 * The exec operation: run a command inside an assistant's service — the
 * remote -> method router, like sleep/wake. Local runs the command on the
 * host with the instance's bin/ shims on PATH; docker dials the service
 * container; baseten rides the sandbox's execution API; apple-container
 * dials the management socket and cloud opens a terminal session — every
 * leg lives here, like wake.
 */
export async function execCommand(
  entry: LockfileAssistant,
  opts: ExecCommandOptions,
): Promise<ExecCommandResult> {
  switch (entry.cloud) {
    case "local":
      return await execLocal(entry, opts);
    case "docker":
      return await execDocker(entry, opts);
    case "apple-container": {
      const fullServiceName = `cadet-${opts.service}`;
      if (opts.interactive) {
        await sshAppleContainer(entry, opts.command, fullServiceName);
      } else {
        await execAppleContainer(entry, opts.command, fullServiceName);
      }
      return { ok: true, code: 0 };
    }
    case "cloud": {
      const token = readCloudToken();
      if (!token) {
        return {
          ok: false,
          status: 401,
          error:
            "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
        };
      }
      const assistant = {
        assistantId: entry.assistantId,
        token,
        cloudUrl: getCloudBaseUrl(),
      };
      const serviceParam =
        opts.service === "assistant" ? undefined : opts.service;
      if (opts.interactive) {
        await interactiveSession(
          assistant,
          shellEscapeArgs(opts.command),
          serviceParam,
        );
        return { ok: true, code: 0 };
      }
      // Non-interactive: sentinel-based output capture; exits with the
      // command's own exit code.
      await nonInteractiveExec(assistant, opts.command, {
        verbose: opts.verbose,
        timeoutMs: opts.timeoutMs ?? DEFAULT_EXEC_TIMEOUT,
        service: serviceParam,
      });
      return { ok: true, code: 0 };
    }
    case "baseten": {
      if (!entry.name) {
        return {
          ok: false,
          status: 400,
          error:
            `assistant '${entry.assistantId}' has no sandbox name ` +
            "recorded — re-hatch with `cadet hatch --remote baseten` to fix.",
        };
      }
      const { code } = await execBasetenSandbox({
        assistantId: entry.assistantId,
        sandboxUrl: entry.sandboxUrl,
        name: entry.name,
        command: opts.command,
        service: opts.service,
        interactive: opts.interactive,
        ...(opts.timeoutMs !== undefined &&
        opts.timeoutMs !== DEFAULT_EXEC_TIMEOUT
          ? { timeoutSeconds: Math.round(opts.timeoutMs / 1000) }
          : {}),
      });
      return code === 0 ? { ok: true, code } : { ok: false, code };
    }
    default:
      return {
        ok: false,
        status: 400,
        error:
          `'${cliCommand()} exec' is not supported for ${entry.cloud} ` +
          "assistants — supported: local, docker, apple-container, cloud, baseten.",
      };
  }
}
