import type { LockfileAssistant } from "../lockfile-contract";
import { cliCommand } from "../environment";
import {
  isNoSuchContainerError,
  wakeDocker,
} from "../remotes/docker/wake";
import { wakeLocalServices } from "../remotes/local/wake";

/**
 * The wake operation: start (or restart) an assistant's services in place —
 * the non-destructive repair primitive. A local wake revives the daemon
 * stack (healing conflicted ports, backfilling a missing bootstrap secret,
 * restarting the gateway when the secret was just backfilled); a docker wake
 * starts the service containers; platform-hosted entries run where they are
 * and have nothing on this machine to start.
 */
export type WakeResult =
  | { ok: true; kind: "services" | "containers" | "remote" }
  | { ok: false; status: number; error: string };

export interface WakeOptions {
  /** Progress narration for the long start (headless hosts omit it). */
  log?: (message: string) => void;
}

export async function wakeAssistant(
  entry: LockfileAssistant,
  options: WakeOptions = {},
): Promise<WakeResult> {
  const log = options.log ?? (() => {});
  switch (entry.cloud) {
    case "local": {
      const result = await wakeLocalServices(entry);
      return result.ok ? { ok: true, kind: "services" } : result;
    }
    case "docker": {
      try {
        await wakeDocker(entry);
        return { ok: true, kind: "containers" };
      } catch (err) {
        if (isNoSuchContainerError(err)) {
          // A migrated install has data in the volumes but containers that
          // were never created. The recreate needs the container-create
          // builder (images, ports, volumes, the bootstrap secret), which
          // still lives CLI-side — the honest answer points at it.
          return {
            ok: false,
            status: 404,
            error: `the containers for '${entry.assistantId}' don't exist yet — run \`${cliCommand()} wake\` once to recreate them from the recorded images`,
          };
        }
        return {
          ok: false,
          status: 500,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    }
    case "apple-container":
      return {
        ok: false,
        status: 400,
        error: `'${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to start it.`,
      };
    default:
      // cloud/custom/baseten assistants run where they are — there is no
      // process on this machine to start.
      log(`'${entry.assistantId}' runs on ${entry.cloud} — nothing to start.`);
      return { ok: true, kind: "remote" };
  }
}
