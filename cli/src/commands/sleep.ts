import { existsSync, readFileSync } from "fs";
import { getGatewayUrl } from "@mycadet/local-mode/contract";
import { cliCommand } from "../lib/cli-name.js";
import { join } from "path";

import {
  getDaemonPidPath,
  getLocalInstanceDir,
  loadAllAssistants,
  resolveTargetAssistant,
} from "../lib/assistant-config.js";
import type { LockfileAssistant } from "../lib/assistant-config.js";
import { dockerResourceNames, sleepContainers } from "../lib/docker.js";
import {
  drainAssistant,
  type DrainOutcome,
  parseWaitDuration,
} from "../lib/drain.js";
import { loadGuardianToken } from "../lib/guardian-token.js";
import {
  DAEMON_STOP_TIMEOUT_MS,
  isProcessAlive,
  stopProcessByPidFile,
  stopProcessGracefully,
} from "../lib/process";
import { resolveFreshBearerToken } from "./client.js";

const ACTIVE_CALL_LEASES_FILE = "active-call-leases.json";

type ActiveCallLease = {
  callSessionId: string;
};

function getAssistantRootDir(entry: LockfileAssistant): string {
  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  return getLocalInstanceDir(entry.resources);
}

function readActiveCallLeases(cadetDir: string): ActiveCallLease[] {
  const path = join(cadetDir, ACTIVE_CALL_LEASES_FILE);
  if (!existsSync(path)) {
    return [];
  }

  const raw = JSON.parse(readFileSync(path, "utf-8")) as {
    version?: number;
    leases?: Array<{ callSessionId?: unknown }>;
  };
  if (raw.version !== 1 || !Array.isArray(raw.leases)) {
    throw new Error(`Invalid active call lease file at ${path}`);
  }

  return raw.leases.filter(
    (lease): lease is ActiveCallLease =>
      typeof lease?.callSessionId === "string" &&
      lease.callSessionId.length > 0,
  );
}

export const sleep = Object.assign(
  async function sleep(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(
        `Usage: ${cliCommand()} sleep [<name> | --all] [--force] [--wait [<duration>]]`,
      );
      console.log("");
      console.log(
        "Gracefully stop all services; abort if they do not exit without forced termination.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>    Name of the assistant to stop, defaults to active or only local",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --all     Stop every assistant across all remotes instead of one",
      );
      console.log(
        "  --force   Stop the assistant even if a phone call keepalive lease is active",
      );
      console.log(
        "  --wait    Wait for in-flight background work (heartbeats, memory jobs,",
      );
      console.log(
        "            schedules) to finish before stopping. Waits as long as it",
      );
      console.log(
        "            takes by default; pass a duration, e.g. --wait 90s or --wait 10m",
      );
      console.log(
        "            to bound the wait. Ctrl-C cancels and leaves the assistant running.",
      );
      process.exit(0);
    }

    const knownFlags = new Set(["--all", "--force", "--wait"]);
    const unknownFlag = args.find(
      (arg) =>
        arg.startsWith("-") &&
        !knownFlags.has(arg) &&
        !arg.startsWith("--wait="),
    );
    if (unknownFlag) {
      console.error(`Unknown sleep option: ${unknownFlag}`);
      process.exit(1);
    }

    const force = args.includes("--force");
    let wait = false;
    let waitMs: number | null = null;
    let waitDurationToken: string | null = null;
    const waitEqArg = args.find((a) => a.startsWith("--wait="));
    if (waitEqArg) {
      wait = true;
      const raw = waitEqArg.slice("--wait=".length);
      waitMs = parseWaitDuration(raw);
      if (waitMs == null) {
        console.error(
          `Error: invalid --wait duration '${raw}'. Use seconds or a value like 90s or 10m.`,
        );
        process.exit(1);
      }
    } else {
      const waitIndex = args.indexOf("--wait");
      if (waitIndex !== -1) {
        wait = true;
        // A bare `--wait` waits indefinitely; a following duration token
        // (e.g. `90s`, `10m`, `120`) bounds it. Anything else is the name arg.
        const next = args[waitIndex + 1];
        if (next !== undefined && /^\d+(s|m)?$/.test(next)) {
          waitDurationToken = next;
          waitMs = parseWaitDuration(next);
          if (waitMs == null) {
            console.error(
              `Error: invalid --wait duration '${next}'. Use seconds or a value like 90s or 10m.`,
            );
            process.exit(1);
          }
        }
      }
    }
    const nameArg = args.find(
      (a) => !a.startsWith("-") && a !== waitDurationToken,
    );
    const all = args.includes("--all");

    if (all && nameArg) {
      console.error("Error: --all cannot be combined with an assistant name.");
      process.exit(1);
    }

    if (all) {
      await sleepAll({ force, wait, waitMs });
      return;
    }

    const entry = resolveTargetAssistant(nameArg);
    try {
      await sleepAssistant(entry, { force, wait, waitMs });
    } catch (err) {
      if (err instanceof SleepExit) {
        console.log(err.message);
        process.exit(err.exitCode);
      }
      console.error(
        `Error: ${err instanceof Error ? err.message : String(err)}`,
      );
      process.exit(1);
    }
  },
  { description: "Stop the assistant process" },
);

type SleepOptions = {
  force: boolean;
  wait: boolean;
  waitMs: number | null;
};

/**
 * Carries a deliberate exit outcome (a cancelled drain) across the
 * per-assistant boundary so the callers can exit with the right code
 * instead of treating it as a stop failure.
 */
class SleepExit extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Stop every assistant this CLI's environment knows about — `--all`. The
 * CLI only ever reaches one environment, so this is the current env's
 * lockfile. Same per-assistant stop as the single path, but one
 * assistant's failure (or an unmanageable runtime) never blocks the
 * others; a failure only decides the exit code.
 */
async function sleepAll(opts: SleepOptions): Promise<void> {
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
      await sleepAssistant(entry, opts);
    } catch (err) {
      if (err instanceof SleepExit) {
        // A cancelled drain is the user asking to stop — honor it immediately.
        console.log(err.message);
        process.exit(err.exitCode);
      }
      failures++;
      console.error(
        `Error: failed to stop '${entry.assistantId}': ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  if (failures > 0) {
    process.exit(1);
  }
}

/**
 * Stop one assistant. Throws on hard errors (active call leases, missing
 * resources, unmanageable runtimes) so the caller decides between exiting
 * (single-assistant path) and continuing to the next entry (`--all`).
 */
export async function sleepAssistant(
  entry: LockfileAssistant,
  opts: SleepOptions,
): Promise<void> {
  const { force, wait, waitMs } = opts;

  if (entry.cloud === "docker") {
    if (wait) {
      console.log(
        "--wait is not supported for Docker assistants yet — stopping containers now.",
      );
    }
    const res = dockerResourceNames(entry.assistantId);
    await sleepContainers(res);
    console.log("Docker containers stopped.");
    return;
  }

  if (entry.cloud === "apple-container") {
    throw new Error(
      `'${entry.assistantId}' uses the Apple Containers runtime. Its lifecycle is managed by the macOS app — use the app to stop it.`,
    );
  }

  if (entry.cloud && entry.cloud !== "local") {
    throw new Error(
      `'cadet sleep' only works with local and docker assistants. '${entry.assistantId}' is a ${entry.cloud} instance.`,
    );
  }

  if (!entry.resources) {
    throw new Error(
      `Local assistant '${entry.assistantId}' is missing resource configuration. Re-hatch to fix.`,
    );
  }
  const resources = entry.resources;
  if (process.platform === "win32") {
    throw new Error(
      "Graceful-only shutdown is not supported for Windows local services.",
    );
  }
  const assistantPidFile = getDaemonPidPath(resources);
  const cadetDir = getAssistantRootDir(entry);
  const gatewayPidFile = join(cadetDir, "gateway.pid");

  if (!force) {
    const assistantAlive = isProcessAlive(assistantPidFile).alive;
    if (assistantAlive) {
      let leases: ActiveCallLease[];
      try {
        leases = readActiveCallLeases(cadetDir);
      } catch (err) {
        throw new Error(
          `${
            err instanceof Error ? err.message : String(err)
          }. Use 'cadet sleep --force' to override if you want to stop the assistant anyway.`,
        );
      }
      if (leases.length > 0) {
        const activeIds = leases.map((lease) => lease.callSessionId);
        throw new Error(
          `assistant is staying awake for active phone calls (${activeIds.join(
            ", ",
          )}). Use 'cadet sleep --force' to stop it anyway.`,
        );
      }
    }
  }

  if (wait) {
    const outcome = await runDrainPhase(entry, assistantPidFile, waitMs);
    if (outcome === "cancelled") {
      throw new SleepExit(
        130,
        "Sleep cancelled — the assistant is still running.",
      );
    }
  }

  const assistantStopped = await stopProcessByPidFile(
    assistantPidFile,
    "assistant",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );
  if (!assistantStopped) {
    console.log("Assistant is not running.");
  } else {
    console.log("Assistant stopped.");
  }

  // Stop gateway — use a longer timeout because the gateway has a configurable
  // drain window (5s) before it exits.
  const gatewayStopped = await stopProcessByPidFile(
    gatewayPidFile,
    "gateway",
    undefined,
    7000,
    stopProcessGracefully,
  );
  if (!gatewayStopped) {
    console.log("Gateway is not running.");
  } else {
    console.log("Gateway stopped.");
  }

  // Stop the CES sibling — it is stopped by its PID file, a no-op when the
  // PID file is absent (e.g. the sibling was never started or already exited).
  const cesPidFile = join(cadetDir, "ces.pid");
  const cesStopped = await stopProcessByPidFile(
    cesPidFile,
    "credential-executor",
    undefined,
    DAEMON_STOP_TIMEOUT_MS,
    stopProcessGracefully,
  );
  if (cesStopped) {
    console.log("credential-executor stopped.");
  }
}

/**
 * Wait for the assistant's in-flight background work (heartbeats, memory
 * jobs, schedule runs, active conversation turns) to finish before the stop.
 * Every failure mode falls back to a normal stop with a note — a drain must
 * never make `cadet sleep` less reliable than it is without `--wait`.
 */
async function runDrainPhase(
  entry: LockfileAssistant,
  assistantPidFile: string,
  waitMs: number | null,
): Promise<DrainOutcome | "skipped"> {
  if (!isProcessAlive(assistantPidFile).alive) {
    return "skipped";
  }
  const baseUrl = getGatewayUrl(entry);
  const stored = loadGuardianToken(entry.assistantId)?.accessToken;
  if (!baseUrl || !stored) {
    console.log(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }
  // A token past its renewal point would 401 and read as "unreachable",
  // silently skipping the wait — refresh-and-fall-back like other CLI
  // request paths.
  const token = await resolveFreshBearerToken(
    baseUrl,
    entry.assistantId,
    stored,
    entry.cloud,
  );
  if (!token) {
    console.log(
      "Cannot reach the assistant API to wait for background work (missing URL or guardian token) — stopping without waiting.",
    );
    return "skipped";
  }

  console.log(
    waitMs == null
      ? "Waiting for the assistant to finish background work (Ctrl-C cancels)…"
      : `Waiting up to ${Math.round(waitMs / 1000)}s for the assistant to finish background work (Ctrl-C cancels)…`,
  );

  const controller = new AbortController();
  const onSigint = (): void => controller.abort();
  process.once("SIGINT", onSigint);
  try {
    const outcome = await drainAssistant({
      baseUrl,
      token,
      deadlineAt: waitMs == null ? null : Date.now() + waitMs,
      signal: controller.signal,
    });
    switch (outcome) {
      case "drained":
        console.log("Background work finished — stopping now.");
        break;
      case "timeout":
        console.log(
          "Wait limit reached — stopping now. Interrupted background jobs resume after the next start.",
        );
        break;
      case "unsupported":
        console.log(
          "This assistant version does not support --wait — stopping without waiting.",
        );
        break;
      case "unreachable":
        console.log(
          "Could not reach the assistant to check background work — stopping without waiting.",
        );
        break;
      case "cancelled":
        break;
    }
    return outcome;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
