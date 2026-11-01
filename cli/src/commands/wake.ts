import { cliCommand, loadAllAssistants } from "@mycadet/local-mode";

import { resolveTargetAssistant } from "../lib/assistant-config.js";
import { dockerResourceNames } from "@mycadet/local-mode";
import type { LockfileAssistant } from "@mycadet/local-mode/contract";
import {
  isNoSuchContainerError,
  recreateDockerContainers,
  wakeContainers,
} from "../lib/remotes/docker.js";
import {
  DOCKER_GATEWAY_READY_TIMEOUT_MS,
  restoreContainerAppServer,
} from "../lib/tunnel.js";
import { WakeExit, wakeLocal } from "../lib/remotes/local.js";

export const wake = Object.assign(
  async function wake(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} wake [<name> | --all] [options]`);
      console.log("");
      console.log("Start the assistant and gateway processes.");
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>    Name of the assistant to start, defaults to active or only local",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --all          Start every assistant across all remotes instead of one",
      );
      console.log(
        "  --watch        Run assistant and gateway in watch mode (hot reload on source changes)",
      );
      console.log(
        "  --foreground   Run assistant in foreground with logs printed to terminal",
      );
      process.exit(0);
    }

    const watch = args.includes("--watch");
    const foreground = args.includes("--foreground");
    const nameArg = args.find((a) => !a.startsWith("-"));
    const all = args.includes("--all");

    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }
    if (all && foreground) {
      console.error("Error: --all cannot be combined with --foreground.");
      process.exit(1);
    }

    if (all) {
      await wakeAll({ watch });
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    try {
      await wakeAssistant(entry, { watch, foreground });
    } catch (err) {
      if (err instanceof WakeExit) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
      throw err;
    }

    // Foreground blocking is a single-assistant concern (--all refuses the
    // flag), and the docker path already warned that foreground is ignored.
    if (foreground && entry.cloud !== "docker") {
      console.log("Running in the foreground, Ctrl+C to stop...\n");
      // Block forever — the daemon is running with inherited stdio so its
      // output streams to this terminal. When the user hits Ctrl+C, SIGINT
      // propagates to the daemon child and both exit.
      await new Promise<void>((resolve) => {
        process.on("SIGINT", () => {
          console.log("\nShutting down...");
          resolve();
        });
        process.on("SIGTERM", () => resolve());
      });
    }
  },
  { description: "Start the assistant and gateway" },
);

/**
 * Start every assistant this CLI's environment knows about — `--all`. The
 * CLI only ever reaches one environment, so this is the current env's
 * lockfile. Same per-assistant wake as the single path, but one assistant's
 * failure never blocks the others; failures only decide the exit code.
 */
async function wakeAll(opts: { watch: boolean }): Promise<void> {
  const entries = loadAllAssistants();
  if (entries.length === 0) {
    console.error(
      `Error: no assistants found. Run '${cliCommand()} hatch' first.`,
    );
    process.exit(1);
  }

  let failures = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.assistantId)) continue;
    seen.add(entry.assistantId);
    if (entry.cloud === "apple-container") {
      console.log(
        `Skipping '${entry.assistantId}' (apple-container) — its lifecycle is managed elsewhere.`,
      );
      continue;
    }
    try {
      await wakeAssistant(entry, {
        watch: opts.watch,
        foreground: false,
      });
    } catch (err) {
      failures++;
      console.error(
        `Error: failed to wake '${entry.assistantId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}

type WakeAssistantOptions = {
  watch: boolean;
  foreground: boolean;
};

/**
 * Start one assistant and its gateway. Throws WakeExit on deliberate
 * refusals so the caller decides between exiting (single path) and
 * continuing to the next entry (`--all`).
 */
export async function wakeAssistant(
  entry: LockfileAssistant,
  opts: WakeAssistantOptions,
): Promise<void> {
  const { watch, foreground } = opts;

  if (entry.cloud === "docker") {
    if (watch || foreground) {
      const ignored = [watch && "--watch", foreground && "--foreground"]
        .filter(Boolean)
        .join(" and ");
      console.warn(`Warning: ${ignored} ignored for Docker instances.`);
    }
    const res = dockerResourceNames(entry.assistantId);
    try {
      await wakeContainers(res);
    } catch (err) {
      // A migrated install has data in the volumes but containers that were
      // never created (v0.0.10 run feedback: "No such container"). Recreate
      // the service group from the entry's recorded images; anything else
      // is a real wake failure.
      if (!isNoSuchContainerError(err)) throw err;
      console.log(
        `Containers for '${entry.assistantId}' don't exist yet — recreating from the recorded images...`,
      );
      await recreateDockerContainers(entry);
    }
    console.log("Docker containers started.");
    await restoreContainerAppServer(entry, DOCKER_GATEWAY_READY_TIMEOUT_MS);
    console.log("Wake complete.");
    return;
  }

  if (entry.cloud === "apple-container") {
    throw new WakeExit(
      `'${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to start it.`,
    );
  }

  if (entry.cloud === "local") {
    await wakeLocal(entry, opts);
    return;
  }

  // cloud/custom/baseten assistants run where they are — there is no
  // process on this machine to start.
  console.log(
    `'${entry.assistantId}' runs on ${entry.cloud} — nothing to start.`,
  );
}
