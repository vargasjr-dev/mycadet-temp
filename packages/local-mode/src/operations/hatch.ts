import type { LockfileAssistant } from "../lockfile-contract";
import type { LifecycleReporter } from "../lifecycle-reporter";
import { hatchCloud } from "../remotes/cloud/hatch";
import { hatchDocker } from "../remotes/docker/hatch";
import { hatchLocal } from "../remotes/local/hatch";
import { hatchBaseten } from "../remotes/baseten/hatch";

/**
 * The hatch operation: the scoped surface's provision door. Unlike the
 * other operations it takes NO entry — a hatch creates one — so the router
 * switches on the REQUESTED remote, not `entry.cloud`.
 *
 * Every remote's leg owns the same post-hatch mechanics: the local arm
 * leases the guardian token, sets up the provider credentials, and
 * registers a Cadet-Cloud pick with the platform, exactly like the docker
 * leg; the baseten leg records the sandbox and its token the same way. The
 * interactive provider prompt stays at the CLI's command layer (it needs a
 * TTY), and so does the narration — the art banner and the hatched summary
 * print once, after this op returns, whatever the remote was.
 *
 * The local arm is the pure provision core under the machine-wide hatch
 * lock. The docker arm is the same shape at docker scale: toolchain check,
 * image acquisition (pull, or build from a source tree for the CLI's
 * --watch / --source flows), the network/volume stack, the config-overlay
 * staging, the containers, then the readiness wait and guardian-token
 * lease. The cloud arm is the platform hatch call with the caller's stored
 * token. The baseten arm builds, pushes, and creates the sandbox.
 */
export interface HatchAssistantParams {
  remote: string;
  name?: string | null;
  watch?: boolean;
  /** The merged hatch config (the CLI folds its provider choice in). */
  configValues?: Record<string, string>;
  /** Show the arms' per-service startup logs (the local leg). */
  verbose?: boolean;
  /** The caller's release version — the docker/baseten image stamp, the local daemon env. */
  version?: string;
  /** docker arm: build images from a source tree instead of pulling. */
  sourcePath?: string | null;
  /** docker arm: join an existing container's network namespace. */
  netnsContainer?: string;
  /** docker arm: explicit host gateway port (required with netnsContainer). */
  gatewayPort?: number;
  /** docker arm: PEM CA bundle bind-mounted into the assistant container. */
  assistantCaCertPath?: string;
  /** The caller's provider choice; undefined = skip provider credential setup. */
  provider?: string | null;
  precollectedApiKey?: string;
  /** The narration sink (defaults to the console reporter). */
  reporter?: LifecycleReporter;
}

export type HatchAssistantResult =
  | {
      ok: true;
      assistant: LockfileAssistant;
      /**
       * Whether the leg confirmed the assistant is up and serving — the
       * gate for the CLI's next-steps narration. The cloud and baseten
       * legs return before anything is confirmed ready (the platform
       * provisions asynchronously; the sandbox wakes itself), so they
       * report false.
       */
      ready: boolean;
      /** The hatched assistant's platform status (the cloud leg). */
      status?: string;
    }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchAssistant(
  params: HatchAssistantParams,
): Promise<HatchAssistantResult> {
  switch (params.remote) {
    case "local": {
      const {
        name,
        watch,
        configValues,
        verbose,
        version,
        provider,
        precollectedApiKey,
        reporter,
      } = params;
      const result = await hatchLocal({
        name,
        watch,
        configValues,
        verbose,
        version,
        provider,
        precollectedApiKey,
        reporter,
      });
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
        reporter,
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
        reporter,
      });
      if (!result.ok) return result;
      return { ok: true, assistant: result.entry, ready: result.ready };
    }
    case "baseten": {
      const { name, configValues, verbose, version, reporter } = params;
      const result = await hatchBaseten({
        name: name ?? undefined,
        configValues,
        verbose,
        version,
        reporter,
      });
      if (!result.ok) return result;
      return { ok: true, assistant: result.entry, ready: false };
    }
    case "cloud": {
      const result = await hatchCloud();
      if (!result.ok) return result;
      return {
        ok: true,
        assistant: result.entry,
        ready: false,
        status: result.assistant.status,
      };
    }
    default:
      return {
        ok: false,
        status: 400,
        error: `the hatch operation does not support the '${params.remote}' remote`,
      };
  }
}
