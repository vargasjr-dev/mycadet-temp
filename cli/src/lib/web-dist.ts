import { stripVersionPrefix } from "./version-compat.js";
import { z } from "zod";
import { isValidReleaseVersion } from "@mycadet/local-mode";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

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

async function resolveDistDirBuilt(
  kind: "web" | "app",
  options: DistBuildOptions,
): Promise<string | null> {
  const existing =
    kind === "web" ? findWebDistDir(options) : findAppDistDir(options);
  if (existing) {
    return existing;
  }
  const sourceDir = findSourcePackageDir(kind, options.startDir);
  if (!sourceDir) {
    return null;
  }
  console.log(
    `No built ${kind} bundle found. Building it from the source checkout ` +
      "now (first run only; this can take a minute)...",
  );
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
  console.log(`Built the ${kind} bundle.`);
  return kind === "web" ? findWebDistDir(options) : findAppDistDir(options);
}

/**
 * Locate the built web SPA, building it once from the source checkout when
 * missing. Returns null when there is no dist and no source to build from.
 */
export async function resolveWebDistDir(
  options: DistBuildOptions = {},
): Promise<string | null> {
  return resolveDistDirBuilt("web", options);
}

/**
 * Locate the built standalone app shell, building it once from the source
 * checkout when missing. Mirrors {@link resolveWebDistDir}.
 */
export async function resolveAppDistDir(
  options: DistBuildOptions = {},
): Promise<string | null> {
  return resolveDistDirBuilt("app", options);
}

const WebReleaseSchema = z.object({
  version: z
    .string()
    .min(1)
    .refine((value) => value !== "latest" && isValidReleaseVersion(value)),
});

export function readWebReleaseVersion(distDir: string): string | undefined {
  try {
    const payload: unknown = JSON.parse(
      readFileSync(join(distDir, "release.json"), "utf8"),
    );
    const parsed = WebReleaseSchema.safeParse(payload);
    return parsed.success ? stripVersionPrefix(parsed.data.version) : undefined;
  } catch {
    return undefined;
  }
}
