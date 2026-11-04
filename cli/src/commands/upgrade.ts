import { spawnSync } from "child_process";

import cliPkg from "../../package.json";

import { type LockfileAssistant } from "@mycadet/local-mode/contract";
import { findAssistantByName } from "../lib/assistant-config";
import {
  broadcastUpgradeEvent,
  buildCompleteEvent,
  cliCommand,
  compareVersions,
  consoleLifecycleReporter,
  formatAssistantLookupError,
  getActiveAssistant,
  getGatewayUrl,
  fetchLatestVersion,
  loadAllAssistants,
  lookupAssistantByIdentifier,
  resolveLatestStableTag,
  stripVersionPrefix,
  upgradeAssistant,
} from "@mycadet/local-mode";
import {
  emitCliError,
  categorizeUpgradeError,
  type CliErrorCategory,
} from "../lib/cli-error.js";
import { parseAssistantTargetArg } from "../lib/assistant-target-args.js";

interface UpgradeArgs {
  name: string | null;
  version: string | null;
  latest: boolean;
  prepare: boolean;
  finalize: boolean;
  noWait: boolean;
  force: boolean;
}

// Flags that consume the following argv token as a value, rather than a
// boolean switch. Passed to `parseAssistantTargetArg` so an unquoted
// multi-word display name is not truncated at a flag's value.
const UPGRADE_FLAGS_WITH_VALUES = ["--version"];

function parseArgs(): UpgradeArgs {
  const args = process.argv.slice(3);
  const name = parseAssistantTargetArg(args, UPGRADE_FLAGS_WITH_VALUES) ?? null;
  let version: string | null = null;
  let latest = false;
  let prepare = false;
  let finalize = false;
  let noWait = false;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") {
      console.log(`Usage: ${cliCommand()} upgrade [<name>] [options]`);
      console.log("");
      console.log("Upgrade an assistant to a newer version.");
      console.log(
        "To roll back to a previous version, use `cadet restore` with a backup.",
      );
      console.log("");
      console.log("Arguments:");
      console.log(
        "  <name>               Name of the assistant to upgrade, defaults to active or only assistant",
      );
      console.log("");
      console.log("Options:");
      console.log(
        "  --version <version>  Target version to upgrade to, defaults to the CLI version",
      );
      console.log(
        "  --latest             Upgrade to the latest stable release, updating the CLI first if needed",
      );
      console.log(
        "  --prepare            Run pre-upgrade steps only (backup, notify) without swapping versions",
      );
      console.log(
        "  --finalize           Run post-upgrade steps only (broadcast complete, workspace commit)",
      );
      console.log(
        "  --no-wait            Platform assistants only: return after the upgrade request is accepted instead of waiting for completion",
      );
      console.log(
        "  --force              Local/Docker assistants only: reinstall even when already on the target version",
      );
      console.log("");
      console.log("Examples:");
      console.log(
        "  cadet upgrade                              # Upgrade the active assistant to the CLI's version",
      );
      console.log(
        "  cadet upgrade --latest                     # Upgrade CLI + assistant to the latest stable release",
      );
      console.log(
        "  cadet upgrade my-assistant                  # Upgrade a specific assistant by name",
      );
      console.log(
        "  cadet upgrade my-assistant --version v1.2.3 # Upgrade to a specific version",
      );
      process.exit(0);
    } else if (arg === "--version") {
      const next = args[i + 1];
      if (!next || next.startsWith("-")) {
        console.error("Error: --version requires a value");
        emitCliError("UNKNOWN", "--version requires a value");
        process.exit(1);
      }
      version = next;
      i++;
    } else if (arg === "--latest") {
      latest = true;
    } else if (arg === "--prepare") {
      prepare = true;
    } else if (arg === "--finalize") {
      finalize = true;
    } else if (arg === "--no-wait") {
      noWait = true;
    } else if (arg === "--force") {
      force = true;
    } else if (!arg.startsWith("-")) {
      // Positional token, part of a possibly multi-word display name.
      // Collected up front via `parseAssistantTargetArg` above.
    } else {
      console.error(`Error: Unknown option '${arg}'.`);
      emitCliError("UNKNOWN", `Unknown option '${arg}'`);
      process.exit(1);
    }
  }

  if (prepare && finalize) {
    console.error("Error: --prepare and --finalize are mutually exclusive.");
    emitCliError("UNKNOWN", "--prepare and --finalize are mutually exclusive");
    process.exit(1);
  }

  if (latest && version) {
    console.error("Error: --latest and --version are mutually exclusive.");
    emitCliError("UNKNOWN", "--latest and --version are mutually exclusive");
    process.exit(1);
  }

  if (noWait && (prepare || finalize)) {
    console.error(
      "Error: --no-wait cannot be combined with --prepare or --finalize.",
    );
    emitCliError(
      "UNKNOWN",
      "--no-wait cannot be combined with --prepare or --finalize",
    );
    process.exit(1);
  }

  return { name, version, latest, prepare, finalize, noWait, force };
}

/**
 * Resolve which assistant to target for the upgrade command. Priority:
 * 1. Explicit name argument (exact assistant ID wins over a display-name
 *    match; a unique display-name match resolves; an ambiguous display
 *    name is an error listing the matching IDs)
 * 2. Active assistant set via `cadet use`
 * 3. Sole assistant (when exactly one exists)
 */
function resolveTargetAssistant(nameArg: string | null): LockfileAssistant {
  if (nameArg) {
    const result = lookupAssistantByIdentifier(nameArg);
    if (result.status !== "found") {
      const msg = formatAssistantLookupError(nameArg, result);
      console.error(msg);
      emitCliError("ASSISTANT_NOT_FOUND", msg);
      process.exit(1);
    }
    return result.entry;
  }

  const active = getActiveAssistant();
  if (active) {
    const entry = findAssistantByName(active);
    if (entry) return entry;
  }

  const all = loadAllAssistants();
  if (all.length === 1) return all[0];

  if (all.length === 0) {
    const msg = "No assistants found. Run 'cadet hatch' first.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  } else {
    const msg =
      "Multiple assistants found. Specify a name or set an active assistant with 'cadet use <name>'.";
    console.error(msg);
    emitCliError("ASSISTANT_NOT_FOUND", msg);
  }
  process.exit(1);
}

/** The command edge's error UX: print, map onto the CLI taxonomy, exit. */
function reportUpgradeFailure(result: {
  ok: boolean;
  status?: number;
  error?: string;
  code?: string;
}): void {
  if (result.ok) return;
  const msg = `Error: Upgrade failed: ${result.error ?? "unknown error"}`;
  console.error(`\n❌ ${msg}`);
  emitCliError(
    (result.code as CliErrorCategory) ?? categorizeUpgradeError(result.error),
    msg,
  );
  process.exit(1);
}

const cliVersionTag = cliPkg.version ? `v${cliPkg.version}` : undefined;

/**
 * When `--latest` is passed, resolve the latest stable version from the
 * platform API.  If the running CLI is older than that version, self-update
 * the CLI via `bun install -g` and re-exec so the new CLI's upgrade logic
 * (and its package version) drives the rest of the upgrade.
 *
 * Returns the resolved latest version string (e.g. "v0.7.0") for callers
 * that need it.  If the CLI was updated and re-exec'd, this function never
 * returns — the process is replaced.
 */
async function resolveLatestStableTagCli(): Promise<string> {
  console.log("🔍 Fetching latest stable release...");
  const latestVersion = await fetchLatestVersion();
  if (!latestVersion) {
    console.error(
      "Error: Could not determine the latest stable release from Cadet Cloud or GitHub Releases.",
    );
    emitCliError(
      "UNKNOWN",
      "Could not determine the latest stable release from Cadet Cloud or GitHub Releases",
    );
    process.exit(1);
  }

  return latestVersion.startsWith("v") ? latestVersion : `v${latestVersion}`;
}

async function resolveLatestAndMaybeSelfUpdate(
  name: string | null,
  flags: { noWait: boolean; force: boolean },
): Promise<string> {
  const latestTag = await resolveLatestStableTagCli();
  const currentTag = cliPkg.version ? `v${cliPkg.version}` : null;

  console.log(`   Latest stable: ${latestTag}`);
  console.log(`   CLI version:   ${currentTag ?? "unknown"}\n`);

  // Check if the CLI needs updating
  const cmp = currentTag ? compareVersions(latestTag, currentTag) : null;
  if (cmp !== null && cmp > 0) {
    console.log(`🔄 Updating CLI to ${latestTag}...`);
    const installResult = spawnSync(
      "bun",
      ["install", "-g", `cadet@${stripVersionPrefix(latestTag)}`],
      { stdio: "inherit", windowsHide: true },
    );
    if (installResult.error || installResult.status !== 0) {
      const detail =
        installResult.error?.message ??
        `exited with code ${installResult.status}`;
      console.error(`\n❌ CLI self-update failed: ${detail}`);
      emitCliError("CLI_UPDATE_FAILED", "CLI self-update failed", detail);
      process.exit(1);
    }
    console.log(`✅ CLI updated to ${latestTag}\n`);

    // Re-exec with the updated CLI. Pass --version instead of --latest
    // to avoid re-fetching and to prevent infinite re-exec loops; forward
    // the other flags so the re-exec keeps the requested semantics.
    const reexecArgs = ["upgrade"];
    if (name) reexecArgs.push(name);
    reexecArgs.push("--version", latestTag);
    if (flags.noWait) reexecArgs.push("--no-wait");
    if (flags.force) reexecArgs.push("--force");

    console.log(`🚀 Re-running upgrade with updated CLI...\n`);
    const reexecResult = spawnSync("cadet", reexecArgs, {
      stdio: "inherit",
      windowsHide: true,
    });
    process.exit(reexecResult.status ?? 1);
  }

  if (cmp !== null && cmp === 0) {
    console.log(`✅ CLI is already on the latest version (${latestTag})\n`);
  }

  return latestTag;
}

export const upgrade = Object.assign(
  async function upgrade(): Promise<void> {
    const { name, version, latest, prepare, finalize, noWait, force } =
      parseArgs();
    const entry = resolveTargetAssistant(name);

    if (prepare) {
      const result = await upgradeAssistant({
        entry,
        version,
        cliVersion: cliVersionTag,
        prepare: true,
        reporter: consoleLifecycleReporter,
      });
      reportUpgradeFailure(result);
      return;
    }

    if (finalize) {
      const result = await upgradeAssistant({
        entry,
        finalizeFromVersion: version,
        cliVersion: cliVersionTag,
        reporter: consoleLifecycleReporter,
      });
      reportUpgradeFailure(result);
      return;
    }

    // When --latest is passed, resolve the target from the cloud API and
    // self-update the CLI if it's behind.  The resolved version is then used
    // as the explicit target for the rest of the upgrade flow.
    let effectiveVersion = version;
    if (latest) {
      effectiveVersion =
        entry.cloud === "local"
          ? await resolveLatestStableTag()
          : await resolveLatestAndMaybeSelfUpdate(name, {
              noWait,
              force,
            });
    }

    const result = await upgradeAssistant({
      entry,
      version: effectiveVersion,
      cliVersion: cliVersionTag,
      force,
      wait: !noWait,
      reporter: consoleLifecycleReporter,
    });
    if (result.ok) {
      return;
    }

    // Best-effort: notify connected clients that the upgrade failed.
    // A `starting` event may have been sent inside the leg before the error,
    // so we must close with `complete`.
    try {
      await broadcastUpgradeEvent(
        getGatewayUrl(entry),
        entry.assistantId,
        buildCompleteEvent("unknown", false),
      );
    } catch {
      // The assistant may be unreachable — the failure still prints below.
    }
    reportUpgradeFailure(result);
  },
  { description: "Upgrade an assistant to a newer version" },
);
