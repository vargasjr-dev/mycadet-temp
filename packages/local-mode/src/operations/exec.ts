import { cliCommand } from "../environment";
import type { LockfileAssistant } from "../lockfile-contract";
import { execBasetenSandbox } from "../remotes/baseten/exec";
import { execDocker } from "../remotes/docker/exec";
import { execLocal } from "../remotes/local/exec";
import type { ExecLegOptions, ExecLegResult } from "../remotes/local/exec";

/**
 * The exec operation: run a command inside an assistant's service — the
 * remote -> method router, like sleep/wake. Local runs the command on the
 * host with the instance's bin/ shims on PATH; docker dials the service
 * container; baseten rides the sandbox's execution API. apple-container and
 * cloud assistants are refused the same way every other operation refuses
 * them — their exec surfaces live with the CLI's own transport code.
 */
export type ExecCommandResult = ExecLegResult;

export async function execCommand(
  entry: LockfileAssistant,
  opts: ExecLegOptions & {
    /** Baseten only: sandbox exec timeout, seconds. */
    timeoutSeconds?: number;
  },
): Promise<ExecCommandResult> {
  switch (entry.cloud) {
    case "local":
      return await execLocal(entry, opts);
    case "docker":
      return await execDocker(entry, opts);
    case "baseten": {
      if (!entry.name || !entry.sandboxUrl) {
        return {
          ok: false,
          status: 400,
          error:
            `assistant '${entry.assistantId}' has no sandbox name/URL ` +
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
        ...(opts.timeoutSeconds !== undefined
          ? { timeoutSeconds: opts.timeoutSeconds }
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
