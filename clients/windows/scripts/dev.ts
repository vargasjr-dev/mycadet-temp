#!/usr/bin/env bun
/**
 * The one dev flow.
 *
 * Packs the renderer bundles from the source trees — the `@mycadet/app`
 * standalone build (the main window's app shell) and the `clients/web`
 * build (the auxiliary windows' `/assistant` mount) — then launches
 * `electron-vite dev`. No dev servers run: the renderer loads the same
 * `app://mycadet.ai` origin packaged builds serve, with the protocol
 * handler reading the freshly built source-tree dists (the shared
 * handler's dev arms in `@mycadet/electron-desktop/app-protocol-forward`).
 */
import { spawnSync } from "node:child_process";
import path from "node:path";

const WINDOWS_DIR = path.resolve(import.meta.dir, "..");
const CLIENTS_DIR = path.resolve(WINDOWS_DIR, "..");

const run = (label: string, cwd: string, cmd: [string, ...string[]]): void => {
  console.log(`[dev] ${label}…`);
  const [bin, ...args] = cmd;
  const result = spawnSync(bin, args, {
    cwd,
    stdio: "inherit",
    env: {
      CADET_ENVIRONMENT: process.env.CADET_ENVIRONMENT || "local",
      ...process.env,
    },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
};

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
run("launching electron-vite dev", WINDOWS_DIR, [
  "bun",
  "run",
  "dev:electron-only",
]);
