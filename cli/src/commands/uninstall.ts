import { existsSync, readFileSync, renameSync, rmSync, unlinkSync } from "fs";
import { basename, dirname, join } from "path";
import { fileURLToPath } from "url";

import {
  getDaemonPidPath,
  loadAllAssistants,
  type AssistantEntry,
} from "../lib/assistant-config.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { retireDocker } from "../lib/docker.js";
import {
  getConfigDirs,
  getInputHistoryPath,
  getLogDir,
  getStateDir,
} from "../lib/environments/paths.js";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";
import { stopProcessByPidFile } from "../lib/process";

/**
 * The per-assistant teardown uninstall performs before deleting the data:
 * docker assistants keep containers, volumes, and a network in docker that
 * the filesystem sweep never reaches, and local assistants keep processes.
 * Everything on-disk is deleted by the sweep regardless — this is the part
 * uninstall could NOT do before it refused.
 */
async function retireAssistantData(entry: AssistantEntry): Promise<void> {
  if (entry.cloud === "docker") {
    await retireDocker(entry.assistantId);
    return;
  }
  const resources = entry.resources;
  if (!resources) return;
  await stopProcessByPidFile(
    join(resources.instanceDir, "gateway.pid"),
    "gateway",
  );
  await stopProcessByPidFile(getDaemonPidPath(resources), "assistant");
}

/** A directory (or file) scheduled for deletion, with what it holds. */
interface DeleteTarget {
  path: string;
  description: string;
}

/**
 * Owning packages a global install of the CLI can live under, in priority
 * order — @mycadet/cli always wins over its meta wrapper.
 */
const OWNED_PACKAGE_NAMES: ReadonlyArray<string> = [
  "@mycadet/cli",
  "@mycadet/meta",
];

/**
 * Find the package root the CLI is running from (…/node_modules/mycadet),
 * or null when running from a source tree. A `.git` ANYWHERE up the tree
 * (repo root or monorepo parent — a checkout's cli/ subpackage has no .git
 * of its own) means this is source, never an install.
 */
function findInstalledPackageRoot(startDir: string): string | null {
  // Pass 1: any .git ancestor = a checkout, never an install.
  for (let dir = startDir; ; dir = dirname(dir)) {
    if (existsSync(join(dir, ".git"))) return null;
    const parent = dirname(dir);
    if (parent === dir) break; // Reached the filesystem root.
  }
  // Pass 2: walk up looking for the owned package root, priority order —
  // the whole chain is checked for each name in turn, so @mycadet/cli wins
  // over @mycadet/meta wherever both appear.
  for (const owned of OWNED_PACKAGE_NAMES) {
    for (let dir = startDir; ; dir = dirname(dir)) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        try {
          const parsed: unknown = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (
            typeof parsed === "object" &&
            parsed !== null &&
            "name" in parsed &&
            parsed.name === owned
          ) {
            return dir;
          }
        } catch {
          // Unreadable package.json — keep walking up.
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
    }
  }
  return null;
}

/**
 * Remove the running CLI. Handles the two real install shapes:
 *   - the compiled `cadet` binary (process.execPath IS the install)
 *   - a global package install (bun install -g mycadet / npm install -g)
 * Under a source checkout or a bare runtime (bun/node), nothing is deleted —
 * the runtime binary must never be a deletion target.
 */
function selfDelete(): void {
  const execPath = process.execPath;
  const execBase = basename(execPath);
  if (execBase === "cadet" || execBase === "cadet.exe") {
    try {
      if (process.platform === "win32") {
        // Windows refuses to unlink a running executable — stage it under a
        // junk name and delete that.
        const stale = `${execPath}.uninstalled`;
        renameSync(execPath, stale);
        rmSync(stale, { force: true, recursive: true });
      } else {
        unlinkSync(execPath);
      }
      console.log(`Removed ${execPath}.`);
      return;
    } catch (err) {
      console.warn(
        `⚠️  Could not remove ${execPath}: ${
          err instanceof Error ? err.message : String(err)
        } — remove it by hand.`,
      );
      return;
    }
  }

  // Package-manager install: remove the package directory we are running
  // from, best-effort. Bin symlinks the package manager planted (e.g.
  // ~/.bun/bin/cadet, the npm global bin) are left dangling — say so.
  const runningFile = fileURLToPath(import.meta.url);
  const pkgRoot = findInstalledPackageRoot(dirname(runningFile));
  if (!pkgRoot) {
    console.log(
      "Cadet is running from a source checkout — skipping self-removal.",
    );
    console.log(
      "Remove the installed copy with `bun remove -g mycadet` or `npm uninstall -g mycadet`.",
    );
    return;
  }
  try {
    rmSync(pkgRoot, { recursive: true, force: true });
    console.log(`Removed ${pkgRoot}.`);
    console.log(
      "The `cadet` command on your PATH is now stale — remove it if your package manager didn't (`bun remove -g mycadet` or `npm uninstall -g mycadet`).",
    );
  } catch (err) {
    console.warn(
      `⚠️  Could not remove ${pkgRoot}: ${
        err instanceof Error ? err.message : String(err)
      } — remove it with \`bun remove -g mycadet\` (or \`npm uninstall -g mycadet\`).`,
    );
  }
}

function collectDeleteTargets(env = getCurrentEnvironment()): DeleteTarget[] {
  const targets: DeleteTarget[] = [
    {
      path: getStateDir(env),
      description: "assistant state, retired archives, and the assistants it holds",
    },
    ...getConfigDirs(env).map((dir) => ({
      path: dir,
      description: "config and lockfile",
    })),
    { path: getLogDir(env), description: "logs" },
    // Not environment-scoped: deleting it affects every cadet CLI on the
    // machine — called out in the prompt, not hidden.
    { path: getInputHistoryPath(), description: "shared terminal input history" },
  ];
  // Only targets that exist — the prompt lists what will actually go.
  return targets.filter((t) => existsSync(t.path));
}

function rmrf(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

export const uninstall = Object.assign(
  async function uninstall(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log("Usage: cadet uninstall [--yes]");
      console.log("");
      console.log(
        "Remove Cadet entirely: delete every location it uses for this environment (assistant state, retired archives, config, logs) and then delete the executable itself.",
      );
      process.exit(0);
    }
    const yes = args.includes("--yes");

    // Assistants still on the rack are retired — with their data deleted —
    // as part of the uninstall. Uninstall deletes every location cadet uses
    // INCLUDING the retired archives, so retiring first (which archives)
    // only matters for the teardown it performs: docker assistants keep
    // containers, volumes, and a network in docker that the filesystem
    // sweep below never reaches. A warning, not a refusal (v0.0.10 run
    // feedback: the hard error just blocked the uninstall).
    const existing = loadAllAssistants();
    if (existing.length > 0) {
      console.warn(
        `\n⚠️  ${existing.length} ${existing.length === 1 ? "assistant still exists" : "assistants still exist"}: ${existing.map((a) => a.assistantId).join(", ")}`,
      );
      console.warn(
        "   They will be retired now — their data (and any retired archives) will be permanently deleted by this uninstall.",
      );
      for (const entry of existing) {
        if (entry.cloud === "apple-container" || entry.cloud === "paired") {
          console.log(`   Skipping '${entry.assistantId}' on ${entry.cloud} — its lifecycle is managed elsewhere.`);
          continue;
        }
        try {
          await retireAssistantData(entry);
        } catch (err) {
          console.error(
            `   Warning: could not fully retire '${entry.assistantId}': ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    }

    const env = getCurrentEnvironment();
    const envLabel = env.name ?? "production";
    const targets = collectDeleteTargets(env);
    const execPath = process.execPath;

    console.log(
      `This removes Cadet entirely for the '${envLabel}' environment and cannot be undone.`,
    );
    if (targets.length === 0) {
      console.log("No Cadet data directories found to delete.");
    } else {
      console.log("It will permanently delete:");
      for (const t of targets) {
        console.log(`  - ${t.path}  — ${t.description}`);
      }
    }
    const execBase = basename(execPath);
    const isCompiledBinary = execBase === "cadet" || execBase === "cadet.exe";
    if (isCompiledBinary) {
      console.log(`It will then remove the Cadet executable at ${execPath}.`);
    }

    if (!yes) {
      if (!canPromptForConfirmation()) {
        console.error(
          "Error: Refusing to uninstall without confirmation in a non-interactive terminal.",
        );
        console.error("Re-run with --yes to confirm from automation.");
        process.exit(1);
      }
      const confirmed = await confirmAction(
        "Press Enter to uninstall Cadet, or Esc/q to cancel: ",
      );
      if (!confirmed) {
        console.log("Uninstall cancelled.");
        process.exit(1);
      }
    }

    for (const t of targets) {
      rmrf(t.path);
      console.log(`Deleted ${t.path}.`);
    }

    selfDelete();
  },
  { description: "Remove Cadet entirely" },
);
