#!/usr/bin/env bun
/**
 * The one dev flow.
 *
 * Packs the renderer bundles from the source trees — the `@mycadet/app`
 * standalone build (the main window's app shell) and the `clients/web`
 * build (the auxiliary windows' `/assistant` mount) — prepares the dev
 * Electron.app, then launches `electron-vite dev`. No dev servers run:
 * the renderer loads the same `app://mycadet.ai` origin packaged builds
 * serve, with the protocol handler in `src/main/index.ts` reading the
 * freshly built source-tree dists (see `resolveAppDistRoot` /
 * `resolveWebDistRoot`).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

// Match the native Swift app's default of "local". Everything downstream
// reads it — the electron-vite `define` block, the dev plist patcher, and
// the main process's local-config resolution (which otherwise falls back
// to the persisted CLI default, then "production").
process.env.CADET_ENVIRONMENT ||= "local";

const MACOS_DIR = path.resolve(import.meta.dir, "..");
const CLIENTS_DIR = path.resolve(MACOS_DIR, "..");

const run = (label: string, cwd: string, cmd: [string, ...string[]]): void => {
  console.log(`[dev] ${label}…`);
  const [bin, ...args] = cmd;
  const result = spawnSync(bin, args, { cwd, stdio: "inherit" });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

// Setup owns the workspace install, the Electron binary, and the native
// helper builds — it is idempotent, so kick it off unconditionally. In the
// future, this should hash `bun.lock` to determine whether we even need to.
run("setting up the package", MACOS_DIR, ["bun", "run", "setup"]);

run(
  "building @mycadet/app (the main window's app shell)",
  path.join(CLIENTS_DIR, "app"),
  ["bun", "run", "build"],
);
run(
  "building the web bundle (auxiliary windows' /assistant mount)",
  path.join(CLIENTS_DIR, "web"),
  ["bun", "run", "build"],
);
run("preparing the dev Electron.app", MACOS_DIR, [
  "bun",
  "run",
  "prepare:electron-dev",
]);
run("launching electron-vite dev", MACOS_DIR, ["bunx", "electron-vite", "dev"]);
