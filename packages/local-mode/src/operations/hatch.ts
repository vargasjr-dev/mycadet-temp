import type { LockfileAssistant } from "../lockfile-contract";
import { hatchCloud } from "../remotes/cloud/hatch";
import { hatchDocker } from "../remotes/docker/hatch";
import { hatchLocal } from "../remotes/local/hatch";

/**
 * The hatch operation: the scoped surface's provision door. Unlike the
 * other operations it takes NO entry — a hatch creates one — so the router
 * switches on the REQUESTED remote, not `entry.cloud`.
 *
 * The local arm is the pure provision core: allocate, write the fresh
 * daemon's first-boot config, wake, persist — under the machine-wide hatch
 * lock. The interactive provider prompt, the guardian-token lease, the
 * provider credential setup, and the cloud registration are the CLI's
 * ceremony around this door (they need a TTY and cli-side credential
 * machinery); non-TTY callers — the desktop's in-process hatch, the dev
 * server's runHatch spawn — get the mechanics only, which is exactly what
 * they always skipped anyway.
 *
 * The docker arm is the same shape at docker scale: toolchain check, image
 * acquisition (pull, or build from a source tree for the CLI's --watch /
 * --source flows), the network/volume stack, the config-overlay staging,
 * the containers, then the readiness wait and guardian-token lease — under
 * the caller's narration sink. The watch-mode file watcher is dev machinery
 * the leg itself runs. The cloud arm is the platform hatch call with the
 * caller's token.
 */
export interface HatchAssistantParams {
  remote: string;
  name?: string | null;
  watch?: boolean;
  /** The merged hatch config (the CLI folds its provider choice in). */
  configValues?: Record<string, string>;
  /** docker arm: build images from a source tree instead of pulling. */
  sourcePath?: string | null;
  /** docker arm: join an existing container's network namespace. */
  netnsContainer?: string;
  /** docker arm: explicit host gateway port (required with netnsContainer). */
  gatewayPort?: number;
  /** docker arm: PEM CA bundle bind-mounted into the assistant container. */
  assistantCaCertPath?: string;
  /** docker arm: the CLI's release version — owns the image resolution. */
  version?: string;
  /** The caller's provider choice; undefined = skip provider credential setup. */
  provider?: string | null;
  precollectedApiKey?: string;
  /** The narration sink (defaults to console.log). */
  log?: (msg: string) => void;
}

export type HatchAssistantResult =
  | {
      ok: true;
      assistant: LockfileAssistant;
      /** False when the docker leg returned early (createOnly) or its readiness wait timed out in watch mode. */
      ready: boolean;
    }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchAssistant(
  params: HatchAssistantParams,
): Promise<HatchAssistantResult> {
  switch (params.remote) {
    case "local": {
      const { name, watch, configValues } = params;
      const result = await hatchLocal({ name, watch, configValues });
      if (!result.ok) return result;
      return { ok: true, assistant: result.entry, ready: true };
    }
    case "docker": {
      const {
        name,
        watch,
        configValues,
        sourcePath,
        netnsContainer,
        gatewayPort,
        assistantCaCertPath,
        version,
        provider,
        precollectedApiKey,
        log,
      } = params;
      const result = await hatchDocker({
        name,
        watch,
        configValues,
        sourcePath,
        netnsContainer,
        gatewayPort,
        assistantCaCertPath,
        version,
        provider,
        precollectedApiKey,
        log,
      });
      if (!result.ok) return result;
      return { ok: true, assistant: result.entry, ready: result.ready };
    }
    case "cloud": {
      const result = await hatchCloud();
      if (!result.ok) return result;
      return { ok: true, assistant: result.entry, ready: true };
    }
    default:
      return {
        ok: false,
        status: 400,
        error: `the hatch operation does not cover '${params.remote}' yet — use \`cadet hatch --remote ${params.remote}\``,
      };
  }
}
