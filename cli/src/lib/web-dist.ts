import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

import { readAppBuiltSha, stampAppBuiltSha } from "./assistant-config.js";

const loadModule = createRequire(import.meta.url);

/** Locate the pre-built web SPA for installed, packaged, or source CLIs. */
export function findWebDistDir(): string | null {
  try {
    const packageJson = loadModule.resolve("@mycadet/web/package.json");
    const distDir = join(dirname(packageJson), "dist");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {}

  if (process.platform === "win32") {
    const runtimeDir = dirname(process.execPath);
    const packagedDist = join(runtimeDir, "web-dist");
    if (existsSync(join(packagedDist, "index.html"))) {
      return packagedDist;
    }
  }

  let dir = import.meta.dir;
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

/**
 * Locate the pre-built standalone app shell bundle for installed, packaged,
 * or source CLIs.
 */
function findAppDistDir(): string | null {
  try {
    const packageJson = loadModule.resolve("@mycadet/app/package.json");
    const distDir = join(dirname(packageJson), "dist", "standalone");
    if (existsSync(join(distDir, "index.html"))) {
      return distDir;
    }
  } catch {}

  if (process.platform === "win32") {
    const runtimeDir = dirname(process.execPath);
    const packagedDist = join(runtimeDir, "app-dist");
    if (existsSync(join(packagedDist, "index.html"))) {
      return packagedDist;
    }
  }

  let dir = import.meta.dir;
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
  cwd: string;
}

export interface DistBuildOptions {
  /** Anchors the source-checkout walk (defaults to this module's directory). */
  startDir?: string;
  /** Overrides the npm package resolution (tests defeat the installed arm). */
  resolvePackage?: () => string;
}

/** Locate the `clients/<kind>` package of the checkout this CLI runs from. */
function findSourcePackageDir(kind: "web" | "app"): string | null {
  let dir = import.meta.dir;
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

/** Most recent output kept for a failed build's error, so the tail (where
 * the actual failure lives) survives without unbounded memory. */
const BUILD_OUTPUT_TAIL_BYTES = 20_000;

/**
 * Spawn the source build with its output captured: the CLI's own console
 * stays quiet (the resolve bookends the whole run with one line each), and a
 * failure surfaces the build's tail in the thrown error — where the actual
 * failure lives — alongside the manual recipe.
 */
function spawnDistBuild(build: DistBuildSpec): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(build.command, build.args, {
      cwd: build.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > BUILD_OUTPUT_TAIL_BYTES) {
        output = output.slice(-BUILD_OUTPUT_TAIL_BYTES);
      }
    };
    child.stdout?.on("data", capture);
    child.stderr?.on("data", capture);
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
      } else {
        const tail = output.trim();
        reject(
          new Error(
            tail
              ? `exited with code ${code ?? "signal"}\n${tail}`
              : `exited with code ${code ?? "signal"}`,
          ),
        );
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

/** HEAD commit of the checkout containing sourceDir */
function gitHeadSha(sourceDir: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["rev-parse", "HEAD"], {
      cwd: sourceDir,
      stdio: ["ignore", "pipe", "ignore"],
    });
    let stdout = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.on("error", (error) => reject(error));
    child.on("exit", (code) => {
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(`git exited with error code ${code}`));
    });
  });
}

/** Install deps (a pull may have moved the lockfile), then build the bundle. */
async function buildDistFromSource(
  kind: "web" | "app",
  sourceDir: string,
): Promise<string> {
  try {
    await spawnDistBuild({
      command: "bun",
      args: ["run", "build"],
      cwd: sourceDir,
    });
  } catch (error) {
    throw new Error(
      `App Server failed to start because the ${kind} bundle failed to build:
${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return join(sourceDir, "dist");
}

/** One kind's resolution arm, feeding the shared stamp decision. */
interface DistArm {
  /** The located dist, or null when there is none. */
  distDir: string | null;
  /** The checkout's `clients/<kind>` package, or null when there is none. */
  sourceDir: string;
  /** True when distDir is the source checkout's own build output. */
  sourceBuilt: boolean;
}

async function resolveDistArm(kind: "web" | "app"): Promise<DistArm> {
  const existing = kind === "web" ? findWebDistDir() : findAppDistDir();
  const sourceDir = findSourcePackageDir(kind);
  if (!sourceDir) {
    throw new Error(`Failed to find source for ${kind}`);
  }

  if (existing) {
    // Only the source-checkout arm's dist can be refreshed here: installed
    // (npm package) and packaged dists are owned by their release.
    return {
      distDir: existing,
      sourceDir,
      sourceBuilt:
        sourceDir !== null && existing === sourceDistDir(kind, sourceDir),
    };
  }
  return {
    distDir: null,
    sourceDir,
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
 * Build both client bundles
 */
export async function resolveClientDists(): Promise<{
  webDistDir: string;
  appDistDir: string;
  builtSha: string;
}> {
  const arms = {
    web: await resolveDistArm("web"),
    app: await resolveDistArm("app"),
  };
  const anchor = arms.app.sourceDir;
  const headSha = await gitHeadSha(anchor);
  const recordedSha = readAppBuiltSha();

  async function buildClientDist(kind: "web" | "app"): Promise<string> {
    console.log(`Building ${kind} client...`);

    const arm = arms[kind];
    const sourceDir = arm.sourceDir;
    if (arm.distDir !== null && !isStale(arm, headSha, recordedSha))
      return arm.distDir;

    const dist = await buildDistFromSource(kind, sourceDir);
    console.log(`${kind} client built.`);
    return dist;
  }

  const appDistDir = await buildClientDist("app");
  const webDistDir = await buildClientDist("web");

  stampAppBuiltSha(headSha);
  console.log("Saved", headSha);

  return {
    webDistDir: arms.web.distDir ?? webDistDir,
    appDistDir: arms.app.distDir ?? appDistDir,
    builtSha: headSha,
  };
}
