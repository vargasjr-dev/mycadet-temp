import { stripVersionPrefix } from "./version-compat.js";
import { z } from "zod";
import { isValidReleaseVersion } from "@mycadet/local-mode";
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
