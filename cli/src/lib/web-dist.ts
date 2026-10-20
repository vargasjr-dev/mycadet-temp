import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { readAppBuiltSha, stampAppBuiltSha } from "./assistant-config.js";

const loadModule = createRequire(import.meta.url);

interface WebDistOptions {
  execPath?: string;
  platform?: NodeJS.Platform;
  resolvePackage?: () => string;
  startDir?: string;
}

/** Locate the pre-built web SPA for installed, packaged, or source CLIs. */
export function findWebDistDir(options: WebDistOptions = {}): string | null {
  try {
    const packageJson = (
      options.resolvePackage ??
      (() => loadModule.resolve("@mycadet/web/package.json"))
    )();
    const distDir = join(dirname(packageJson), "dist");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {}

  if ((options.platform ?? process.platform) === "win32") {
    const runtimeDir = dirname(options.execPath ?? process.execPath);
    const packagedDist = join(runtimeDir, "web-dist");
    if (existsSync(join(packagedDist, "index.html"))) {
      return packagedDist;
    }
  }

  let dir = options.startDir ?? import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(dir, "clients", "web", "dist", "index.html");
    if (existsSync(candidate)) {
      return dirname(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

interface AppDistOptions {
  execPath?: string;
  platform?: NodeJS.Platform;
  resolvePackage?: () => string;
  startDir?: string;
}

/**
 * Locate the pre-built standalone app shell bundle for installed, packaged,
 * or source CLIs. Resolution mirrors {@link findWebDistDir}: the published
 * `@mycadet/app` package carries `dist/standalone`, packaged Windows CLIs
 * ship it beside the binary, and source checkouts fall back to the build
 * output in the repo tree.
 */
export function findAppDistDir(options: AppDistOptions = {}): string | null {
  try {
    const packageJson = (
      options.resolvePackage ??
      (() => loadModule.resolve("@mycadet/app/package.json"))
    )();
    const distDir = join(dirname(packageJson), "dist", "standalone");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {}

  if ((options.platform ?? process.platform) === "win32") {
    const runtimeDir = dirname(options.execPath ?? process.execPath);
    const packagedDist = join(runtimeDir, "app-dist");
    if (existsSync(join(packagedDist, "index.html"))) {
      return packagedDist;
    }
  }

  let dir = options.startDir ?? import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const candidate = join(
      dir,
      "clients",
      "app",
      "dist",
      "standalone",
      "index.html",
    );
    if (existsSync(candidate)) {
      return dirname(candidate);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/** One resolved source-build invocation for a missing client bundle. */
interface DistBuildSpec {
  command: string;
  args: string[];
  env: Record<string, string>;
  cwd: string;
}

export interface DistBuildOptions {
  /** Anchors the source-checkout walk (defaults to this module's directory). */
  startDir?: string;
  /** Overrides the npm package resolution (tests defeat the installed arm). */
  resolvePackage?: () => string;
}

/** Locate the `clients/<kind>` package of the checkout this CLI runs from. */
function findSourcePackageDir(
  kind: "web" | "app",
  startDir?: string,
): string | null {
  let dir = startDir ?? import.meta.dir;
  for (let depth = 0; depth < 8; depth++) {
    const packageJson = join(dir, "clients", kind, "package.json");
    if (existsSync(packageJson)) {
      return dirname(packageJson);
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return null;
}

/** Spawn the source build with inherited stdio so progress streams through. */
function spawnDistBuild(build: DistBuildSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(build.command, build.args, {
      cwd: build.cwd,
      env: { ...process.env, ...build.env },
      stdio: "inherit",
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`exited with code ${code ?? "signal"}`));
      }
    });
  });
}

/** The source-checkout dist path a kind builds into. */
function sourceDistDir(kind: "web" | "app", sourceDir: string): string {
  return kind === "web"
    ? join(sourceDir, "dist")
    : join(sourceDir, "dist", "standalone");
}

/** HEAD commit of the checkout containing sourceDir (null when git-less). */
function gitHeadSha(sourceDir: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", () => resolve(null));
    child.on("exit", (code) => {
      resolve(code === 0 ? stdout.trim() || null : null);
    });
  });
}

/** Install deps (a pull may have moved the lockfile), then build the bundle. */
async function buildDistFromSource(
  kind: "web" | "app",
  sourceDir: string,
): Promise<void> {
  const recipe =
    kind === "web"
      ? "cd clients/web && VITE_CLOUD_MODE=false bun run build"
      : "cd clients/app && VITE_CLOUD_MODE=false bun run build";
  try {
    await spawnDistBuild({
      command: "bun",
      args: ["run", "build"],
      // Both bundles need the desktop artifact shape: the cloud-served flag
      // strips the account tree the shells mount.
      env: { VITE_CLOUD_MODE: "false" },
      cwd: sourceDir,
    });
  } catch (error) {
    throw new Error(
      `Building the ${kind} bundle from source failed, so the edge cannot ` +
        `start. Run the build by hand to see the full output: ` +
        `\`${recipe}\`. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One kind's resolution arm, feeding the shared stamp decision. */
interface DistArm {
  /** The located dist, or null when there is none. */
  distDir: string | null;
  /** The checkout's `clients/<kind>` package, or null when there is none. */
  sourceDir: string | null;
  /** True when distDir is the source checkout's own build output. */
  sourceBuilt: boolean;
}

async function resolveDistArm(
  kind: "web" | "app",
  options: DistBuildOptions,
): Promise<DistArm> {
  const existing =
    kind === "web" ? findWebDistDir(options) : findAppDistDir(options);
  if (existing) {
    // Only the source-checkout arm's dist can be refreshed here: installed
    // (npm package) and packaged dists are owned by their release.
    const sourceDir = findSourcePackageDir(kind, options.startDir);
    return {
      distDir: existing,
      sourceDir,
      sourceBuilt:
        sourceDir !== null && existing === sourceDistDir(kind, sourceDir),
    };
  }
  return {
    distDir: null,
    sourceDir: findSourcePackageDir(kind, options.startDir),
    sourceBuilt: false,
  };
}

/**
 * Stale means: this arm's dist is the source checkout's own build output and
 * the lockfile's recorded built-sha disagrees with the checkout's HEAD (or is
 * missing — a pre-stamp bootstrap rebuilds once). Installed/packaged arms
 * and git-less trees never read as stale.
 */
function isStale(
  arm: DistArm,
  headSha: string | null,
  recordedSha: string | undefined,
): boolean {
  return arm.sourceBuilt && headSha !== null && recordedSha !== headSha;
}

/**
 * Locate both client bundles the edge serves — the web SPA and the standalone
 * app shell — rebuilding from the source checkout when a dist is missing or
 * the checkout has moved past the recorded build. Both bundles build from the
 * same checkout, so one commit covers both: the built-sha stamp lives on the
 * lockfile's `app` record (the edge's own entry) rather than beside each
 * dist, and is recorded only after every build succeeded so a failed second
 * build can't leave the first bundle's freshness pretending to cover it.
 */
export async function resolveEdgeClientDists(
  options: DistBuildOptions = {},
): Promise<{ webDistDir: string | null; appDistDir: string | null }> {
  const arms = {
    web: await resolveDistArm("web", options),
    app: await resolveDistArm("app", options),
  };
  // clients/web and clients/app are siblings of one checkout — either
  // source-built arm anchors the same HEAD.
  const anchor =
    (arms.web.sourceBuilt ? arms.web.sourceDir : null) ?? arms.app.sourceDir;
  const headSha = anchor ? await gitHeadSha(anchor) : null;
  const recordedSha = readAppBuiltSha();

  let builtAny = false;
  for (const kind of ["web", "app"] as const) {
    const arm = arms[kind];
    const sourceDir = arm.sourceDir;
    // No dist and no source to build from: stays null (the caller reports it).
    if (!sourceDir) continue;
    // An existing dist that isn't stale (installed/packaged arm, git-less
    // tree, or the recorded sha still matching HEAD) serves as-is.
    if (arm.distDir !== null && !isStale(arm, headSha, recordedSha)) continue;
    if (arm.distDir === null) {
      console.log(
        `No built ${kind} bundle found. Building it from the source checkout ` +
          "now (first run only; this can take a minute)...",
      );
    } else {
      console.log(
        `The ${kind} bundle is older than the current checkout` +
          (recordedSha
            ? ` (built at ${recordedSha.slice(0, 7)})`
            : " (no build stamp)") +
          ". Rebuilding it now (this can take a minute)...",
      );
    }
    await buildDistFromSource(kind, sourceDir);
    builtAny = true;
    console.log(`Built the ${kind} bundle.`);
  }

  // Stamp only after every planned build succeeded (a failed build throws
  // above) — a half-stamped state could serve a stale second bundle.
  if (builtAny && headSha) {
    stampAppBuiltSha(headSha);
  }

  return {
    webDistDir: arms.web.distDir ?? (builtAny ? findWebDistDir(options) : null),
    appDistDir: arms.app.distDir ?? (builtAny ? findAppDistDir(options) : null),
  };
}
