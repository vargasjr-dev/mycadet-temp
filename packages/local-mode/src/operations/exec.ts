import { readCloudToken } from "../cloud-auth";
import { cliCommand } from "../environment";
import type { LockfileAssistant } from "../lockfile-contract";
import { isCloudEntry } from "../lockfile-contract";
import { execBasetenSandbox } from "../remotes/baseten/exec";
import { execDocker } from "../remotes/docker/exec";
import { execLocal } from "../remotes/local/exec";
import type { ServiceName } from "../remotes/docker/statefulset";

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
 * The transports only the CLI owns — the operator dispatches every cloud to
 * the right leg, and the host provides the two remote transports that live
 * outside this package (apple-container's ssh, cloud's terminal session).
 * Absent transports mean the topology is refused with a diagnostic.
 */
export interface ExecCommandHost {
  appleContainer?(
    entry: Extract<LockfileAssistant, { cloud: "apple-container" }>,
    opts: ExecCommandOptions,
    /** The sandbox-VM service name, e.g. `cadet-gateway`. */
    fullServiceName: string,
  ): Promise<void>;
  cloud?(
    entry: Extract<LockfileAssistant, { cloud: "cloud" }>,
    opts: ExecCommandOptions,
    /** The verified cloud token — the operator resolved it. */
    token: string,
  ): Promise<void>;
}

/**
 * The exec operation: run a command inside an assistant's service — the
 * remote -> method router, like sleep/wake. Local runs the command on the
 * host with the instance's bin/ shims on PATH; docker dials the service
 * container; baseten rides the sandbox's execution API (its name/URL are
 * contract-required on the entry); apple-container and cloud ride the
 * host-provided transports.
 */
export async function execCommand(
  entry: LockfileAssistant,
  opts: ExecCommandOptions,
  host: ExecCommandHost = {},
): Promise<ExecCommandResult> {
  switch (entry.cloud) {
    case "local":
      return await execLocal(entry, opts);
    case "docker":
      return await execDocker(entry, opts);
    case "apple-container": {
      if (!host.appleContainer) {
        return {
          ok: false,
          status: 400,
          error: `'${cliCommand()} exec' for apple-container assistants needs the CLI host transport.`,
        };
      }
      await host.appleContainer(entry, opts, `cadet-${opts.service}`);
      return { ok: true, code: 0 };
    }
    case "cloud": {
      if (!host.cloud || !isCloudEntry(entry)) {
        return {
          ok: false,
          status: 400,
          error: `'${cliCommand()} exec' for cloud assistants needs the CLI host transport.`,
        };
      }
      const token = readCloudToken();
      if (!token) {
        return {
          ok: false,
          status: 401,
          error:
            "Not logged in. Run `cadet login` first to authenticate with Cadet Cloud.",
        };
      }
      await host.cloud(entry, opts, token);
      return { ok: true, code: 0 };
    }
    case "baseten": {
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
