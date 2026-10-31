import { existsSync, readFileSync, renameSync, rmSync, unlinkSync } from "fs";
import { cliCommand } from "../lib/cli-name.js";
import { basename, dirname, join, sep } from "path";
import { fileURLToPath } from "url";

import { loadAllAssistants } from "../lib/assistant-config.js";
import {
  canPromptForConfirmation,
  confirmAction,
} from "../lib/confirm-action.js";
import { isLocalEntry } from "@mycadet/local-mode/contract";
import { retireDocker } from "../lib/docker.js";
import { retireLocal } from "../lib/retire-local.js";
import { getSharedStateDir } from "../lib/environments/paths.js";
import {
  resolveConfigDir,
  resolveDataDir,
  resolveLogDir,
} from "@mycadet/local-mode";
import { getCurrentEnvironment } from "../lib/environments/resolve.js";



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

/** The CLI's own install location, when it can be deleted. */
interface SelfDeleteTarget {
  path: string;
  description: string;
}

/**
 * Where this CLI is running from, when that is an INSTALL we can remove:
 * the compiled `cadet` binary (process.execPath IS the install) or a global
 * package install (bun install -g mycadet / npm install -g mycadet). Under
 * a source checkout or a bare runtime (bun/node), null — the runtime binary
 * must never be a deletion target. The uninstall prompt lists the same
 * target it later deletes, so both share this resolver.
 */
function resolveSelfDeleteTarget(): SelfDeleteTarget | null {
  const execPath = process.execPath;
  const execBase = basename(execPath);
  if (execBase === "cadet" || execBase === "cadet.exe") {
    return { path: execPath, description: "the Cadet executable" };
  }
  const runningFile = fileURLToPath(import.meta.url);
  const pkgRoot = findInstalledPackageRoot(dirname(runningFile));
  if (pkgRoot) {
    return { path: pkgRoot, description: "the installed Cadet CLI package" };
  }
  return null;
}

/**
 * Delete the install {@link resolveSelfDeleteTarget} found. The two shapes
 * delete differently — the running binary needs the win32 rename dance, a
 * package dir is a plain recursive delete — and the bin symlinks the
 * package manager planted (e.g. ~/.bun/bin/cadet, the npm global bin) are
 * left dangling — say so.
 */
function selfDelete(): void {
  const target = resolveSelfDeleteTarget();
  if (!target) {
    console.log(
      "Cadet is running from a source checkout — skipping self-removal.",
    );
    console.log(
      "Remove the installed copy with `bun remove -g mycadet` or `npm uninstall -g mycadet`.",
    );
    return;
  }
  const execBase = basename(target.path);
  const isCompiledBinary = execBase === "cadet" || execBase === "cadet.exe";
  if (isCompiledBinary) {
    try {
      if (process.platform === "win32") {
        // Windows refuses to unlink a running executable — stage it under a
        // junk name and delete that.
        const stale = `${target.path}.uninstalled`;
        renameSync(target.path, stale);
        rmSync(stale, { force: true, recursive: true });
      } else {
        unlinkSync(target.path);
      }
      console.log(`Removed ${target.path}.`);
    } catch (err) {
      console.warn(
        `⚠️  Could not remove ${target.path}: ${
          err instanceof Error ? err.message : String(err)
        } — remove it by hand.`,
      );
    }
    return;
  }
  try {
    rmSync(target.path, { recursive: true, force: true });
    console.log(`Removed ${target.path}.`);
    console.log(
      "The `cadet` command on your PATH is now stale — remove it if your package manager didn't (`bun remove -g mycadet` or `npm uninstall -g mycadet`).",
    );
  } catch (err) {
    console.warn(
      `⚠️  Could not remove ${target.path}: ${
        err instanceof Error ? err.message : String(err)
      } — remove it with \`bun remove -g mycadet\` (or \`npm uninstall -g mycadet\`).`,
    );
  }
}

function collectDeleteTargets(): DeleteTarget[] {
  const targets: DeleteTarget[] = [
    {
      path: resolveDataDir(),
      description:
        "assistant state, retired archives, and the assistants it holds",
    },
    {
      path: resolveConfigDir(),
      description: "config and lockfile",
    },
    { path: resolveLogDir(), description: "logs" },
    // Not environment-scoped: deleting it affects every cadet CLI on the
    // machine — called out in the prompt, not hidden.
    {
      path: getSharedStateDir(),
      description: "shared state, including the terminal input history",
    },
  ];
  // Only targets that exist — the prompt lists what will actually go.
  const existing = targets.filter((t) => existsSync(t.path));
  // The log dir lives INSIDE a listed target (the config dir on
  // macOS/Linux, the state dir on Windows) and goes with its parent's
  // recursive delete — never list a path twice.
  const deduped: DeleteTarget[] = [];
  for (const t of existing) {
    const covered = deduped.some(
      (k) => t.path === k.path || t.path.startsWith(k.path + sep),
    );
    if (!covered) deduped.push(t);
  }
  return deduped;
}

function rmrf(target: string): void {
  rmSync(target, { recursive: true, force: true });
}

export const uninstall = Object.assign(
  async function uninstall(): Promise<void> {
    const args = process.argv.slice(3);
    if (args.includes("--help") || args.includes("-h")) {
      console.log(`Usage: ${cliCommand()} uninstall [--yes]`);
      console.log("");
      console.log(
        "Remove Cadet entirely: retire any remaining assistants, delete every location it uses for this environment (assistant state, retired archives, config, logs), and remove the Cadet installation itself.",
      );
      process.exit(0);
    }
    const yes = args.includes("--yes");

    const env = getCurrentEnvironment();
    const envLabel = env.name ?? "production";
    const existing = loadAllAssistants();
    const targets = collectDeleteTargets();
    const selfTarget = resolveSelfDeleteTarget();

    console.log(
      `This removes Cadet entirely for the '${envLabel}' environment and cannot be undone.`,
    );

    // Assistants still on the rack are retired — with their data deleted —
    // as part of the uninstall, and retiring happens only AFTER the
    // confirmation below: it is part of what the prompt describes, never a
    // side effect of running the command. Uninstall deletes every location
    // cadet uses INCLUDING the retired archives, so retiring first (which
    // archives) only matters for the teardown it performs: docker
    // assistants keep containers, volumes, and a network in docker that
    // the filesystem sweep below never reaches. A warning, not a refusal
    // (v0.0.10 run feedback: the hard error just blocked the uninstall).
    if (existing.length > 0) {
      console.warn(
        `\n⚠️  ${existing.length} ${existing.length === 1 ? "assistant still exists" : "assistants still exist"}: ${existing.map((a) => a.assistantId).join(", ")}`,
      );
      console.warn(
        "   They will be retired as part of this uninstall — their data (and any retired archives) will be permanently deleted.",
      );
    }

    if (targets.length === 0 && selfTarget === null) {
      console.log("No Cadet data directories found to delete.");
    } else {
      console.log("It will permanently delete:");
      for (const t of selfTarget ? [...targets, selfTarget] : targets) {
        console.log(`  - ${t.path}  — ${t.description}`);
      }
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

    for (const entry of existing) {
      if (entry.cloud === "apple-container") {
        console.log(
          `   Skipping '${entry.assistantId}' on apple-container — its lifecycle is managed elsewhere.`,
        );
        continue;
      }
      try {
        // The shared retire helper tears down everything the filesystem
        // sweep never reaches (containers, processes) and archives the
        // instance as a safety net before the sweep deletes the originals.
        if (entry.cloud === "docker") {
          await retireDocker(entry.assistantId);
        } else if (isLocalEntry(entry)) {
          await retireLocal(entry.assistantId, entry);
        }
      } catch (err) {
        console.error(
          `   Warning: could not fully retire '${entry.assistantId}': ${err instanceof Error ? err.message : String(err)}`,
        );
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
