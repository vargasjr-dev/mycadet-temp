import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import { wakeLocal } from "../remotes/local/wake";
import { wakeDocker } from "../remotes/docker/wake";

/**
 * The wake operation: start (or restart) an assistant's services in place —
 * the non-destructive repair primitive. A local wake revives the daemon
 * stack (healing conflicted ports, backfilling a missing bootstrap secret,
 * restarting the gateway when the secret was just backfilled); a docker wake
 * starts the service containers. Like sleep, the operation is just a
 * remote -> method router: every unsupported remote refuses the same way.
 */
export type WakeResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

export async function wakeAssistant(
  entry: LockfileAssistant,
): Promise<WakeResult> {
  switch (entry.cloud) {
    case "local":
      return await wakeLocal(entry);
    case "docker":
      return await wakeDocker(entry);
    default:
      return {
        ok: false,
        status: 400,
        error: `'${cliCommand()} wake' is unsupported for a ${entry.cloud} assistant.`,
      };
  }
}
