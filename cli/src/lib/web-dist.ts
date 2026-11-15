import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";

import { readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

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
    const npmPackageJson = join(dir, kind, "package.json");
    if (existsSync(npmPackageJson)) {
      return dirname(npmPackageJson);
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
  return sourceDistDir(kind, sourceDir);
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
  const sourceBuilt =
    sourceDir !== null && existing === sourceDistDir(kind, sourceDir);

  // An installed/packaged dist is owned by its release — served as-is, even
  // when the release ships no source tree (an npm install has no
  // `clients/<kind>` to rebuild from, and no build script to run).
  if (existing && !sourceBuilt) {
    return { distDir: existing, sourceDir: sourceDir ?? "", sourceBuilt };
  }
  if (!sourceDir) {
    throw new Error(`Failed to find source for ${kind}`);
  }

  if (existing) {
    // Only the source-checkout arm's dist can be refreshed here: installed
    // (npm package) and packaged dists are owned by their release.
    return {
      distDir: existing,
      sourceDir,
      sourceBuilt,
    };
  }
  return {
    distDir: null,
    sourceDir,
    sourceBuilt: false,
  };
}

/** The fingerprint stamp file a source-built dist directory carries. */
const DIST_SHA_FILENAME = ".cadet-source-sha";

/** The dist's recorded fingerprint, or undefined when it has none. */
async function readDistSha(distDir: string): Promise<string | undefined> {
  try {
    const raw = await readFile(join(distDir, DIST_SHA_FILENAME), "utf8");
    return raw.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Record the fingerprint a dist was built from, inside the dist itself. */
async function stampDistSha(distDir: string, sourceSha: string): Promise<void> {
  await writeFile(join(distDir, DIST_SHA_FILENAME), `${sourceSha}\n`);
}

/**
 * Stale means: this arm's dist is the source checkout's own build output and
 * the fingerprint recorded inside the dist disagrees with the checkout's
 * current source hash (missing — a pre-stamp bootstrap rebuilds once).
 * Installed/packaged arms never read as stale: their dist is owned by its
 * release and served as-is.
 */
async function isStale(arm: DistArm, sourceSha: string): Promise<boolean> {
  if (!arm.sourceBuilt || arm.distDir === null) return false;
  return (await readDistSha(arm.distDir)) !== sourceSha;
}

const DEFAULT_IGNORES = [
  /(^|\/)(node_modules|\.git|dist|build|coverage|\.next|\.nuxt|\.cache)(\/|$)/i,
  /(^|\/)(__tests__|__mocks__|tests?|e2e|playwright-report|test-results)(\/|$)/i,
  /(^|\/)([^/]+\.)?(test|spec)\.[^/]+$/i,
  /\.(snap|log|tsbuildinfo)$/i,
  /(^|\/)(\.DS_Store|Thumbs\.db)$/i,
];

async function getSourceSha(sourceDir: string): Promise<string> {
  const root = resolve(sourceDir);
  const files: string[] = [];

  async function walk(relativeDir = ""): Promise<void> {
    const entries = await readdir(join(root, relativeDir), {
      withFileTypes: true,
    });

    for (const entry of entries) {
      const relativePath = relativeDir
        ? `${relativeDir}/${entry.name}`
        : entry.name;

      if (
        DEFAULT_IGNORES.some((regex) => {
          regex.lastIndex = 0; // Support regexes with g/y flags.
          return regex.test(relativePath);
        })
      )
        continue;

      if (entry.isDirectory()) await walk(relativePath);
      else if (entry.isFile()) files.push(relativePath);
    }
  }

  await walk();
  files.sort();

  const hash = createHash("sha256");

  // Length-prefix each field to avoid ambiguous concatenation.
  function add(data: Buffer): void {
    hash.update(`${data.length}:`);
    hash.update(data);
  }

  for (const file of files) {
    add(Buffer.from(file, "utf8"));
    add(await readFile(join(root, file)));
  }

  return hash.digest("hex");
}

/**
 * Build both client bundles
 */
export async function resolveClientDists(): Promise<{
  webDistDir: string;
  appDistDir: string;
}> {
  const arms = {
    web: await resolveDistArm("web"),
    app: await resolveDistArm("app"),
  };

  async function buildClientDist(kind: "web" | "app"): Promise<string> {
    console.log(`Building ${kind} client...`);

    const arm = arms[kind];
    // Each arm hashes its own source package and stamps its own dist: an
    // edit to one client's source stale-dates only that client's bundle. A
    // release with no source tree (npm install) skips hashing entirely — its
    // dist is served as-is.
    const sourceSha = arm.sourceDir ? await getSourceSha(arm.sourceDir) : null;
    if (
      arm.distDir !== null &&
      (sourceSha === null || !(await isStale(arm, sourceSha)))
    )
      return arm.distDir;

    const dist = await buildDistFromSource(kind, arm.sourceDir);
    if (sourceSha !== null) {
      await stampDistSha(dist, sourceSha);
      console.log("Stamped", sourceSha);
    }
    console.log(`${kind} client built.`);
    return dist;
  }

  const appDistDir = await buildClientDist("app");
  const webDistDir = await buildClientDist("web");

  return {
    webDistDir: arms.web.distDir ?? webDistDir,
    appDistDir: arms.app.distDir ?? appDistDir,
  };
}
