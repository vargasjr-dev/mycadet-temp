import type { LockfileAssistant } from "../lockfile-contract";
import { provisionLocalHatch } from "../remotes/local/provision";

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
 * The docker arm stays CLI-side for now: its image-source paths, netns
 * handling, and CA-cert staging still live on cli-side seams.
 */
export interface HatchAssistantParams {
  remote: string;
  name?: string | null;
  watch?: boolean;
  /** The merged hatch config (the CLI folds its provider choice in). */
  configValues?: Record<string, string>;
}

export type HatchAssistantResult =
  | { ok: true; assistantId: string; entry: LockfileAssistant }
  | { ok: false; status: number; error: string; assistantId?: string };

export async function hatchAssistant(
  params: HatchAssistantParams,
): Promise<HatchAssistantResult> {
  switch (params.remote) {
    case "local": {
      const provisioned = await provisionLocalHatch(params);
      if (!provisioned.ok) return provisioned;
      return {
        ok: true,
        assistantId: provisioned.entry.assistantId,
        entry: provisioned.entry,
      };
    }
    default:
      return {
        ok: false,
        status: 400,
        error: `the hatch operation does not cover '${params.remote}' yet — use \`cadet hatch --remote ${params.remote}\``,
      };
  }
}
